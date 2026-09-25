"""Real-time hub: presence, chat, cursors, server stats and shared rooms.

Every workflow tab that is shared maps to a *room* (a saved workflow file is
the room ``file:<path>``; a shared unsaved tab is ``tmp:<id>``). The server
holds the authoritative document of each room and relays patches between the
browsers that currently have that room on screen.

Clients identify once (session token or guest id); from then on the server
stamps relayed messages with the sender identity and checks permissions.
"""

import asyncio
import hashlib
import json
import logging
import secrets
import time
from collections import deque

from aiohttp import web, WSMsgType

from .graphdoc import apply_patch, remap_conflicts
from .stats import collect_stats

log = logging.getLogger("ComfyUI-RigShare")

COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#38bdf8",
          "#818cf8", "#c084fc", "#f472b6", "#a3e635", "#fbbf24", "#22d3ee"]
MAX_MESSAGE = 16 * 1024 * 1024


def clean_text(text, limit):
    text = "".join(ch for ch in str(text or "") if ch == "\n" or ch >= " ")
    return text.strip()[:limit]


ROLES = ("view", "edit")


class Room:
    def __init__(self, key, name, kind, doc, version=0, updated=None, owner=None, acl=None):
        self.key = key
        # Username of whoever first shared it; may manage its access list.
        self.owner = owner
        # None: everyone with an account can open it. Otherwise
        # {"members": {username: "view" | "edit"}}: only those people (plus
        # the owner and admins). A room role can only narrow account permissions.
        self.acl = acl
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
                "version": self.version, "updated": self.updated, "owner": self.owner, "acl": self.acl}


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

    def public(self):
        return {"id": self.id, "kind": self.kind, "key": self.key if self.kind == "user" else None,
                "guest_id": self.key if self.kind == "guest" else None,
                "name": self.name, "color": self.color, "perms": self.perms,
                "joined": int(self.joined), "idle": self.idle, "room": self.room}


