# Changelog

## Unreleased

### Added

- App mode: live workflows work in ComfyUI's App view. Each person keeps their own graph or App view through live edits, and App inputs sync. Cursors are off in the App view. Workflows saved as Apps (`.app.json`) show with an app icon in Files and in the Live list, and Save keeps them Apps
- In the App view, where ComfyUI shows only its own sidebar tabs, RigShare adds **RigShare** and **Files** buttons to that sidebar, with the unread chat badge. They open the panels in a drawer beside it
- The Live tab and People show whether each person is in the node graph or the App view, with ComfyUI's own Graph and App icons
- Folder access is managed only in the Files tab. *This tab* in the Live tab still says whether the folder is restricted
- ComfyUI's own Workflows and Apps sidebar tabs are hidden, since Files replaces them, and their shortcuts open Files. Admin setting `hide_comfy_file_tabs`, on by default

## 1.1.0 (2026-09-26)

Workflows now live in folders, like a shared drive, and sharing follows them.

### Added

- **Workspace folders**: a private **My files** folder per account (`users/<name>/`), **Shared** folders owned by whoever creates them, and common workflows at the top level. The server enforces them on ComfyUI's own file API, and ComfyUI's workflow browser lists only what you can open
- **Files** sidebar tab with **My files**, **Shared** and, for admins, **All** (the whole workflows folder); new folders, rename, move and delete; a green dot on live files; **From computer**
- **Save asks where**: a name plus the same folder tabs, starting in My files or the last folder used
- **Open from RigShare…** in the Workflow menu (Ctrl+Alt+O)
- Folder access lists: a shared folder's owner or an admin can restrict it to chosen people, each with view or edit. For a live workflow in a folder you own, *This tab* shows **Folder access**
- Only admins delete common workflows; a shared folder's owner deletes in that folder; you delete in yours
- Whole chat history: stored in `chat.jsonl` with no limit (`chat_keep` trims it). The panel shows the latest 50 messages and loads older ones as you scroll up, with date dividers. The old `chat.json` is imported once
- Test suite: pytest unit and end-to-end tests against a real aiohttp server, Node tests for the client, and a GitHub Actions workflow

### Changed

- Sharing follows folders: every saved workflow outside a private folder is live while it is open, with nothing to share by hand. Unsaved tabs and files in My files stay private
- The **Live** tab lists the workflows someone has open right now, with their folder and who is in them. A private workflow's panel offers **Move to Shared…**
- Renaming or moving a workflow or folder keeps everyone's open tabs on it, under the new name. People who can't open the new location learn nothing about it and keep a private copy
- Deleting a live workflow closes it for the people who have it open, keeping a snapshot; moving one into a private folder takes it out of live sharing
- Who can open a workflow follows its folder only

### Fixed

- Opening a file could overwrite the shared workflow of the previous tab
- Switching straight between the RigShare and Files sidebar tabs could leave the previous tab's content on screen

### Removed

- Per-workflow access lists (restrict the folder instead). Lists set on individual workflows are dropped
- *Share this tab*, *Stop sharing*, the automatic-sharing settings and the admin 🗑 for idle rooms
- Live rooms for unsaved tabs (`tmp:`): save the workflow outside My files to work on it together

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
