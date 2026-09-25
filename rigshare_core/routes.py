"""HTTP API, API-protection middleware and execution-event broadcasting."""

import asyncio
import base64
import html
import ipaddress
import json
import logging
import os
import time
from collections import defaultdict

from aiohttp import web

log = logging.getLogger("ComfyUI-RigShare")

# (method, path) prefixes that need a permission when api_protection is on.
PROTECTED = [
    ("POST", "/prompt", "queue"),
    ("POST", "/queue", "queue"),
    ("POST", "/interrupt", "queue"),
    ("POST", "/free", "queue"),
    ("POST", "/upload/", "edit|queue"),
    ("POST", "/api/jobs", "queue"),
    # Saved workflow files: only admins delete, editors save/overwrite/rename.
    ("DELETE", "/userdata/workflows/", "admin"),
    ("POST", "/userdata/workflows/", "edit"),
]

# ComfyUI Manager: everything needs the "manager" permission except a few
# read-only lookups the ComfyUI frontend makes for everyone (missing nodes...).
MANAGER_PREFIXES = ("/manager/", "/customnode/", "/snapshot/", "/externalmodel/", "/comfyui_manager/")
MANAGER_READONLY = {"/manager/version", "/manager/notice", "/manager/startup_alerts", "/manager/is_legacy_manager_ui",
                    "/customnode/getmappings", "/customnode/installed", "/customnode/import_fail_info",
                    "/customnode/get_node_types_in_workflows", "/customnode/alternatives"}


def is_api_template(template):
    """Templates that need paid API nodes (Comfy.org partner nodes)."""
    return ("API" in (template.get("tags") or []) or template.get("openSource") is False
            or str(template.get("name", "")).startswith("api_"))


def filter_templates(index):
    out = []
    for category in index:
        if not isinstance(category, dict) or not isinstance(category.get("templates"), list):
            out.append(category)
            continue
        kept = [t for t in category["templates"] if not is_api_template(t)]
        if kept:
            out.append({**category, "templates": kept})
    return out


def needs_manager(method, path):
    if path.startswith("/v2/"):
        path = path[3:]
    if not path.startswith(MANAGER_PREFIXES):
        return False
    return not (method in ("GET", "HEAD") and path in MANAGER_READONLY)

# Execution events ComfyUI normally sends only to the prompt's owner.
BROADCAST_EVENTS = {"execution_start", "execution_cached", "executing", "executed", "progress",
                    "progress_state", "execution_success", "execution_error", "execution_interrupted",
                    "progress_text"}


COOKIE = "rigshare_session"
LOGIN_PAGE = os.path.join(os.path.dirname(__file__), "login.html")
ICON_SVG = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web", "rigshare", "assets", "icon.svg")
# Reachable without logging in.
PUBLIC_PATHS = {"/rigshare/login", "/rigshare/api/login", "/rigshare/api/logout", "/rigshare/api/setup",
                "/rigshare/api/status", "/favicon.ico"}


