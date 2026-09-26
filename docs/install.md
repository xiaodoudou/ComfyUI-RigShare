# Installing

## As a custom node

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xiaodoudou/ComfyUI-RigShare.git
```

Restart ComfyUI. The console prints:

```
[RigShare] No accounts yet: open ComfyUI in a browser to create the admin account.
[RigShare] ready, data in /path/to/ComfyUI/rigshare
```

## First run

Open ComfyUI in a browser. While no account exists, the login page shows **Create admin account**. Pick a username and a password of at least 8 characters, and you are signed in as the administrator. The server accepts this only while there are no accounts, so once the first admin exists, the form is gone for good.

Do this right after installing. Until an admin exists, whoever reaches the page first gets to create one.

For scripted installs you can skip the form by setting these before the first start:

```bash
RIGSHARE_ADMIN_USER=admin
RIGSHARE_ADMIN_PASSWORD=a-long-password
```

They are only read when there are no accounts, so remove them afterwards.

## Docker / compose

Mount the node and a data folder:

```yaml
services:
  comfyui:
    volumes:
      - ./custom_nodes/ComfyUI-RigShare:/app/custom_nodes/ComfyUI-RigShare
      - ./rigshare:/app/rigshare
```

The data folder is `<ComfyUI base path>/rigshare`; point it elsewhere with `RIGSHARE_DATA_DIR`. It holds:

| File | What it is |
|---|---|
| `users.json` | Accounts: password hashes, permissions, API key hashes |
| `sessions.json` | Active logins (session ids, not tokens) |
| `secret.key` | Key that signs session tokens. Keep it private |
| `config.json` | Server settings, see [Settings](settings.md) |
| `rooms/` | Current state of every shared workflow |
| `snapshots/` | Workflow history |
| `chat.jsonl` | The whole chat history, one message per line |

Back up the folder to keep accounts and history. Deleting `secret.key` signs everyone out.

## Upgrading from ComfyUI-Nexus

Remove or disable `custom_nodes/ComfyUI-Nexus` and install RigShare. Nexus kept plaintext passwords in `nexus/admins.json`, so nothing is imported: create the admin on first run, then delete the old `nexus` folder.

## Removing

Delete `custom_nodes/ComfyUI-RigShare` and restart. ComfyUI goes back to having no login. The `rigshare` data folder can be deleted too.
