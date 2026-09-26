"""End-to-end: HTTP API, login gate, websocket hub, folders over ComfyUI's API."""

import asyncio
import json
import os
from urllib.parse import quote

from helpers import PASSWORD, enc, rig_server

BASE_DOC = {"last_node_id": 2, "last_link_id": 0, "nodes": [
    {"id": 1, "type": "A", "inputs": [], "outputs": [{"name": "o", "links": []}]},
    {"id": 2, "type": "B", "inputs": [{"name": "i", "link": None}, {"name": "j", "link": None}], "outputs": []}],
    "links": [], "groups": [], "extra": {}, "version": 0.4}


def test_login_gate_and_setup(run):
    async def scenario():
        async with rig_server() as rig:
            h = rig.http
            r = await h.get(rig.url("/"), headers={"Accept": "text/html"}, allow_redirects=False)
            assert r.status == 302 and "/rigshare/login" in r.headers["Location"]
            assert (await h.get(rig.url("/api/prompt"))).status == 401
            status = await (await h.get(rig.url("/rigshare/api/status"))).json()
            assert status["needs_setup"]
            page = await (await h.get(rig.url("/rigshare/login"))).text()
            assert "const SETUP = true" in page
            await rig.setup_admin()
            r = await h.post(rig.url("/rigshare/api/setup"), json={"username": "evil", "password": PASSWORD})
            assert r.status == 409, "setup works only once"
            r = await h.post(rig.url("/rigshare/api/login"), json={"username": "boss", "password": "nope-nope"})
            assert r.status == 401
    run(scenario())


