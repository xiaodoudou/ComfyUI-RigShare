# Sharing workflows

Sharing follows folders, like a shared drive. There is nothing to share by hand: where a workflow is saved decides who works on it with you.

## Which tabs are live

| Tab | Live? |
|---|---|
| A workflow saved in **Shared** or at the top level of the workflows folder | Yes, while it is open. Everyone who opens the same file lands in the same room and edits it together. |
| A workflow in **My files** (your private folder) | No. Only you (and admins) can open it. |
| An unsaved tab | No. Save it outside your private folder to work on it with others. |
| A snapshot opened as a copy | No, it is a private copy. |

To take a private workflow live, move it out of *My files*: **Move to Shared…** in the panel, **Move to…** in the Files tab, or save it somewhere shared.

Only the tab on screen is live. Switch to another tab and you leave the room; switch back and you rejoin. If the workflow changed meanwhile, you get the current version.

## The panel

**Live** shows the tab on screen: whether it is live, who else is in it, and buttons for **Snapshot** and **History**. For a private or unsaved tab it says why it is not live. Below that is the list of **live workflows**: those someone has open right now, with their folder and the people in each one. Open any of them with the arrow. The Files tab marks live files with a green dot.

**People** lists who is online and which workflow they are on. The eye button *follows* someone: it jumps to their tab and keeps your view on theirs until you click or scroll the canvas.

## What syncs, and how

- Moving and resizing nodes, widget values, titles, colours and bypass/mute apply in place for everyone.
- Adding or removing nodes, links, groups or subgraphs reloads the tab for the others. Their viewport is kept.
- A node someone is typing into is left alone until they are done.
- Two people editing the same node at once: the last change wins.
- Two people adding or connecting nodes at the same moment both keep their work. If both picked the same node or link id, the server renumbers the later one and quietly resyncs that person. Links and groups merge one by one, so a connection made by one person never erases another's.

Viewers (no *Edit* permission) see a read-only canvas. Anything they change locally is put back.

## When a workflow stops being live

- When everyone closes it, it leaves the live list. The server keeps its latest state, so the next person to open it picks up where the others left off, saved or not. That state is forgotten after 14 days without anyone opening it (`room_expiry_days`).
- Renaming or moving it (or its folder) keeps it live: everyone who has it open follows it to the new name, and its history and access list go with it.
- Moving it into a private folder takes it out of live sharing straight away. Its owner's tab follows it; everyone else keeps a private copy.
- Deleting it (admins, or the owner of its shared folder) closes it for the people who have it open. Their tabs stay as private copies, and a *Before delete* snapshot is kept.

## Who can open it

By default everyone who can open its folder can open a live workflow, with their usual permissions. The **Access** button under *This tab* lets its owner (whoever opened it first) or any admin choose *Only people I choose* and give each person **Can view** or **Can edit**.

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
