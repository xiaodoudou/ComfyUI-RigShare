# Changelog

## Unreleased

### Changed

- Sharing follows folders: every saved workflow outside a private folder is live while it is open, with nothing to share by hand. Unsaved tabs and files in *My files* stay private
- The **Live** list shows the workflows someone has open right now, with their folder and who is in them; the Files tab marks live files
- A private workflow's panel offers **Move to Shared…** to take it live
- Deleting a live file closes it for the people who have it open (a snapshot is kept); moving one into a private folder takes it out of live sharing

### Removed

- *Share this tab*, *Stop sharing*, the automatic-sharing settings and the admin 🗑 for idle rooms

## 1.0.0

First release of RigShare, a rewrite of [ComfyUI-Nexus](https://github.com/daxcay/ComfyUI-Nexus) 1.0.2 for the current ComfyUI frontend.

### Added

- Login page before ComfyUI loads, with first-run creation of the admin account
- JWT sessions (HS256, 12 h, renewed while active), bound to revocable server-side sessions
- Personal API keys for scripts and other apps
- Every workflow shared as its own room: saved files automatically, unsaved tabs once edited
- Shared workflows list, *Share this tab*, *Stop sharing*, removal of idle rooms
- Per-workflow snapshots: automatic, named, restore for everyone, open as a copy
- Per-workflow access lists: restrict a workflow to chosen people, each with view or edit
- *Manager* permission: only accounts with it can use ComfyUI Manager (install, update, snapshots, restart). Enforced server-side; the Manager button is hidden without it
- Admin option to hide ComfyUI's Comfy.org account login (top-bar button and sign-in dialog)
- Admin option to hide templates that need paid API nodes from the template browser
- Conflict-free concurrent edits: links and groups merge by id, clashing node and link ids are renumbered, dangling links repaired
- Live cursors and selections, drawn above image previews and DOM widgets
- Follow mode that jumps to the other person's tab and view
- Chat with unread badge, blinking sidebar icon and sound
- Server monitor (CPU, RAM, per-GPU load, VRAM, temperature, power, queue) with a floating widget
- Execution progress and previews sent to everyone
- Admin panel: accounts, permissions, display names, usernames, passwords, server settings
- Server-side permission checks on ComfyUI's queue, interrupt, free and upload endpoints
- Warning when a reverse proxy drops WebSocket upgrades
- Login page that follows the ComfyUI palette last used in the browser

### Changed

- The sidebar panel replaces the floating chat window and keyboard shortcuts
- The server is authoritative: identity and permissions are checked on every message
- Graph sync uses the frontend's change tracker and per-node patches instead of patching litegraph

### Removed

- `/login`, `/logout` and `/nick` chat commands
- Plaintext `admins.json` and the shared default admin password
- Hiding ComfyUI's menus with CSS, and clearing the user's workflow on load
