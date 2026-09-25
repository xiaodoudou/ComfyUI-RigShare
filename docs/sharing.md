# Sharing workflows

Every shared workflow is a *room* on the server. The server keeps the current version of each room and relays edits between everyone who has it open.

## Which tabs are shared

| Tab | Shared? |
|---|---|
| A saved workflow file | Yes, automatically. Everyone who opens the same file lands in the same room. |
| An unsaved tab | As soon as you edit it, or when you click **Share this tab**. Untouched tabs, such as the default workflow or tabs restored from your last visit, stay private. |
| A snapshot opened as a copy | No, it is a private copy. |

Both automatic behaviours can be turned off in ComfyUI's settings under *RigShare*.

Only the tab on screen is live. Switch to another tab and you leave the room; switch back and you rejoin. If the room changed meanwhile, you get the current version.

## The panel

**Workflows** shows the tab on screen: whether it is live, who else is in it, and buttons for **Snapshot**, **History** and **Stop sharing**. Below that is the list of shared workflows, with the people in each one. Open any of them with the arrow.

**People** lists who is online and which workflow they are on. The eye button *follows* someone: it jumps to their tab and keeps your view on theirs until you click or scroll the canvas.

## What syncs, and how

- Moving and resizing nodes, widget values, titles, colours and bypass/mute apply in place for everyone.
- Adding or removing nodes, links, groups or subgraphs reloads the tab for the others. Their viewport is kept.
- A node someone is typing into is left alone until they are done.
- Two people editing the same node at once: the last change wins.
- Two people adding or connecting nodes at the same moment both keep their work. If both picked the same node or link id, the server renumbers the later one and quietly resyncs that person. Links and groups merge one by one, so a connection made by one person never erases another's.

Viewers (no *Edit* permission) see a read-only canvas. Anything they change locally is put back.

## Stop sharing

**Stop sharing** takes the tab out of its room and keeps working on a private copy.

- For an **admin**, if nobody else is in the room, it is also removed from the shared list, and a *Before unshare* snapshot is kept in its history.
- Otherwise, including for everyone who is not an admin, you just leave. It stays shared for the others.

Only admins can remove a shared workflow. Workflows nobody has open show a 🗑 button for them in the list. For a saved file, stopping sharing only applies to you. Anyone else who opens the file shares it again, unless they turned off automatic sharing.

Rooms nobody opens for 14 days are forgotten (`room_expiry_days`).

## Who can open it

By default everyone with an account can open a shared workflow, with their usual permissions. The **Access** button under *This tab* lets its owner, whoever shared it first, or any admin choose *Only people I choose* and give each person **Can view** or **Can edit**.

- The owner and admins always have access.
- A role can only narrow someone's account permissions: *Can edit* does nothing for an account without *Edit*.
- People who lose access are taken out of the workflow straight away; their tab stays open as a private copy.
- Without access, the workflow is gone from their list and from the People tab, and they cannot open it, its snapshots, or its file through ComfyUI.
- A 🔒 marks restricted workflows in the list.

Saved workflow files still show up by name in ComfyUI's workflow browser; opening one without access is refused.

## Snapshots

- Automatic every 5 minutes while a workflow is being edited (`snapshot_interval_sec`). The last 30 are kept (`snapshot_keep`).
- **Snapshot** saves a named one, which is never rotated out.
- **History** lists them. ↗ opens a private copy; ⟲ restores it for everyone, after first saving the current state as a snapshot.

## Saving

Shared state lives on the server, so an edited workflow survives even if nobody saves it. Saving (Ctrl+S) still writes the file as usual. The tab may look modified to others until they save or reload.
