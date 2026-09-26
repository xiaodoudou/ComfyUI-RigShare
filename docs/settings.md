# Settings

## Your settings

In ComfyUI's settings dialog, under **RigShare**. They apply to your browser only.

| Setting | Default |
|---|---|
| Show other people's cursors and selections | on |
| Show names next to cursors | on |
| Play a sound for new chat messages | on |
| Show a notification for new chat messages | off |

Commands, bindable under *Keybindings*: **RigShare: Open chat** and **Open from RigShare…** (Ctrl+Alt+O).

The **Server** tab's *Pop out* button toggles the floating monitor. Drag it by its title; its position is remembered.

## Server settings

Admins change these under **Admin → Server settings**. They are stored in `rigshare/config.json`.

| Key | Default | |
|---|---|---|
| `server_name` | `RigShare` | Shown on the login page and in the panel |
| `require_login` | `true` | Sign in before ComfyUI loads; API clients use keys |
| `allow_guests` | `false` | Only with `require_login` off: allow visitors without an account |
| `guest_permissions` | `{"edit": false, "queue": false}` | What guests may do |
| `broadcast_execution` | `true` | Send progress and previews to everyone, not only whoever queued |
| `hide_comfy_account` | `false` | Hide ComfyUI's Comfy.org sign-in button and dialog |
| `hide_comfy_file_tabs` | `true` | Hide ComfyUI's own Workflows and Apps sidebar tabs; RigShare's Files tab replaces them and their shortcuts open it |
| `hide_api_templates` | `false` | Remove templates that need paid API nodes from the template browser |
| `api_protection.enabled` | `true` | Server-side checks on queue, interrupt, free and upload calls |
| `api_protection.trusted_ips` | `["127.0.0.1", "::1"]` | Addresses or networks that skip login and checks |
| `room_expiry_days` | `14` | Forget the live state of workflows nobody opened for this long |
| `snapshot_interval_sec` | `300` | Automatic snapshot interval while editing; `0` turns it off |
| `snapshot_keep` | `30` | Automatic snapshots kept per workflow; named ones are always kept |
| `chat_keep` | `0` | Chat messages kept: `0` keeps the whole history, a number trims it to the latest ones at startup |

## Environment variables

| Variable | |
|---|---|
| `RIGSHARE_DATA_DIR` | Data folder, instead of `<ComfyUI>/rigshare` |
| `RIGSHARE_ADMIN_USER`, `RIGSHARE_ADMIN_PASSWORD` | Create the first admin without the setup page; only read while no account exists |
