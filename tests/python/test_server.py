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


def test_rooms_conflicts_and_access_lists(run):
    async def scenario():
        async with rig_server() as rig:
            admin = await rig.setup_admin()
            for name in ("alice", "bob", "carol"):
                await rig.add_user(name, edit=True)
            alice, bob, carol = [await rig.ws(n) for n in ("alice", "bob", "carol")]
            room = "file:workflows/w.json"
            await alice.send({"type": "join", "room": room, "name": "w", "doc": BASE_DOC})
            joined = await alice.until("room")
            assert joined["created"] and joined["manage"]
            await bob.send({"type": "join", "room": room, "name": "w", "doc": BASE_DOC})
            await bob.until("room")
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

            r = await rig.http.put(rig.url("/rigshare/api/room/acl"), json={"key": room, "restricted": True, "members": {"carol": "view"}}, headers=rig.headers["bob"])
            assert r.status == 403, "only owner or admin"
            r = await rig.http.put(rig.url("/rigshare/api/room/acl"), json={"key": room, "restricted": True, "members": {"carol": "view"}}, headers=rig.headers["alice"])
            assert r.status == 200
            msgs = await bob.drain()
            assert any(m["type"] == "room_denied" for m in msgs)
            presence = [m for m in msgs if m["type"] == "presence"][-1]
            assert all(r["key"] != room for r in presence["rooms"])
            assert (await rig.http.get(rig.url(f"/api/userdata/{enc('workflows/w.json')}"), headers=rig.headers["bob"])).status == 403

            await carol.send({"type": "join", "room": room, "name": "w", "doc": BASE_DOC})
            assert (await carol.until("room"))["role"] == "view"
            await carol.drain()
            await carol.send({"type": "graph", "room": room, "patch": {"nodes": [dict(BASE_DOC["nodes"][0], pos=[9, 9])]}})
            assert "view" in ((await carol.until("doc")).get("reason") or "")
            r = await rig.http.put(rig.url("/rigshare/api/room/acl"), json={"key": room, "restricted": True, "members": {"carol": "edit"}}, headers=admin)
            assert (await carol.until("room_info"))["role"] == "edit"
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
