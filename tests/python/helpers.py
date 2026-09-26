"""Test helpers: a RigShare server without ComfyUI.

``rig_server()`` starts a real aiohttp app with RigShare's routes, middleware
and hub, plus a small stand-in for ComfyUI's /userdata API backed by a temp
folder, so HTTP and websocket behaviour can be tested end to end.
"""

import contextlib
import glob
import json
import os
import sys
import tempfile
from urllib.parse import quote, unquote

from aiohttp import web, ClientSession, CookieJar
from aiohttp.test_utils import TestServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from rigshare_core.store import Store  # noqa: E402
from rigshare_core.hub import Hub  # noqa: E402
from rigshare_core.workspace import Workspace  # noqa: E402
from rigshare_core import routes  # noqa: E402

PASSWORD = "longpassword"


def enc(path):
    """Encode a userdata path the way ComfyUI's frontend does."""
    return quote(path, safe="")


class FakeQueue:
    """ComfyUI's PromptQueue, as far as RigShare reads it."""

    def __init__(self):
        self.running, self.pending, self.number = [], [], 0

    def get_current_queue_volatile(self):
        return list(self.running), list(self.pending)


class FakePromptServer:
    def __init__(self):
        self.app = web.Application()
        self.sent = []
        self.prompt_queue = FakeQueue()

    def send_sync(self, event, data, sid=None):
        self.sent.append((event, sid))


def comfy_routes(user_root, queue=None):
    """Minimal ComfyUI /userdata routes for the single default user, plus the queue."""

    def resolve(name):
        if "%" in name:
            name = unquote(name)
        path = os.path.abspath(os.path.join(user_root, name))
        return path if os.path.commonpath((user_root, path)) == user_root else None

    async def listing(request):
        base = resolve(request.query["dir"])
        out = []
        for full in glob.glob(os.path.join(glob.escape(base), "**", "*"), recursive=True):
            if os.path.isfile(full):
                out.append({"path": os.path.relpath(full, base).replace(os.sep, "/"), "size": 1, "modified": 1})
        return web.json_response(out)

    async def get(request):
        path = resolve(request.match_info["file"])
        return web.FileResponse(path) if path and os.path.exists(path) else web.Response(status=404)

    async def post(request):
        path = resolve(request.match_info["file"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(await request.read())
        return web.json_response(os.path.relpath(path, user_root))

    async def delete(request):
        os.remove(resolve(request.match_info["file"]))
        return web.Response(status=204)

    async def move(request):
        src, dst = resolve(request.match_info["file"]), resolve(request.match_info["dest"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)
        return web.json_response(os.path.relpath(dst, user_root))

    async def ok(request):
        return web.json_response({"ok": True})

    async def prompt(request):
        if request.method != "POST" or queue is None:
            return web.json_response({"ok": True})
        body = await request.json() if request.body_exists else {}
        queue.number += 1
        prompt_id = f"p{queue.number}"
        queue.pending.append((queue.number, prompt_id, (body or {}).get("prompt") or {"1": {}}, {}, []))
        return web.json_response({"prompt_id": prompt_id, "number": queue.number, "node_errors": {}})

    async def queue_route(request):
        body = await request.json() if request.body_exists else {}
        if queue is not None:
            gone = set((body or {}).get("delete") or [])
            queue.pending = [e for e in queue.pending if e[1] not in gone]
            if (body or {}).get("clear"):
                queue.pending = []
        return web.Response(status=200)

    table = web.RouteTableDef()
    for prefix in ("", "/api"):
        table.get(prefix + "/userdata")(listing)
        table.get(prefix + "/userdata/{file}")(get)
        table.post(prefix + "/userdata/{file}")(post)
        table.delete(prefix + "/userdata/{file}")(delete)
        table.post(prefix + "/userdata/{file}/move/{dest}")(move)
        table.route("*", prefix + "/prompt")(prompt)
        table.post(prefix + "/queue")(queue_route)
        table.post(prefix + "/interrupt")(ok)
        table.route("*", prefix + "/manager/{tail:.*}")(ok)
        table.route("*", prefix + "/customnode/{tail:.*}")(ok)
    return table


class Rig:
    """A running test server plus convenience helpers."""

    def __init__(self, server, store, hub, prompt_server, user_root):
        self.server, self.store, self.hub, self.ps, self.user_root = server, store, hub, prompt_server, user_root
        self.base = f"http://{server.host}:{server.port}"
        self.http = None
        self.headers = {}

    def url(self, path):
        return self.base + path

    async def setup_admin(self, username="boss"):
        r = await self.http.post(self.url("/rigshare/api/setup"), json={"username": username, "password": PASSWORD})
        assert r.status == 200, await r.text()
        self.headers[username] = {"Authorization": "Bearer " + (await r.json())["token"]}
        return self.headers[username]

    async def add_user(self, username, **perms):
        admin = next(iter(self.headers.values()))
        r = await self.http.post(self.url("/rigshare/api/users"), headers=admin,
                                 json={"username": username, "password": PASSWORD, "perms": perms})
        assert r.status == 200, await r.text()
        r = await self.http.post(self.url("/rigshare/api/login"), json={"username": username, "password": PASSWORD})
        self.headers[username] = {"Authorization": "Bearer " + (await r.json())["token"]}
        return self.headers[username]

    async def ws(self, username):
        session = ClientSession()
        sock = await session.ws_connect(self.url("/rigshare/ws"), headers=self.headers[username])
        await sock.send_json({"type": "hello"})
        await recv_until(sock, "welcome")
        return Socket(session, sock)


class Socket:
    def __init__(self, session, sock):
        self.session, self.sock = session, sock

    async def send(self, message):
        await self.sock.send_json(message)

    async def until(self, kind, timeout=2.0):
        return await recv_until(self.sock, kind, timeout)

    async def drain(self, timeout=0.3):
        return await drain(self.sock, timeout)

    async def close(self):
        await self.sock.close()
        await self.session.close()


async def recv_until(sock, kind, timeout=2.0):
    import asyncio
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        msg = await asyncio.wait_for(sock.receive(), max(0.01, end - loop.time()))
        data = json.loads(msg.data)
        if data.get("type") == kind:
            return data


async def drain(sock, timeout=0.3):
    import asyncio
    out = []
    try:
        while True:
            msg = await asyncio.wait_for(sock.receive(), timeout)
            out.append(json.loads(msg.data))
    except asyncio.TimeoutError:
        return out


@contextlib.asynccontextmanager
async def rig_server(config=None, workspace=True, setup=None):
    data = tempfile.mkdtemp()
    user_root = tempfile.mkdtemp()
    os.makedirs(os.path.join(user_root, "workflows"))
    store = Store(data)
    # Tests connect from 127.0.0.1: nothing may be trusted, or checks are skipped.
    store.update_config({"api_protection": {"enabled": True, "trusted_ips": []}, **(config or {})})
    ps = FakePromptServer()
    hub = Hub(store, ps)
    if workspace:
        hub.workspace = Workspace(store, os.path.join(user_root, "workflows"))
    routes.setup(ps, store, hub)
    ps.app.add_routes(comfy_routes(user_root, ps.prompt_queue))
    if setup:
        setup(ps.app)
    server = TestServer(ps.app, host="127.0.0.1")
    await server.start_server()
    rig = Rig(server, store, hub, ps, user_root)
    # unsafe=True: keep cookies for the 127.0.0.1 test host (browsers do).
    async with ClientSession(cookie_jar=CookieJar(unsafe=True)) as http:
        rig.http = http
        try:
            yield rig
        finally:
            await server.close()
