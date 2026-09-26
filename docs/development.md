# Development

## Tests

RigShare has two test suites. Neither needs ComfyUI.

```bash
pip install pytest aiohttp
python -m pytest -q
node --test "tests/js/*.test.mjs"
```

| Suite | What it covers |
|---|---|
| `tests/python/test_store.py` | Accounts, first-run setup, password hashing, JWT sessions (tampering, `alg: none`, expiry, refresh, revocation), API keys, snapshots |
| `tests/python/test_graphdoc.py` | Workflow patches, link repair, id renumbering for simultaneous edits, and parity with the JavaScript implementation |
| `tests/python/test_workspace.py` | Folder rules: path normalisation (double encoding, `../`), private and shared folders, access lists, moves, deletes, browsing |
| `tests/python/test_server.py` | End to end against a real aiohttp server: login gate, cookies, API keys, permissions, Manager gating, template filtering, live rooms, folder access, moves, folders through ComfyUI's userdata API |
| `tests/js/graphdoc.test.mjs` | The client-side patch logic |
| `tests/js/files.test.mjs` | Files tabs (My files, Shared, All), start folders, breadcrumbs |
| `tests/js/sync.test.mjs` | Client diffs, and the regression test for opening a file overwriting the previous tab's shared workflow |

The server tests use a small stand-in for ComfyUI's `/userdata` API (`tests/python/helpers.py`), so they run anywhere Python does. GitHub Actions runs both suites on every push and pull request.

`tests/` is excluded from the Comfy Registry package by `.comfyignore`.

## Layout

| Path | |
|---|---|
| `__init__.py` | ComfyUI entry point: wires the store, hub, workspace and routes |
| `rigshare_core/store.py` | Accounts, sessions, API keys, config, rooms and snapshots on disk |
| `rigshare_core/jwt.py` | HS256 tokens |
| `rigshare_core/hub.py` | Websocket hub: presence, chat, cursors, live rooms |
| `rigshare_core/graphdoc.py` | Workflow patches (mirrored by `web/rigshare/graphdoc.js`) |
| `rigshare_core/workspace.py` | Private and shared folders |
| `rigshare_core/routes.py` | HTTP API and the middleware that enforces login and permissions |
| `web/rigshare/` | The frontend extension |
