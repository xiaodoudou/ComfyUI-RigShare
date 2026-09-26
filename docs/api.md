# API access

With RigShare installed, the ComfyUI API requires authentication too. Calls without it get:

```json
{"error": "RigShare: login required. API clients: send 'Authorization: Bearer <api key>'."}
```

## API keys

Create one under your avatar → **API keys**. The key (`rs_…`) is shown once, so copy it then. It acts with your permissions: a key from an account without *Queue* cannot queue.

Send it as a header:

```bash
curl -H "Authorization: Bearer rs_yourkey" http://your-server:8188/api/queue

curl -X POST http://your-server:8188/api/prompt \
  -H "Authorization: Bearer rs_yourkey" \
  -H "Content-Type: application/json" \
  -d @prompt.json
```

`X-RigShare-Token: rs_yourkey` works too. For websockets, where some clients cannot set headers, add it to the URL:

```
ws://your-server:8188/ws?clientId=my-script&token=rs_yourkey
```

The key list shows when each key was last used. Revoke keys you no longer need.

## Other apps

Apps that talk to ComfyUI need a key once RigShare is installed. Recent versions of Open WebUI, for example, have a *ComfyUI API Key* field in their image settings and send it as `Authorization: Bearer`. Create a key for it, ideally on an account with only the *Queue* permission.

## Trusted IPs

Requests from **trusted IPs** skip the login and the permission checks entirely. The default is `127.0.0.1` and `::1`. You can add addresses or networks (`172.17.0.0/16`) under **Admin → Server settings**, but prefer API keys: a trusted IP is trusted for everything.

## RigShare's own endpoints

The panel uses these; they take the same session cookie or API key.

| Endpoint | |
|---|---|
| `GET /rigshare/api/status` | Server name and whether setup is needed (public) |
| `GET /rigshare/api/me` | The current account |
| `GET/POST /rigshare/api/me/keys`, `DELETE /rigshare/api/me/keys/{id}` | Your API keys |
| `GET /rigshare/api/chat?before=<seq>&limit=50` | Older chat messages, oldest first, and whether more exist |
| `GET /rigshare/api/rooms` | Live workflows |
| `GET /rigshare/api/room?key=…` | One room, with its workflow JSON |
| `GET /rigshare/api/snapshots?room=…` | History of a room |
| `GET /rigshare/api/people` | Accounts that can be added to an access list |
| `GET/POST/PATCH/DELETE /rigshare/api/users…` | Accounts (admin) |
| `GET/PATCH /rigshare/api/config` | Server settings (admin) |