def token_from(request):
    """Session token or API key from header, cookie or ?token= (for websockets)."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return (request.headers.get("X-RigShare-Token") or request.cookies.get(COOKIE)
            or request.query.get("token"))


def setup(server, store, hub):
    routes = web.RouteTableDef()
    failures = defaultdict(list)

    def current_user(request):
        return store.user_for_token(token_from(request))

    def perms_for(request):
        user = current_user(request)
        if user:
            perms = dict(user["perms"])
            if perms.get("admin"):
                perms.update(edit=True, queue=True, manager=True)
            return perms
        guest = request.headers.get("X-RigShare-Guest")
        if guest and store.config.get("allow_guests") and not store.config.get("require_login"):
            return store.guest_perms(guest)
        return {"edit": False, "queue": False, "manager": False, "admin": False}

    def who(request):
        """(kind, key, perms) of the caller, for room access checks."""
        user = current_user(request)
        if user:
            return "user", user["username"], perms_for(request)
        return "guest", request.headers.get("X-RigShare-Guest"), perms_for(request)

    def room_access(request, room):
        return hub.access(room, *who(request))

    def require_admin(request):
        user = current_user(request)
        if not user or not user["perms"].get("admin"):
            raise web.HTTPForbidden(text='{"error": "Admin only"}', content_type="application/json")
        return user

    def error(message, status=400):
        return web.json_response({"error": message}, status=status)

    def set_cookie(request, response, token):
        secure = request.secure or request.headers.get("X-Forwarded-Proto") == "https"
        response.set_cookie(COOKIE, token, max_age=30 * 24 * 3600, path="/", httponly=True,
                            samesite="Lax", secure=secure)

    # ----- websocket + session -------------------------------------------

    @routes.get("/rigshare/ws")
    async def ws_handler(request):
        hub.start(asyncio.get_running_loop())
        if request.headers.get("Upgrade", "").lower() != "websocket":
            log.warning(f"[RigShare] WebSocket request from {request.headers.get('X-Forwarded-For', request.remote)} "
                        "arrived without 'Upgrade: websocket'. If ComfyUI is behind a reverse proxy, enable "
                        "WebSocket support there (Nginx Proxy Manager: 'Websockets Support').")
            return error("WebSocket upgrade headers missing: enable WebSocket support in your reverse proxy", 400)
        return await hub.handle(request)

    @routes.get("/rigshare/api/status")
    async def status(request):
        return web.json_response({"server_name": store.config.get("server_name"),
                                  "require_login": store.config.get("require_login"),
                                  "needs_setup": store.needs_setup,
                                  "allow_guests": store.config.get("allow_guests"),
                                  "online": len(hub.clients)})

    @routes.get("/rigshare/login")
    async def login_page(request):
        with open(LOGIN_PAGE, "r", encoding="utf-8") as f:
            page = f.read().replace("{{SERVER_NAME}}", html.escape(store.config.get("server_name") or "RigShare"))
        page = page.replace("{{NEEDS_SETUP}}", "true" if store.needs_setup else "false")
        try:
            with open(ICON_SVG, "r", encoding="utf-8") as f:
                icon = f.read()
        except OSError:
            icon = ""
        page = page.replace("{{ICON_SVG}}", icon).replace("{{ICON_B64}}", base64.b64encode(icon.encode()).decode())
        return web.Response(text=page, content_type="text/html", headers={"Cache-Control": "no-store"})

    @routes.post("/rigshare/api/login")
    async def login(request):
        ip = request.remote or "?"
        now = time.time()
        failures[ip] = [t for t in failures[ip] if now - t < 60]
        if len(failures[ip]) >= 5:
            return error("Too many attempts, wait a minute", 429)
        body = await request.json()
        user = store.authenticate(str(body.get("username", "")).strip(), str(body.get("password", "")))
        if not user:
            failures[ip].append(now)
            return error("Invalid username or password", 401)
        token = store.create_session(user["username"])
        response = web.json_response({"token": token, "user": store.public_user(user)})
        set_cookie(request, response, token)
        return response

    @routes.post("/rigshare/api/setup")
    async def setup_admin(request):
        if not store.needs_setup:
            return error("Setup is already complete", 409)
        body = await request.json()
        try:
            user = store.setup_admin(str(body.get("username", "")).strip(), str(body.get("password", "")),
                                     body.get("display_name"))
        except PermissionError as e:
            return error(str(e), 409)
        except ValueError as e:
            return error(str(e))
        log.warning(f"[RigShare] First-run setup: admin '{user['username']}' created from {request.remote}")
        token = store.create_session(user["username"])
        response = web.json_response({"token": token, "user": store.public_user(user)})
        set_cookie(request, response, token)
        return response

    @routes.post("/rigshare/api/logout")
    async def logout(request):
        token = token_from(request)
        if token:
            store.revoke_session(token)
        response = web.json_response({"ok": True})
        response.del_cookie(COOKIE, path="/")
        return response

    @routes.get("/rigshare/api/me")
    async def me(request):
        user = current_user(request)
        if not user:
            return error("Not logged in", 401)
        return web.json_response(store.public_user(user))

    @routes.post("/rigshare/api/me")
    async def update_me(request):
        user = current_user(request)
        if not user:
            return error("Not logged in", 401)
        body = await request.json()
        try:
            if body.get("new_password"):
                if not store.authenticate(user["username"], body.get("current_password", "")):
                    return error("Current password is wrong", 403)
                store.update_user(user["username"], password=body["new_password"])
                # Changing password revokes sessions; keep the caller signed in.
                token = store.create_session(user["username"])
            else:
                token = None
            if "display_name" in body:
                store.update_user(user["username"], display_name=str(body["display_name"]))
        except ValueError as e:
            return error(str(e))
        await hub.refresh_identities(user["username"])
        response = web.json_response({"user": store.public_user(store.users[user["username"]]), "token": token})
        if token:
            set_cookie(request, response, token)
        return response

    @routes.get("/rigshare/api/me/keys")
    async def list_keys(request):
        user = current_user(request)
        if not user:
            return error("Not logged in", 401)
        return web.json_response(store.list_api_keys(user["username"]))

    @routes.post("/rigshare/api/me/keys")
    async def create_key(request):
        user = current_user(request)
        if not user:
            return error("Not logged in", 401)
        body = await request.json()
        key, meta = store.create_api_key(user["username"], body.get("name"))
        return web.json_response({"key": key, **meta})

    @routes.delete("/rigshare/api/me/keys/{key_id}")
    async def revoke_key(request):
        user = current_user(request)
        if not user:
            return error("Not logged in", 401)
        if not store.revoke_api_key(user["username"], request.match_info["key_id"]):
            return error("No such key", 404)
        return web.json_response({"ok": True})

    # ----- admin: accounts, guests, config -------------------------------

    @routes.get("/rigshare/api/users")
    async def list_users(request):
        require_admin(request)
        return web.json_response([store.public_user(u) for u in store.users.values()])

    @routes.post("/rigshare/api/users")
    async def create_user(request):
        require_admin(request)
        body = await request.json()
        try:
            user = store.create_user(str(body.get("username", "")).strip(), str(body.get("password", "")),
                                     body.get("display_name"), body.get("perms") or {})
        except ValueError as e:
            return error(str(e))
        return web.json_response(store.public_user(user))

    @routes.patch("/rigshare/api/users/{username}")
    async def update_user(request):
        admin = require_admin(request)
        username = request.match_info["username"]
        body = await request.json()
        try:
            user = store.update_user(username, body.get("display_name"), body.get("perms"), body.get("password") or None)
            if body.get("username"):
                user = store.rename_user(username, str(body["username"]))
        except KeyError:
            return error("No such user", 404)
        except ValueError as e:
            return error(str(e))
        if user["username"] != username:
            hub.rename_member(username, user["username"])
            log.info(f"[RigShare] {admin['username']} renamed @{username} to @{user['username']}")
            await hub.refresh_identities()
        else:
            await hub.refresh_identities(username)
        return web.json_response(store.public_user(user))

    @routes.delete("/rigshare/api/users/{username}")
    async def delete_user(request):
        require_admin(request)
        username = request.match_info["username"]
        try:
            store.delete_user(username)
            hub.forget_member(username)
        except KeyError:
            return error("No such user", 404)
        except ValueError as e:
            return error(str(e))
        await hub.refresh_identities(username)
        return web.json_response({"ok": True})

    @routes.post("/rigshare/api/guests/{guest_id}")
    async def guest_perms(request):
        require_admin(request)
        store.set_guest_perms(request.match_info["guest_id"], await request.json())
        await hub.refresh_identities(request.match_info["guest_id"])
        return web.json_response({"ok": True})

    @routes.get("/rigshare/api/config")
    async def get_config(request):
        require_admin(request)
        return web.json_response(store.config)

    @routes.patch("/rigshare/api/config")
    async def patch_config(request):
        require_admin(request)
        config = store.update_config(await request.json())
        await hub.refresh_identities()
        await hub.broadcast_server()
        return web.json_response(config)

    # ----- rooms + snapshots ---------------------------------------------

    def display(request):
        user = current_user(request)
        if user:
            return user.get("display_name") or user["username"]
        return "guest"

    @routes.get("/rigshare/api/rooms")
    async def list_rooms(request):
        return web.json_response([r for r in hub.room_list() if room_access(request, hub.rooms[r["key"]])])

    @routes.get("/rigshare/api/people")
    async def people(request):
        """Accounts that can be added to a workflow's access list."""
        if not current_user(request):
            return error("Not logged in", 401)
        return web.json_response([{"username": u["username"], "display_name": u.get("display_name") or u["username"],
                                   "admin": bool(u["perms"].get("admin")), "edit": bool(u["perms"].get("edit"))}
                                  for u in store.users.values()])

    @routes.get("/rigshare/api/room/acl")
    async def get_acl(request):
        room = hub.rooms.get(request.query.get("key", ""))
        if not room:
            return error("No such room", 404)
        if not hub.can_manage(room, *who(request)):
            return error("Only the owner or an admin can manage access", 403)
        return web.json_response({"key": room.key, "owner": room.owner, "restricted": bool(room.acl),
                                  "members": (room.acl or {}).get("members") or {}})

    @routes.put("/rigshare/api/room/acl")
    async def put_acl(request):
        body = await request.json()
        room = hub.rooms.get(body.get("key", ""))
        if not room:
            return error("No such room", 404)
        if not hub.can_manage(room, *who(request)):
            return error("Only the owner or an admin can manage access", 403)
        acl = None
        if body.get("restricted"):
            members = {}
            for username, role in (body.get("members") or {}).items():
                if username in store.users and role in ("view", "edit") and username != room.owner:
                    members[username] = role
            acl = {"members": members}
            if room.owner is None:
                # Someone must stay in charge besides admins: the person restricting it.
                kind, key, _ = who(request)
                if kind == "user":
                    room.owner = key
        await hub.set_acl(room, acl)
        log.info(f"[RigShare] {display(request)} set access for {room.name}: "
                 f"{'everyone' if acl is None else ', '.join(f'{u}={r}' for u, r in acl['members'].items()) or 'owner only'}")
        return web.json_response({"ok": True, "owner": room.owner, "restricted": bool(acl)})

    @routes.delete("/rigshare/api/room")
    async def delete_room(request):
        require_admin(request)
        key = request.query.get("key", "")
        room = hub.rooms.get(key)
        if not room:
            return error("No such room", 404)
        if hub.members(key):
            names = ", ".join(c.name for c in hub.members(key))
            return error(f"Still open by {names}", 409)
        hub.remove_room(key, display(request))
        await hub.broadcast_presence()
        return web.json_response({"ok": True})

    @routes.get("/rigshare/api/room")
    async def get_room(request):
        room = hub.rooms.get(request.query.get("key", ""))
        if not room or not room_access(request, room):
            return error("No such room", 404)
        return web.json_response({"key": room.key, "name": room.name, "kind": room.kind,
                                  "version": room.version, "doc": room.doc})

    @routes.get("/rigshare/api/snapshots")
    async def list_snapshots(request):
        key = request.query.get("room")
        if not key:
            require_admin(request)
            return web.json_response(store.list_snapshots())
        room = hub.rooms.get(key)
        if room and not room_access(request, room):
            return error("No such room", 404)
        return web.json_response(store.list_snapshots(key))

    @routes.post("/rigshare/api/snapshots")
    async def create_snapshot(request):
        if not perms_for(request).get("edit"):
            return error("You do not have permission to edit", 403)
        body = await request.json()
        room = hub.rooms.get(body.get("room", ""))
        if not room:
            return error("This tab is not shared")
        if room_access(request, room) != "edit":
            return error("You can view this workflow but not edit it", 403)
        snap = hub.snapshot(room, display(request), body.get("label") or "Manual")
        if not snap:
            return error("Nothing to snapshot yet")
        return web.json_response(snap)

    @routes.get("/rigshare/api/snapshots/{snap_id}")
    async def get_snapshot(request):
        snap = store.get_snapshot(request.match_info["snap_id"])
        if not snap:
            return error("Not found", 404)
        room = hub.rooms.get(snap["meta"].get("room", ""))
        if room and not room_access(request, room):
            return error("Not found", 404)
        return web.json_response(snap)

    @routes.post("/rigshare/api/snapshots/{snap_id}/restore")
    async def restore_snapshot(request):
        if not perms_for(request).get("edit"):
            return error("You do not have permission to edit", 403)
        snap = store.get_snapshot(request.match_info["snap_id"])
        if not snap:
            return error("Not found", 404)
        room = hub.rooms.get(snap["meta"].get("room", ""))
        if not room:
            return error("That workflow is no longer shared; open the snapshot as a copy instead", 404)
        if room_access(request, room) != "edit":
            return error("You can view this workflow but not edit it", 403)
        by = display(request)
        hub.snapshot(room, by, "Before restore")
        await hub.replace_doc(room, snap["doc"], by, f"{by} restored a snapshot of {room.name}")
        return web.json_response({"ok": True})

    server.app.add_routes(routes)

    # ----- API protection middleware -------------------------------------

    def trusted(ip):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        for entry in store.config["api_protection"].get("trusted_ips", []):
            try:
                if addr in ipaddress.ip_network(entry, strict=False):
                    return True
            except ValueError:
                continue
        return False

    @web.middleware
    async def protect(request, handler):
        path = request.path
        if store.config.get("require_login") and path not in PUBLIC_PATHS and not trusted(request.remote or ""):
            if not current_user(request):
                wants_page = request.method == "GET" and (
                    path in ("/", "/index.html") or "text/html" in request.headers.get("Accept", ""))
                if wants_page:
                    raise web.HTTPFound(f"/rigshare/login?next={path}")
                return web.json_response({"error": "RigShare: login required. API clients: send "
                                                   "'Authorization: Bearer <api key>'."}, status=401)
        if path.startswith(("/userdata/workflows/", "/api/userdata/workflows/")) and not trusted(request.remote or ""):
            # A restricted shared workflow's file follows its access list too.
            rel = path.split("/userdata/", 1)[1].split("/move/", 1)[0]
            room = hub.rooms.get("file:" + rel)
            if room and room.acl:
                role = room_access(request, room)
                need = "view" if request.method in ("GET", "HEAD") else "edit"
                if role is None or (need == "edit" and role != "edit"):
                    return web.json_response({"error": "RigShare: this workflow is restricted"}, status=403)
        cfg = store.config.get("api_protection", {})
        if cfg.get("enabled"):
            path = request.path[4:] if request.path.startswith("/api/") else request.path
            if needs_manager(request.method, path) and not trusted(request.remote or ""):
                if not perms_for(request).get("manager"):
                    return web.json_response({"error": "RigShare: you need the 'manager' permission to use ComfyUI Manager"},
                                             status=403)
            for method, prefix, need in PROTECTED:
                if (not method or request.method == method) and (path == prefix or path.startswith(prefix)):
                    if trusted(request.remote or ""):
                        break
                    perms = perms_for(request)
                    if not any(perms.get(p) for p in need.split("|")):
                        return web.json_response(
                            {"error": {"type": "rigshare_forbidden",
                                       "message": f"RigShare: you need '{need.replace('|', ' or ')}' permission",
                                       "details": "", "extra_info": {}}, "node_errors": {}},
                            status=403)
                    break
        response = await handler(request)
        # Hide API templates: rewrite the template index ComfyUI serves.
        if (store.config.get("hide_api_templates") and request.method == "GET"
                and path.startswith("/templates/index") and path.endswith(".json")):
            try:
                file_path = getattr(response, "_path", None)
                if file_path:
                    with open(file_path, "r", encoding="utf-8") as f:
                        index = json.load(f)
                else:
                    index = json.loads(response.body)
                if isinstance(index, list):
                    response = web.json_response(filter_templates(index), headers={"Cache-Control": "no-store"})
            except Exception as e:
                log.debug(f"[RigShare] could not filter templates: {e}")
        # Sliding session: renew the cookie JWT when it is getting old.
        cookie = request.cookies.get(COOKIE)
        if cookie and isinstance(response, web.Response) and not response.prepared:
            fresh = store.refresh_token(cookie)
            if fresh:
                set_cookie(request, response, fresh)
        return response

    try:
        server.app.middlewares.append(protect)
    except RuntimeError as e:
        log.error(f"[ComfyUI-RigShare] Could not install API protection middleware: {e}")

    # ----- relay execution events to everyone ----------------------------

    original_send_sync = server.send_sync

    def send_sync(event, data, sid=None):
        if sid is not None and store.config.get("broadcast_execution", True):
            if event in BROADCAST_EVENTS or isinstance(event, int):
                sid = None
        return original_send_sync(event, data, sid)

    server.send_sync = send_sync
