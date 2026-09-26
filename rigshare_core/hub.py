"""Real-time hub: presence, chat, cursors, server stats and shared rooms.

Sharing follows folders: every saved workflow outside a private folder is a
*room* (``file:<path>``) while it is open. The server holds the authoritative
document of each room and relays patches between the browsers that currently
have it on screen. Unsaved tabs and private files never get a room.

Clients identify once (session token or guest id); from then on the server
stamps relayed messages with the sender identity and checks permissions.
"""

import asyncio
import hashlib
import json
import logging
import secrets
import time

from aiohttp import web, WSMsgType

from .chatlog import ChatLog
from .graphdoc import apply_patch, remap_conflicts
from .stats import collect_stats
from .workspace import Workspace, has_app

log = logging.getLogger("ComfyUI-RigShare")

COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#38bdf8",
          "#818cf8", "#c084fc", "#f472b6", "#a3e635", "#fbbf24", "#22d3ee"]
MAX_MESSAGE = 16 * 1024 * 1024
CHAT_PAGE = 50


def clean_text(text, limit):
    text = "".join(ch for ch in str(text or "") if ch == "\n" or ch >= " ")
    return text.strip()[:limit]


def is_live_key(key):
    """Only saved workflows outside a private folder can be live."""
    if not isinstance(key, str) or not key.startswith("file:workflows/"):
        return False
    return Workspace.area(key[len("file:workflows/"):])[0] not in ("private", "users-root")


class Room:
    def __init__(self, key, name, kind, doc, version=0, updated=None):
        self.key = key
        self.name = name
        self.kind = kind
        self.doc = doc
        self.version = version
        self.updated = updated or time.time()
        self.dirty = False
        self.snapshot_dirty = False
        self.last_snapshot = time.time()
        self.last_editor = None

    def to_file(self):
        return {"key": self.key, "name": self.name, "kind": self.kind, "doc": self.doc,
                "version": self.version, "updated": self.updated}


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.id = secrets.token_hex(6)
        self.kind = None  # "user" | "guest"
        self.key = None   # username or guest id
        self.token = None
        self.guest_id = None
        self.guest_name = None
        self.name = "Guest"
        self.color = COLORS[0]
        self.perms = {"edit": False, "queue": False, "manager": False, "admin": False}
        self.joined = time.time()
        self.idle = False
        self.room = None
        self.view = "graph"  # "graph" (node editor) or "app" (ComfyUI's App view)

    def public(self):
        return {"id": self.id, "kind": self.kind, "key": self.key if self.kind == "user" else None,
                "guest_id": self.key if self.kind == "guest" else None,
                "name": self.name, "color": self.color, "perms": self.perms,
                "joined": int(self.joined), "idle": self.idle, "room": self.room, "view": self.view}