class Hub:
    def __init__(self, store, server=None):
        self.store = store
        self.server = server
        self.clients = {}
        self.rooms = {}
        for data in store.load_rooms():
            try:
                self.rooms[data["key"]] = Room(data["key"], data.get("name") or data["key"], data.get("kind", "file"),
                                               data.get("doc"), data.get("version", 0), data.get("updated"),
                                               data.get("owner"), data.get("acl"))
            except (KeyError, TypeError):
                continue
        self.chat = deque(maxlen=int(store.config.get("chat_history", 200)))
        for msg in store._read("chat.json", []):
            self.chat.append(msg)
        self.chat_dirty = False
        self.stats = None
        self._task = None

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
                if self.chat_dirty:
                    self.store._write("chat.json", list(self.chat))
                    self.chat_dirty = False
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

    def drop_if_unused(self, key):
        """Forget an unsaved-tab room nobody edited once its last member leaves."""
        room = self.rooms.get(key)
        if room and room.kind == "tmp" and room.version == 0 and not self.members(key):
            self.rooms.pop(key, None)
            self.store.delete_room(key)

    def remove_room(self, key, by):
        """Stop sharing a workflow nobody has open. Snapshots are kept."""
        room = self.rooms.get(key)
        if room is None or self.members(key):
            return False
        if room.doc is not None and room.version > 0:
            self.snapshot(room, by, "Before unshare")
        self.rooms.pop(key, None)
        self.store.delete_room(key)
        return True

    def members(self, key):
        return [c for c in self.clients.values() if c.kind and c.room == key]

    # ----- access lists -------------------------------------------------

    @staticmethod
    def access(room, kind, key, perms):
        """What someone may do in a room: None (no access), "view" or "edit"."""
        can_edit = bool(perms.get("edit") or perms.get("admin"))
        if perms.get("admin") or not room.acl:
            return "edit" if can_edit else "view"
        if kind == "user" and key == room.owner:
            return "edit" if can_edit else "view"
        role = (room.acl.get("members") or {}).get(key) if kind == "user" else None
        if role not in ROLES:
            return None
        return "edit" if role == "edit" and can_edit else "view"

    @staticmethod
    def can_manage(room, kind, key, perms):
        return bool(perms.get("admin")) or (kind == "user" and key is not None and key == room.owner)

    def client_access(self, room, client):
        return self.access(room, client.kind, client.key, client.perms)

    def room_info(self, room, client):
        return {"role": self.client_access(room, client),
                "manage": self.can_manage(room, client.kind, client.key, client.perms),
                "restricted": bool(room.acl), "owner": room.owner}

    def room_list(self, client=None):
        cutoff = time.time() - 7 * 86400
        out = []
        for room in self.rooms.values():
            if client is not None and self.client_access(room, client) is None:
                continue
            members = [c.id for c in self.members(room.key)]
            if members or room.updated > cutoff:
                out.append({"key": room.key, "name": room.name, "kind": room.kind, "version": room.version,
                            "updated": int(room.updated), "members": members,
                            "nodes": len((room.doc or {}).get("nodes") or []),
                            "restricted": bool(room.acl), "owner": room.owner})
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

    async def set_acl(self, room, acl):
        """Apply a new access list and remove people who lost access."""
        room.acl = acl
        room.dirty = True
        for client in self.members(room.key):
            role = self.client_access(room, client)
            if role is None:
                client.room = None
                await self.broadcast({"type": "leave", "id": client.id}, room=room.key)
                await self.send(client, {"type": "room_denied", "room": room.key, "name": room.name})
            else:
                await self.send(client, {"type": "room_info", "room": room.key, **self.room_info(room, client)})
        await self.broadcast_presence()

    def rename_member(self, old, new):
        for room in self.rooms.values():
            changed = False
            if room.owner == old:
                room.owner, changed = new, True
            members = (room.acl or {}).get("members") or {}
            if old in members:
                members[new] = members.pop(old)
                changed = True
            room.dirty = room.dirty or changed

    def forget_member(self, username):
        for room in self.rooms.values():
            members = (room.acl or {}).get("members") or {}
            if members.pop(username, None) is not None:
                room.dirty = True

    def server_info(self):
        cfg = self.store.config
        return {"name": cfg.get("server_name"), "allow_guests": cfg.get("allow_guests"),
                "hide_comfy_account": bool(cfg.get("hide_comfy_account")),
                "hide_api_templates": bool(cfg.get("hide_api_templates"))}

    async def broadcast_server(self):
        await self.broadcast({"type": "server", "server": self.server_info()})

    async def system_chat(self, text):
        msg = {"id": secrets.token_hex(6), "system": True, "text": text, "ts": int(time.time() * 1000)}
        self.chat.append(msg)
        self.chat_dirty = True
        await self.broadcast({"type": "chat", "message": msg})

    # ----- websocket ----------------------------------------------------

    async def handle(self, request):
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=MAX_MESSAGE)
        await ws.prepare(request)
        client = Client(ws)
        client.cookie_token = request.cookies.get("rigshare_session")
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
            if client.room:
                self.drop_if_unused(client.room)
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
            await self.send(client, {
                "type": "welcome",
                "self": client.public(),
                "users": self.users_for(client),
                "rooms": self.room_list(client),
                "chat": list(self.chat),
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
            else:
                room = self.rooms.get(key)
                created = False
                if room is None:
                    doc = data.get("doc") if isinstance(data.get("doc"), dict) else {}
                    room_kind = "file" if key.startswith("file:") else "tmp"
                    room = Room(key, clean_text(data.get("name"), 120) or key, room_kind, doc,
                                owner=client.key if client.kind == "user" else None)
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
                    self.drop_if_unused(previous)
                await self.broadcast_presence()

        elif kind == "unshare":
            # Leave the room; an admin also removes it from the shared list if nobody else is in it.
            key = data.get("room")
            room = self.rooms.get(key)
            if room is None:
                return
            if client.room == key:
                client.room = None
                await self.broadcast({"type": "leave", "id": client.id}, room=key)
            others = self.members(key)
            # Only admins remove a workflow from the shared list; others just leave.
            removed = not others and client.perms.get("admin") and self.remove_room(key, client.name)
            await self.send(client, {"type": "unshared", "room": key, "name": room.name, "removed": removed,
                                     "others": [c.name for c in others]})
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
            self.chat.append(msg)
            self.chat_dirty = True
            await self.broadcast({"type": "chat", "message": msg})

        elif kind == "rename":
            name = clean_text(data.get("name"), 24)
            if not name or client.kind != "guest" or name == client.name:
                return
            old, client.name, client.guest_name = client.name, name, name
            await self.send(client, {"type": "self", "self": client.public()})
            await self.broadcast_presence()
            await self.system_chat(f"{old} is now known as {name}")

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