def test_cookie_session_and_logout(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            r = await rig.http.post(rig.url("/rigshare/api/login"), json={"username": "boss", "password": PASSWORD})
            token = (await r.json())["token"]
            assert "rigshare_session" in r.cookies
            assert (await rig.http.get(rig.url("/api/prompt"))).status == 200, "cookie authenticates"
            await rig.http.post(rig.url("/rigshare/api/logout"), headers={"Authorization": f"Bearer {token}"})
            assert (await rig.http.get(rig.url("/api/prompt"), headers={"Authorization": f"Bearer {token}"})).status == 401
    run(scenario())


def test_api_keys_over_http(run):
    async def scenario():
        async with rig_server() as rig:
            admin = await rig.setup_admin()
            r = await rig.http.post(rig.url("/rigshare/api/me/keys"), json={"name": "script"}, headers=admin)
            body = await r.json()
            key = {"Authorization": f"Bearer {body['key']}"}
            assert (await rig.http.get(rig.url("/api/prompt"), headers=key)).status == 200
            await rig.http.delete(rig.url(f"/rigshare/api/me/keys/{body['id']}"), headers=admin)
            assert (await rig.http.get(rig.url("/api/prompt"), headers=key)).status == 401
    run(scenario())


def test_permissions(run):
    async def scenario():
        async with rig_server() as rig:
            admin = await rig.setup_admin()
            viewer = await rig.add_user("viewer")
            queuer = await rig.add_user("queuer", queue=True)
            h = rig.http
            assert (await h.post(rig.url("/api/prompt"), headers=viewer)).status == 403
            assert (await h.post(rig.url("/api/prompt"), headers=queuer)).status == 200
            assert (await h.post(rig.url("/api/manager/queue/install"), headers=queuer)).status == 403
            assert (await h.get(rig.url("/customnode/getmappings"), headers=viewer)).status == 200, "read-only lookup"
            assert (await h.post(rig.url("/api/manager/queue/install"), headers=admin)).status == 200
            await h.patch(rig.url("/rigshare/api/users/queuer"), json={"perms": {"manager": True}}, headers=admin)
            assert (await h.post(rig.url("/api/manager/queue/install"), headers=queuer)).status == 200
            assert (await h.get(rig.url("/rigshare/api/users"), headers=viewer)).status == 403
    run(scenario())


def test_template_filter_and_live_options(run, tmp_path):
    templates = tmp_path / "templates"
    templates.mkdir()
    (templates / "index.json").write_text(json.dumps([
        {"title": "Image", "templates": [{"name": "sdxl", "tags": ["Image"], "openSource": True},
                                         {"name": "api_flux", "tags": ["API"], "openSource": False}]},
        {"title": "Ads", "templates": [{"name": "x", "tags": ["API"]}]}]))

    async def scenario():
        async with rig_server(setup=lambda app: app.router.add_static("/templates", str(templates))) as rig:
            admin = await rig.setup_admin()
            alice = await rig.add_user("alice", edit=True)
            sock = await rig.ws("alice")
            full = await (await rig.http.get(rig.url("/templates/index.json"), headers=alice)).json()
            assert sum(len(c["templates"]) for c in full) == 3
            await rig.http.patch(rig.url("/rigshare/api/config"), json={"hide_api_templates": True, "hide_comfy_account": True}, headers=admin)
            assert (await sock.until("server"))["server"]["hide_comfy_account"] is True
            slim = await (await rig.http.get(rig.url("/templates/index.json"), headers=alice)).json()
            assert [t["name"] for c in slim for t in c["templates"]] == ["sdxl"] and len(slim) == 1
            await sock.close()
    run(scenario())


def test_rooms_conflicts_and_folder_access(run):
    async def scenario():
        async with rig_server() as rig:
            admin = await rig.setup_admin()
            for name in ("alice", "bob", "carol"):
                await rig.add_user(name, edit=True)
            H = rig.headers
            r = await rig.http.post(rig.url("/rigshare/api/workspace/mkdir"), json={"parent": "@shared", "name": "Team"}, headers=H["alice"])
            assert r.status == 200
            alice, bob, carol = [await rig.ws(n) for n in ("alice", "bob", "carol")]
            room = "file:workflows/shared/Team/w.json"
            await alice.send({"type": "join", "room": room, "name": "w", "doc": BASE_DOC})
            joined = await alice.until("room")
            assert joined["created"] and joined["manage"] and joined["folder"] == "shared/Team"
            await bob.send({"type": "join", "room": room, "name": "w", "doc": BASE_DOC})
            assert not (await bob.until("room"))["manage"], "only the folder owner or admins manage access"
            await alice.drain(); await bob.drain()

            def add(target_slot):
                return {"nodes": [{"id": 3, "type": "N", "inputs": [], "outputs": [{"name": "o", "links": [1]}]}], "added": [3],
                        "links": {"upsert": [[1, 3, 0, 2, target_slot, "X"]], "added": [1]},
                        "set": {"last_node_id": 3, "last_link_id": 1}}
            await alice.send({"type": "graph", "room": room, "patch": add(0)})
            await bob.send({"type": "graph", "room": room, "patch": add(1)})
            await asyncio.sleep(0.4)
            doc = rig.hub.rooms[room].doc
            assert sorted(n["id"] for n in doc["nodes"]) == [1, 2, 3, 4], "both nodes kept"
            assert [s["link"] for s in doc["nodes"][1]["inputs"]] == [1, 2]
            assert any(m["type"] == "doc" and m.get("reason") is None for m in await bob.drain()), "quiet resync"

            # Access follows the folder: restricting it takes out whoever lost access.
            r = await rig.http.patch(rig.url("/rigshare/api/workspace/folders"), json={"path": "shared/Team", "restricted": True, "members": {"carol": "view"}}, headers=H["bob"])
            assert r.status == 403, "only the folder owner or an admin"
            r = await rig.http.patch(rig.url("/rigshare/api/workspace/folders"), json={"path": "shared/Team", "restricted": True, "members": {"carol": "view"}}, headers=H["alice"])
            assert r.status == 200
            msgs = await bob.drain()
            assert any(m["type"] == "room_denied" for m in msgs)
            presence = [m for m in msgs if m["type"] == "presence"][-1]
            assert all(r["key"] != room for r in presence["rooms"])
            assert (await alice.until("room_info"))["restricted"] is True

            await carol.send({"type": "join", "room": room, "name": "w", "doc": BASE_DOC})
            assert (await carol.until("room"))["role"] == "view"
            await carol.drain()
            await carol.send({"type": "graph", "room": room, "patch": {"nodes": [dict(BASE_DOC["nodes"][0], pos=[9, 9])]}})
            assert "view" in ((await carol.until("doc")).get("reason") or "")
            await rig.http.patch(rig.url("/rigshare/api/workspace/folders"), json={"path": "shared/Team", "restricted": True, "members": {"carol": "edit"}}, headers=admin)
            assert (await carol.until("room_info"))["role"] == "edit"
            assert (await rig.http.put(rig.url("/rigshare/api/room/acl"), json={"key": room}, headers=admin)).status in (404, 405), "no per-workflow lists"
            for s in (alice, bob, carol):
                await s.close()
    run(scenario())


def test_folders_over_comfy_api(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            for name, perms in (("alice", {"edit": True}), ("bob", {"edit": True}), ("carol", {"edit": True}), ("dave", {})):
                await rig.add_user(name, **perms)
            H, h = rig.headers, rig.http

            async def save(user, path):
                return (await h.post(rig.url(f"/api/userdata/{enc(path)}"), data=b"{}", headers=H[user])).status

            async def listing(user):
                r = await h.get(rig.url("/api/userdata?dir=workflows&recurse=true&full_info=true"), headers=H[user])
                return {i["path"] for i in await r.json()}

            assert await save("alice", "workflows/users/alice/secret.json") == 200
            assert await save("dave", "workflows/users/dave/mine.json") == 200
            assert await save("dave", "workflows/common.json") == 403
            assert await save("bob", "workflows/users/alice/evil.json") == 403
            for raw in (enc("workflows/users/alice/secret.json"),
                        quote(enc("workflows/users/alice/secret.json"), safe=""),
                        enc("workflows/shared/../users/alice/secret.json"),
                        "workflows/users/alice/secret.json"):
                assert (await h.get(rig.url(f"/api/userdata/{raw}"), headers=H["bob"])).status in (403, 404), raw
            assert "users/alice/secret.json" not in await listing("bob")
            assert "users/alice/secret.json" in await listing("alice")

            r = await h.post(rig.url("/rigshare/api/workspace/mkdir"), json={"parent": "@shared", "name": "Team"}, headers=H["bob"])
            assert r.status == 200
            assert await save("alice", "workflows/shared/Team/plan.json") == 200
            await h.patch(rig.url("/rigshare/api/workspace/folders"), json={"path": "shared/Team", "restricted": True, "members": {"carol": "view"}}, headers=H["bob"])
            assert not any(p.startswith("shared/Team/") for p in await listing("alice"))
            assert await save("carol", "workflows/shared/Team/plan.json") == 403
            assert (await h.get(rig.url(f"/api/userdata/{enc('workflows/shared/Team/plan.json')}"), headers=H["carol"])).status == 200

            r = await h.post(rig.url(f"/api/userdata/{enc('workflows/shared/Team/plan.json')}/move/{enc('workflows/users/bob/plan.json')}"), headers=H["bob"])
            assert r.status == 200
            assert (await h.delete(rig.url(f"/api/userdata/{enc('workflows/users/alice/secret.json')}"), headers=H["bob"])).status == 403
            assert (await h.delete(rig.url(f"/api/userdata/{enc('workflows/users/alice/secret.json')}"), headers=H["alice"])).status == 204

            sock = await rig.ws("bob")
            await sock.send({"type": "join", "room": "file:workflows/users/alice/other.json", "name": "o", "doc": {"nodes": []}})
            assert (await sock.until("room_denied"))["room"].endswith("alice/other.json")
            await sock.close()

            await save("alice", "workflows/users/alice/keep.json")
            await h.patch(rig.url("/rigshare/api/users/alice"), json={"username": "alicia"}, headers=H["boss"])
            assert os.path.exists(os.path.join(rig.user_root, "workflows", "users", "alicia", "keep.json"))
    run(scenario())


def test_live_follows_folders(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            for name in ("alice", "bob"):
                await rig.add_user(name, edit=True)
            alice, bob = await rig.ws("alice"), await rig.ws("bob")

            # Your own private folder and unsaved tabs never become live.
            for key in ("file:workflows/users/alice/mine.json", "tmp:abc"):
                await alice.send({"type": "join", "room": key, "name": "x", "doc": BASE_DOC})
                assert (await alice.until("room_denied"))["room"] == key
            assert not rig.hub.rooms

            # Anything else is live while open, and only open ones are listed.
            key = "file:workflows/shared/team.json"
            await alice.send({"type": "join", "room": key, "name": "team", "doc": BASE_DOC})
            await alice.until("room")
            presence = [m for m in await bob.drain() if m["type"] == "presence"][-1]
            assert [r["key"] for r in presence["rooms"]] == [key]
            await alice.send({"type": "join", "room": None})
            presence = [m for m in await bob.drain() if m["type"] == "presence"][-1]
            assert presence["rooms"] == [], "closed workflows leave the live list"
            assert key in rig.hub.rooms, "its state is kept for the next person who opens it"

            # Moving it into a private folder takes it out of live sharing.
            path = "workflows/shared/team.json"
            await rig.http.post(rig.url(f"/api/userdata/{enc(path)}"), data=b"{}", headers=rig.headers["alice"])
            await bob.send({"type": "join", "room": key, "name": "team"})
            await bob.until("room")
            r = await rig.http.post(rig.url(f"/api/userdata/{enc(path)}/move/{enc('workflows/users/alice/team.json')}"), headers=rig.headers["boss"])
            assert r.status == 200
            assert not rig.hub.rooms

            # Deleting a live file closes it for whoever has it open.
            key2, path2 = "file:workflows/gone.json", "workflows/gone.json"
            await rig.http.post(rig.url(f"/api/userdata/{enc(path2)}"), data=b"{}", headers=rig.headers["alice"])
            await bob.send({"type": "join", "room": key2, "name": "gone", "doc": BASE_DOC})
            await bob.until("room")
            assert (await rig.http.delete(rig.url(f"/api/userdata/{enc(path2)}"), headers=rig.headers["boss"])).status == 204
            assert (await bob.until("room_closed"))["room"] == key2
            assert key2 not in rig.hub.rooms
            await alice.close(); await bob.close()
    run(scenario())


def test_moves_follow_open_tabs(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            for name in ("alice", "bob", "carol", "dave"):
                await rig.add_user(name, edit=True)
            H, h = rig.headers, rig.http
            socks = {n: await rig.ws(n) for n in ("alice", "bob", "carol", "dave")}

            async def moves(name):
                return [m for m in await socks[name].drain() if m["type"] in ("path_moved", "path_closed")]

            # A live file renamed: everyone who could open it is told, and its room follows.
            await h.post(rig.url(f"/api/userdata/{enc('workflows/a.json')}"), data=b"{}", headers=H["alice"])
            await socks["bob"].send({"type": "join", "room": "file:workflows/a.json", "name": "a", "doc": BASE_DOC})
            await socks["bob"].until("room")
            for sock in socks.values():
                await sock.drain()
            r = await h.post(rig.url(f"/api/userdata/{enc('workflows/a.json')}/move/{enc('workflows/b.json')}"), headers=H["alice"])
            assert r.status == 200
            assert await moves("bob") == [{"type": "path_moved", "from": "workflows/a.json", "to": "workflows/b.json"}]
            assert "file:workflows/b.json" in rig.hub.rooms and "file:workflows/a.json" not in rig.hub.rooms

            # Into a private folder: the owner follows it, the others keep a private copy.
            r = await h.post(rig.url(f"/api/userdata/{enc('workflows/b.json')}/move/{enc('workflows/users/alice/b.json')}"), headers=H["boss"])
            assert r.status == 200
            assert (await moves("alice"))[0]["type"] == "path_moved"
            assert await moves("bob") == [{"type": "path_closed", "from": "workflows/b.json"}]
            assert not rig.hub.rooms

            # A restricted shared folder renamed: people without access learn nothing.
            await h.post(rig.url("/rigshare/api/workspace/mkdir"), json={"parent": "@shared", "name": "Team"}, headers=H["alice"])
            await h.patch(rig.url("/rigshare/api/workspace/folders"), json={"path": "shared/Team", "restricted": True, "members": {"carol": "view"}}, headers=H["alice"])
            for sock in socks.values():
                await sock.drain()
            r = await h.patch(rig.url("/rigshare/api/workspace/folders"), json={"path": "shared/Team", "name": "Crew"}, headers=H["alice"])
            assert r.status == 200
            assert await moves("carol") == [{"type": "path_moved", "from": "workflows/shared/Team", "to": "workflows/shared/Crew"}]
            assert await moves("dave") == []
            for sock in socks.values():
                await sock.close()
    run(scenario())


def test_chat_history_pages(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            sock = await rig.ws("boss")
            for i in range(70):
                await sock.send({"type": "chat", "text": f"hello {i}"})
            await asyncio.sleep(0.3)
            await sock.close()
            sock = await rig.ws("boss")
            await sock.close()
            # The welcome carries only the newest page; the rest comes over HTTP.
            h = rig.headers["boss"]
            session = rig.http
            ws = await session.ws_connect(rig.url("/rigshare/ws"), headers=h)
            await ws.send_json({"type": "hello"})
            while True:
                welcome = json.loads((await ws.receive()).data)
                if welcome["type"] == "welcome":
                    break
            await ws.close()
            assert len(welcome["chat"]) == 50 and welcome["chat_more"]
            oldest = welcome["chat"][0]["seq"]
            older = await (await session.get(rig.url(f"/rigshare/api/chat?before={oldest}&limit=50"), headers=h)).json()
            texts = [m["text"] for m in older["messages"]]
            assert not older["more"] and older["messages"][0]["seq"] == 0
            seqs = [m["seq"] for m in older["messages"] + welcome["chat"]]
            assert "hello 0" in texts and seqs == list(range(len(seqs))), "no gaps, no repeats"
            assert (await session.get(rig.url("/rigshare/api/chat?before=x"))).status in (400, 401)
    run(scenario())


def test_apps_and_comfy_file_tabs(run):
    async def scenario():
        async with rig_server() as rig:
            admin = await rig.setup_admin()
            alice = await rig.add_user("alice", edit=True)
            h = rig.http
            await h.post(rig.url(f"/api/userdata/{enc('workflows/users/alice/demo.app.json')}"), data=b"{}", headers=alice)
            await h.post(rig.url(f"/api/userdata/{enc('workflows/users/alice/plain.json')}"), data=b"{}", headers=alice)
            listing = await (await h.get(rig.url("/rigshare/api/workspace/list?path=users/alice"), headers=alice)).json()
            entries = {e["name"]: e for e in listing["entries"]}
            assert entries["demo"].get("app") is True and "app" not in entries["plain"], "apps named without .app"

            sock = await rig.ws("alice")
            key = "file:workflows/shared/demo.app.json"
            await sock.send({"type": "join", "room": key, "name": "demo", "doc": BASE_DOC})
            await sock.until("room")
            presence = [m for m in await sock.drain() if m["type"] == "presence"][-1]
            assert presence["rooms"][0]["app"] is True

            # ComfyUI's own Workflows/Apps tabs are hidden unless an admin turns that off.
            assert rig.hub.server_info()["hide_comfy_file_tabs"] is True
            await h.patch(rig.url("/rigshare/api/config"), json={"hide_comfy_file_tabs": False}, headers=admin)
            assert (await sock.until("server"))["server"]["hide_comfy_file_tabs"] is False
            await sock.close()
    run(scenario())


def test_view_mode_in_presence(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            await rig.add_user("alice", edit=True)
            alice, boss = await rig.ws("alice"), await rig.ws("boss")
            await boss.drain()
            await alice.send({"type": "view", "view": "app"})
            presence = await boss.until("presence")
            assert {u["key"]: u["view"] for u in presence["users"]} == {"alice": "app", "boss": "graph"}
            await alice.send({"type": "view", "view": "nonsense"})
            await asyncio.sleep(0.2)
            assert next(c for c in rig.hub.clients.values() if c.key == "alice").view == "app", "unknown views are ignored"
            await alice.close(); await boss.close()
    run(scenario())


def test_listing_inside_a_shared_folder(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            alice = await rig.add_user("alice", edit=True)
            bob = await rig.add_user("bob", edit=True)
            h = rig.http
            await h.post(rig.url("/rigshare/api/workspace/mkdir"), json={"parent": "@shared", "name": "FaceSwap"}, headers=alice)
            await h.post(rig.url("/rigshare/api/workspace/mkdir"), json={"parent": "shared/FaceSwap", "name": "old"}, headers=alice)

            async def here(user, path):
                r = await h.get(rig.url(f"/rigshare/api/workspace/list?path={path}"), headers=user)
                return (await r.json()).get("shared_folder")

            # The folder you are in, even deeper down, and whether you manage its access.
            assert await here(alice, "shared/FaceSwap/old") == {"path": "shared/FaceSwap", "name": "FaceSwap", "owner": "alice",
                                                               "restricted": False, "manage": True}
            assert (await here(bob, "shared/FaceSwap"))["manage"] is False
            assert await here(alice, "users/alice") is None
    run(scenario())


def test_workflows_with_an_app_set_up(run):
    async def scenario():
        async with rig_server() as rig:
            await rig.setup_admin()
            alice = await rig.add_user("alice", edit=True)
            h = rig.http
            with_app = json.dumps({"nodes": [], "extra": {"linearData": {"inputs": [[3, "seed"]], "outputs": [9]}}}).encode()
            empty_app = json.dumps({"nodes": [], "extra": {"linearData": {"inputs": [], "outputs": []}}}).encode()
            for name, body in (("faceswap.json", with_app), ("empty.json", empty_app), ("plain.json", b"{}")):
                await h.post(rig.url(f"/api/userdata/{enc('workflows/users/alice/' + name)}"), data=body, headers=alice)

            async def apps():
                listing = await (await h.get(rig.url("/rigshare/api/workspace/list?path=users/alice"), headers=alice)).json()
                return {e["name"] for e in listing["entries"] if e.get("app")}
            assert await apps() == {"faceswap"}, "only a workflow whose App has inputs or outputs"
            # Edited on disk: the cached answer follows the file.
            await h.post(rig.url(f"/api/userdata/{enc('workflows/users/alice/faceswap.json')}"), data=b'{"nodes": []}', headers=alice)
            assert await apps() == set()

            sock = await rig.ws("alice")
            await sock.send({"type": "join", "room": "file:workflows/shared/f.json", "name": "f", "doc": json.loads(with_app)})
            await sock.until("room")
            presence = [m for m in await sock.drain() if m["type"] == "presence"][-1]
            assert presence["rooms"][0]["app"] is True
            await sock.close()
    run(scenario())


def test_every_save_keeps_a_snapshot(run):
    async def scenario():
        async with rig_server({"snapshot_keep": 2}) as rig:
            await rig.setup_admin()
            alice = await rig.add_user("alice", edit=True)
            h = rig.http
            path = "workflows/shared/flow.json"
            for n in range(3):
                doc = json.dumps({"nodes": [{"id": i} for i in range(n + 1)], "links": []}).encode()
                assert (await h.post(rig.url(f"/api/userdata/{enc(path)}"), data=doc, headers=alice)).status == 200
            await h.post(rig.url(f"/api/userdata/{enc('workflows/notes.json')}"), data=b'{"not": "a workflow"}', headers=alice)
            snaps = await (await h.get(rig.url(f"/rigshare/api/snapshots?room={enc('file:' + path)}"), headers=alice)).json()
            assert [s["nodes"] for s in snaps] == [3, 2], "newest first, rotated to snapshot_keep"
            assert all(s["kind"] == "save" and s["label"].startswith("Saved at ") and s["author"] == "alice" for s in snaps)
            assert not rig.store.list_snapshots("file:workflows/notes.json"), "only workflows"
            # A save that is refused keeps nothing.
            viewer = await rig.add_user("viewer")
            await h.post(rig.url(f"/api/userdata/{enc(path)}"), data=b'{"nodes": []}', headers=viewer)
            assert len(rig.store.list_snapshots("file:" + path)) == 2
    run(scenario())