class Hub:
    def __init__(self, store, server=None):
        self.store = store
        self.server = server
        self.clients = {}
        self.rooms = {}
        for data in store.load_rooms():
            if not is_live_key(data.get("key")):
                # Unsaved-tab rooms and private files from older versions.
                store.delete_room(data.get("key", ""))
                continue
            try:
                self.rooms[data["key"]] = Room(data["key"], data.get("name") or data["key"], data.get("kind", "file"),
                                               data.get("doc"), data.get("version", 0), data.get("updated"))
            except (KeyError, TypeError):
                continue
        self.chat = ChatLog(store.folder, keep=int(store.config.get("chat_keep") or 0),
                            legacy=store._read("chat.json", None))
        self.stats = None
        self._task = None
        self.workspace = None  # set by __init__ (folders, private spaces)

    # ----- lifecycle ----------------------------------------------------

    def start(self, loop):
        if not self._task:
            self._task = loop.create_task(self._housekeeping())
            loop.create_task(self._stats_loop())

    async def _housekeeping(self):
        while True:
            await asyncio.sleep(2)
            try:
                now = time.time()
                interval = int(self.store.config.get("snapshot_interval_sec", 300))
                for room in list(self.rooms.values()):
                    if room.dirty:
                        self.store.save_room(room.to_file())
                        room.dirty = False
                    if room.snapshot_dirty and interval > 0 and now - room.last_snapshot >= interval:
                        self.snapshot(room, room.last_editor or "auto")
                expiry = float(self.store.config.get("room_expiry_days", 14)) * 86400
                for room in list(self.rooms.values()):
                    if expiry > 0 and now - room.updated > expiry and not self.members(room.key):
                        self.rooms.pop(room.key, None)
                        self.store.delete_room(room.key)
            except Exception as e:
                log.error(f"[RigShare] housekeeping error: {e}")

    async def _stats_loop(self):
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(2)
            if not self.clients:
                continue
            try:
                self.stats = await loop.run_in_executor(None, collect_stats, self.server)
                await self.broadcast({"type": "stats", "stats": self.stats})
            except Exception as e:
                log.debug(f"[RigShare] stats error: {e}")

    def snapshot(self, room, author, label=None):
        if room.doc is None:
            return None
        room.last_snapshot = time.time()
        room.snapshot_dirty = False
        return self.store.add_snapshot(room.doc, author, room.key, room.name, label)

    # ----- identity -----------------------------------------------------

    def _color_for(self, key):
        return COLORS[int(hashlib.md5(key.encode()).hexdigest(), 16) % len(COLORS)]

    def identify(self, client, token, guest_id, name):
        client.guest_id = clean_text(guest_id, 64) or client.guest_id or secrets.token_hex(8)
        client.guest_name = clean_text(name, 24) or client.guest_name
        user = self.store.user_for_token(token)
        if not user and getattr(client, "cookie_token", None):
            token = client.cookie_token
            user = self.store.user_for_token(token)
        if user:
            client.kind, client.key, client.token = "user", user["username"], token
            client.name = user.get("display_name") or user["username"]
            client.perms = dict(user["perms"])
            if client.perms.get("admin"):
                client.perms.update(edit=True, queue=True, manager=True)
        elif self.store.config.get("allow_guests", True) and not self.store.config.get("require_login"):
            client.kind, client.key, client.token = "guest", client.guest_id, None
            client.name = client.guest_name or f"Guest-{client.key[:4]}"
            client.perms = self.store.guest_perms(client.key)
        else:
            return False
        client.color = self._color_for(f"{client.kind}:{client.key}")
        return True

    def refresh_identities(self, key=None):
        """Re-read accounts/guest perms after an admin change and notify clients."""
        return asyncio.gather(*[self._refresh(c) for c in list(self.clients.values())
                                if key is None or c.key == key])

    async def _refresh(self, client):
        before = (client.kind, client.name, json.dumps(client.perms, sort_keys=True))
        if client.kind == "user" and not self.store.user_for_token(client.token):
            await self.send(client, {"type": "logged_out"})
        if not self.identify(client, client.token, None, None):
            await self.send(client, {"type": "denied", "reason": "Please log in.", "login": True})
            await client.ws.close()
            return
        after = (client.kind, client.name, json.dumps(client.perms, sort_keys=True))
        if before != after:
            await self.send(client, {"type": "self", "self": client.public()})
            room = self.rooms.get(client.room) if client.room else None
            if room and self.client_access(room, client) is None:
                client.room = None
                await self.send(client, {"type": "room_denied", "room": room.key, "name": room.name})
            elif room:
                await self.send(client, {"type": "room_info", "room": room.key, **self.room_info(room, client)})
            await self.broadcast_presence()

    # ----- messaging ----------------------------------------------------

    async def send(self, client, message):
        try:
            await client.ws.send_str(json.dumps(message))
        except Exception as e:
            log.debug(f"[RigShare] send to {client.id} failed: {e}")

    async def broadcast(self, message, exclude=None, room=None):
        data = json.dumps(message)
        for client in list(self.clients.values()):
            if client is exclude or client.kind is None:
                continue
            if room is not None and client.room != room:
                continue
            try:
                await client.ws.send_str(data)
            except Exception:
                pass

    async def drop_rooms(self, prefix, by, label="Before delete"):
        """The file (or folder) is gone or went private: forget its rooms. Snapshots are kept."""
        dropped = False
        for key in list(self.rooms):
            if key != prefix and not key.startswith(prefix + "/"):
                continue
            room = self.rooms.pop(key)
            self.store.delete_room(key)
            if room.doc is not None and room.version > 0:
                self.snapshot(room, by, label)
            for client in self.members(key):
                client.room = None
                await self.send(client, {"type": "room_closed", "room": key, "name": room.name})
            dropped = True
        if dropped:
            await self.broadcast_presence()

    def members(self, key):
        return [c for c in self.clients.values() if c.kind and c.room == key]

    # ----- access ---------------------------------------------------------

    def access(self, room, kind, key, perms):
        """What someone may do in a room: None (no access), "view" or "edit".

        Access follows the workflow's folder (restricted shared folders), within
        the person's account permissions.
        """
        if self.workspace and room.key.startswith("file:workflows/"):
            return self.workspace.role(room.key[len("file:workflows/"):], kind, key, perms)
        return "edit" if (perms.get("edit") or perms.get("admin")) else "view"

    def client_access(self, room, client):
        return self.access(room, client.kind, client.key, client.perms)

    def folder_of(self, room):
        """The shared folder ("shared/<name>") a room's file lives in, or None."""
        area, folder = Workspace.area(room.key[len("file:workflows/"):])
        return folder if area == "shared" else None

    def folder_restricted(self, folder):
        return bool(folder and self.workspace and (self.workspace.folders.get(folder) or {}).get("acl"))

    def room_info(self, room, client):
        folder = self.folder_of(room)
        manage = bool(folder and self.workspace and self.workspace.can_manage(folder, client.kind, client.key, client.perms))
        return {"role": self.client_access(room, client), "folder": folder,
                "restricted": self.folder_restricted(folder), "manage": manage}

    def room_list(self, client=None):
        """Live workflows: the rooms someone has open right now."""
        out = []
        for room in self.rooms.values():
            if client is not None and self.client_access(room, client) is None:
                continue
            members = [c.id for c in self.members(room.key)]
            if members:
                out.append({"key": room.key, "name": room.name, "kind": room.kind, "version": room.version,
                            "updated": int(room.updated), "members": members,
                            "nodes": len((room.doc or {}).get("nodes") or []),
                            "restricted": self.folder_restricted(self.folder_of(room)),
                            "app": room.key.endswith(".app.json") or has_app(room.doc)})
        out.sort(key=lambda r: (-len(r["members"]), -r["updated"]))
        return out

    def users_for(self, viewer):
        """Presence as ``viewer`` may see it: rooms they cannot access are hidden."""
        out = []
        for c in self.clients.values():
            if not c.kind:
                continue
            info = c.public()
            room = self.rooms.get(c.room) if c.room else None
            if room and self.client_access(room, viewer) is None:
                info["room"] = None
            out.append(info)
        return out

    async def broadcast_presence(self):
        for client in list(self.clients.values()):
            if client.kind:
                await self.send(client, {"type": "presence", "users": self.users_for(client),
                                         "rooms": self.room_list(client)})

    def rekey_rooms(self, old_prefix, new_prefix):
        """Follow files that moved: rooms of ``file:<old_prefix>...`` get the new path."""
        moved = []
        for key in list(self.rooms):
            if key == old_prefix or key.startswith(old_prefix + "/"):
                room = self.rooms.pop(key)
                self.store.delete_room(key)
                for client in self.members(key):
                    client.room = None
                room.key = new_prefix + key[len(old_prefix):]
                if not is_live_key(room.key):
                    continue  # moved into a private folder: no longer live
                room.name = room.key.rsplit("/", 1)[-1].removesuffix(".json").removesuffix(".app")
                room.dirty = True
                self.rooms[room.key] = room
                moved.append(room.key)
        return moved

    def path_access(self, path, client, key=None):
        """May ``client`` open the workflows path (file or folder)?"""
        key = client.key if key is None else key
        rel = Workspace.workflows_rel(path)
        if rel is None or not self.workspace:
            return True
        return self.workspace.role(rel, client.kind, key, client.perms) is not None

    def who_sees(self, path):
        """Connected clients that may open ``path``; call before moving it."""
        return [c for c in self.clients.values() if c.kind and self.path_access(path, c)]

    async def path_moved(self, old, new, renamed=None, seen_by=None):
        """A workflow file or folder moved (userdata paths, e.g. ``workflows/a.json``).

        Its rooms follow it, and everyone who could see the old location
        (``seen_by``, taken before the move changed any folder settings) is told
        where it went so their open tabs follow too, or that it went somewhere
        they cannot open. ``renamed`` maps usernames changed by the same action.
        """
        notes = []
        for client in self.who_sees(old) if seen_by is None else seen_by:
            key = (renamed or {}).get(client.key, client.key) if client.kind == "user" else client.key
            notes.append((client, self.path_access(new, client, key=key)))
        self.rekey_rooms("file:" + old, "file:" + new)
        for client, follows in notes:
            await self.send(client, {"type": "path_moved", "from": old, "to": new} if follows
                            else {"type": "path_closed", "from": old})
        await self.broadcast_presence()

    async def refresh_rooms_access(self):
        """Folder access changed: remove people from rooms they can no longer open."""
        for client in list(self.clients.values()):
            room = self.rooms.get(client.room) if client.room else None
            if not room:
                continue
            role = self.client_access(room, client)
            if role is None:
                client.room = None
                await self.broadcast({"type": "leave", "id": client.id}, room=room.key)
                await self.send(client, {"type": "room_denied", "room": room.key, "name": room.name})
            else:
                await self.send(client, {"type": "room_info", "room": room.key, **self.room_info(room, client)})
        await self.broadcast_presence()

    def server_info(self):
        cfg = self.store.config
        return {"name": cfg.get("server_name"), "allow_guests": cfg.get("allow_guests"),
                "hide_comfy_account": bool(cfg.get("hide_comfy_account")),
                "hide_comfy_file_tabs": bool(cfg.get("hide_comfy_file_tabs", True)),
                "hide_api_templates": bool(cfg.get("hide_api_templates"))}

    async def broadcast_server(self):
        await self.broadcast({"type": "server", "server": self.server_info()})

    async def clear_chat(self, by):
        """An admin wiped the chat: everyone's history empties, then a notice says who."""
        self.chat.clear()
        await self.broadcast({"type": "chat_cleared"})
        await self.system_chat(f"{by} cleared the chat history")

    async def system_chat(self, text):
        msg = {"id": secrets.token_hex(6), "system": True, "text": text, "ts": int(time.time() * 1000)}
        msg = self.chat.append(msg)
        await self.broadcast({"type": "chat", "message": msg})

    # ----- websocket ----------------------------------------------------

    async def handle(self, request):
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=MAX_MESSAGE)
        await ws.prepare(request)
        client = Client(ws)
        auth = request.headers.get("Authorization", "")
        client.cookie_token = request.cookies.get("rigshare_session") or (auth[7:].strip() if auth.startswith("Bearer ") else None)
        self.clients[client.id] = client
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if client.kind is None and data.get("type") != "hello":
                    continue
                try:
                    await self.dispatch(client, data)
                except Exception as e:
                    log.exception(f"[RigShare] error handling {data.get('type')}: {e}")
        except Exception as e:
            log.error(f"[RigShare] websocket error: {e}")
        finally:
            self.clients.pop(client.id, None)
            if client.kind:
                await self.broadcast({"type": "leave", "id": client.id})
                await self.broadcast_presence()
                if not any(c.key == client.key for c in self.clients.values()):
                    await self.system_chat(f"{client.name} left")
        return ws

    async def dispatch(self, client, data):
        kind = data.get("type")

        if kind == "hello":
            if not self.identify(client, data.get("token"), data.get("guest_id"), data.get("name")):
                await self.send(client, {"type": "denied", "reason": "Please log in.", "login": True})
                return
            first = not any(c.key == client.key and c is not client for c in self.clients.values())
            if self.workspace and client.kind == "user":
                try:
                    self.workspace.ensure_private(client.key)
                except OSError:
                    pass
            await self.send(client, {
                "type": "welcome",
                "self": client.public(),
                "users": self.users_for(client),
                "rooms": self.room_list(client),
                **dict(zip(("chat", "chat_more"), self.chat.page(limit=CHAT_PAGE))),
                "stats": self.stats,
                "server": self.server_info(),
            })
            await self.broadcast_presence()
            if first:
                await self.system_chat(f"{client.name} joined")

        elif kind == "join":
            key = clean_text(data.get("room"), 400)
            previous = client.room
            if not key:
                client.room = None
            elif not is_live_key(key):
                client.room = None
                await self.send(client, {"type": "room_denied", "room": key, "name": clean_text(data.get("name"), 120) or key,
                                         "reason": "Only saved workflows outside a private folder are live."})
            else:
                room = self.rooms.get(key)
                created = False
                if room is None:
                    doc = data.get("doc") if isinstance(data.get("doc"), dict) else {}
                    room = Room(key, clean_text(data.get("name"), 120) or key, "file", doc)
                    room.dirty = True
                    self.rooms[key] = room
                    created = True
                if self.client_access(room, client) is None:
                    client.room = None
                    await self.send(client, {"type": "room_denied", "room": key, "name": room.name})
                else:
                    client.room = key
                    room.updated = time.time()
                    await self.send(client, {"type": "room", "room": key, "name": room.name, "version": room.version,
                                             "doc": None if created else room.doc, "created": created,
                                             **self.room_info(room, client)})
            if previous != client.room:
                if previous:
                    await self.broadcast({"type": "leave", "id": client.id}, room=previous)
                await self.broadcast_presence()

        elif kind == "cursor":
            if not client.room:
                return
            await self.broadcast({
                "type": "cursor", "id": client.id, "room": client.room,
                "x": data.get("x"), "y": data.get("y"),
                "graph": data.get("graph"), "sel": (data.get("sel") or [])[:200],
                "vp": data.get("vp"),
            }, exclude=client, room=client.room)

        elif kind == "chat":
            text = clean_text(data.get("text"), 1000)
            if not text:
                return
            msg = {"id": secrets.token_hex(6), "from": client.id, "name": client.name,
                   "color": client.color, "text": text, "ts": int(time.time() * 1000)}
            msg = self.chat.append(msg)
            await self.broadcast({"type": "chat", "message": msg})

        elif kind == "rename":
            name = clean_text(data.get("name"), 24)
            if not name or client.kind != "guest" or name == client.name:
                return
            old, client.name, client.guest_name = client.name, name, name
            await self.send(client, {"type": "self", "self": client.public()})
            await self.broadcast_presence()
            await self.system_chat(f"{old} is now known as {name}")

        elif kind == "view":
            view = data.get("view")
            if view in ("graph", "app") and view != client.view:
                client.view = view
                await self.broadcast_presence()

        elif kind == "idle":
            client.idle = bool(data.get("idle"))
            await self.broadcast_presence()

        elif kind == "graph":
            key = data.get("room")
            patch = data.get("patch")
            room = self.rooms.get(key)
            if not isinstance(patch, dict) or room is None or client.room != key:
                return
            if self.client_access(room, client) != "edit":
                await self.send(client, {"type": "doc", "room": key, "doc": room.doc, "version": room.version,
                                         "reason": "You can view this workflow but not edit it."})
                return
            # Someone else may have taken the ids this client just used.
            patch, remapped = remap_conflicts(room.doc, patch)
            room.doc = apply_patch(room.doc, patch)
            room.version += 1
            room.updated = time.time()
            room.last_editor = client.name
            room.dirty = room.snapshot_dirty = True
            await self.broadcast({"type": "graph", "room": key, "from": client.id, "name": client.name,
                                  "version": room.version, "patch": patch}, exclude=client, room=key)
            if remapped:
                # The sender's copy still has the clashing ids: resync it quietly.
                await self.send(client, {"type": "doc", "room": key, "doc": room.doc, "version": room.version})
            await self.send(client, {"type": "ack", "room": key, "version": room.version})

        elif kind == "request_doc":
            room = self.rooms.get(data.get("room"))
            if room and client.room == room.key:
                await self.send(client, {"type": "doc", "room": room.key, "doc": room.doc, "version": room.version})

    async def replace_doc(self, room, doc, by, reason):
        room.doc = doc
        room.version += 1
        room.updated = time.time()
        room.dirty = room.snapshot_dirty = True
        await self.broadcast({"type": "doc", "room": room.key, "doc": doc, "version": room.version,
                              "reason": reason, "by": by}, room=room.key)
