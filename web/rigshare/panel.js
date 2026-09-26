// Sidebar panel: tabs for workflows, people, chat, server and admin, plus an
// account view (profile, password, API keys) behind the avatar button.

import { h, initials, timeAgo, clock, roleChips, meter, storage } from "./ui.js";
import { ServerWidget } from "./server-widget.js";

const ICON_URL = new URL("./assets/icon.svg", import.meta.url).href;

const VIEWS = [
    { id: "workflows", icon: "pi-share-alt", label: "Live" },
    { id: "files", icon: "pi-folder", label: "Files" },
    { id: "people", icon: "pi-users", label: "People" },
    { id: "chat", icon: "pi-comments", label: "Chat" },
    { id: "server", icon: "pi-server", label: "Server" },
    { id: "admin", icon: "pi-shield", label: "Admin", admin: true },
];

export class RigSharePanel {
    constructor(app, client, sync, presence) {
        this.app = app;
        this.client = client;
        this.sync = sync;
        this.presence = presence;
        this.visible = false;
        this.unread = 0;
        this.chatToasts = false;
        this.view = storage.get("rigshare.view") || "workflows";
        this.historyOpen = false;
        this.newKey = null;

        this.widget = new ServerWidget(client, () => this.render());

        this.header = h("div", { class: "rs-header" });
        this.nav = h("div", { class: "rs-nav", role: "tablist" });
        this.body = h("div", { class: "rs-body" });
        this.root = h("div", { class: "rs-panel" }, this.header, this.nav, this.body);

        this.chatLog = h("div", { class: "rs-chat-log" });
        this.chatInput = h("textarea", {
            class: "rs-input rs-chat-input", placeholder: "Message… (Enter to send)", maxLength: 1000, rows: 1,
            onkeydown: (e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.sendChat(); }
            },
        });
        this.chatView = h("div", { class: "rs-chat" }, this.chatLog,
            h("div", { class: "rs-chat-compose" }, this.chatInput,
                h("button", { class: "rs-btn rs-btn-primary rs-btn-icon", title: "Send", onclick: () => this.sendChat() }, h("i", { class: "pi pi-send" }))));

        client.on("status", () => this.render());
        client.on("self", () => this.render());
        client.on("presence", () => this.renderSoft());
        client.on("stats", () => { if (this.view === "server") this.renderBody(); });
        client.on("chat-history", () => this.renderChatLog());
        client.on("chat", (m) => this.onChat(m));
        sync.addEventListener("state", () => { if (this.view === "workflows") this.renderBody(); });
        presence.addEventListener("follow", () => { if (this.view === "people") this.renderBody(); });
        this.render();
    }

    // ----- sidebar lifecycle ---------------------------------------------

    mount(container) {
        container.classList.add("rs-host");
        container.append(this.root);
        this.visible = true;
        if (this.view === "chat") this.clearUnread();
        this.render();
    }

    unmount() {
        this.visible = false;
    }

    focusChat() {
        this.setView("chat");
        setTimeout(() => this.chatInput.focus(), 50);
    }

    setView(view) {
        this.view = view;
        storage.set("rigshare.view", view);
        if (view === "chat") this.clearUnread();
        this.render();
    }

    get badge() {
        return this.unread ? String(this.unread > 99 ? "99+" : this.unread) : null;
    }

    clearUnread() {
        if (!this.unread) return;
        this.unread = 0;
        this.onBadge?.(null);
    }

    toast(severity, detail, summary = "RigShare") {
        this.client.emit("toast", { severity, summary, detail });
    }

    async confirm(title, message) {
        const dialog = this.app.extensionManager?.dialog;
        if (dialog?.confirm) return !!(await dialog.confirm({ title, message }));
        return window.confirm(`${title}\n\n${message}`);
    }

    async prompt(title, message, defaultValue = "") {
        const dialog = this.app.extensionManager?.dialog;
        if (dialog?.prompt) return await dialog.prompt({ title, message, defaultValue });
        return window.prompt(`${title}\n\n${message}`, defaultValue);
    }

    async run(fn, okMessage) {
        try {
            const result = await fn();
            if (okMessage) this.toast("success", okMessage);
            return result;
        } catch (e) {
            this.toast("error", e.message || String(e));
            return undefined;
        }
    }

    // ----- frame ----------------------------------------------------------

    render() {
        this.renderHeader();
        this.renderNav();
        this.renderBody();
    }

    /** Presence changes: refresh counts and the current view if it shows people. */
    renderSoft() {
        this.renderNav();
        if (["workflows", "people"].includes(this.view)) this.renderBody();
    }

    renderHeader() {
        const c = this.client;
        const s = c.status;
        const label = { online: "Connected", connecting: "Connecting…", offline: "Offline", denied: "Signed out" }[s];
        const me = c.self;
        this.header.replaceChildren(...[
            h("div", { class: "rs-title" }, h("img", { class: "rs-logo", src: ICON_URL, alt: "" }),
                h("div", { class: "rs-title-text" },
                    h("div", { class: "rs-title-name" }, c.server?.name || "RigShare"),
                    h("div", { class: `rs-status rs-status-${s}` }, h("span", { class: "rs-dot" }), label))),
            me ? h("button", {
                class: `rs-me-btn ${this.view === "account" ? "active" : ""}`, title: `${me.name} — account & API keys`,
                onclick: () => this.setView(this.view === "account" ? "workflows" : "account"),
            }, h("span", { class: "rs-avatar rs-avatar-sm", style: `background:${me.color}` }, initials(me.name))) : null,
        ].filter(Boolean));
    }

    renderNav() {
        const c = this.client;
        const counts = {
            people: c.users.length || null,
            chat: this.unread || null,
            workflows: c.rooms?.length || null,
        };
        this.nav.replaceChildren(...VIEWS.filter((v) => !v.admin || c.perms.admin).map((v) =>
            h("button", {
                class: `rs-tab ${this.view === v.id ? "active" : ""}`, role: "tab", title: v.label,
                onclick: () => this.setView(v.id),
            }, h("i", { class: `pi ${v.icon}` }), h("span", { class: "rs-tab-label" }, v.label),
            counts[v.id] ? h("span", { class: `rs-count ${v.id === "chat" ? "hot" : ""}` }, counts[v.id]) : null)));
        this.nav.style.display = c.self ? "" : "none";
    }

    renderBody() {
        const c = this.client;
        this.body.classList.toggle("rs-body-chat", this.view === "chat" && !!c.self);
        if (!c.self) {
            const failing = c.retry >= 2 && c.status !== "denied";
            this.body.replaceChildren(h("div", { class: "rs-empty" },
                h("i", { class: "pi pi-spin pi-spinner" }),
                c.status === "denied" ? "Signed out — redirecting to login…" : c.status === "connecting" ? "Connecting…" : "Server unreachable, retrying…",
                failing ? h("div", { class: "rs-small rs-hint" },
                    "Can't open the live connection. If ComfyUI is behind a reverse proxy, enable WebSocket support for it (Nginx Proxy Manager: ",
                    h("b", {}, "Websockets Support"), ").") : null));
            return;
        }
        const views = {
            workflows: () => this.workflowsView(),
            files: () => this.filesView(),
            people: () => this.peopleView(),
            chat: () => [this.chatView],
            server: () => this.serverView(),
            admin: () => this.adminView(),
            account: () => this.accountView(),
        };
        if (this.view === "admin" && !c.perms.admin) this.view = "workflows";
        const scroll = this.body.scrollTop;
        this.body.replaceChildren(...(views[this.view] ?? views.workflows)().filter(Boolean));
        this.body.scrollTop = scroll;
        if (this.view === "chat") this.scrollChat();
    }

    section(icon, title, ...children) {
        return h("section", { class: "rs-section" },
            h("div", { class: "rs-section-title" }, h("i", { class: `pi ${icon}` }), title), ...children);
    }

    // ----- workflows ------------------------------------------------------

    workflowsView() {
        return [this.currentTabSection(), this.roomsSection()];
    }

    currentTabSection() {
        const c = this.client;
        const s = this.sync;
        const wf = s.store?.activeWorkflow;
        if (!wf) return this.section("pi-file", "This tab", h("p", { class: "rs-muted" }, "No tab open."));
        const room = s.target;
        const head = h("div", { class: "rs-tab-head" },
            h("div", { class: "rs-name" }, s.tabName(wf)),
            wf.isTemporary ? h("span", { class: "rs-chip" }, "unsaved") : null);
        const row = h("div", { class: "rs-actions" });
        const body = [head];
        if (!room) {
            body.push(h("p", { class: "rs-muted" }, wf.isTemporary
                ? "Private until you edit it or share it."
                : "Private — not synced with others."));
            row.append(h("button", { class: "rs-btn rs-btn-primary", onclick: () => s.shareCurrent() }, h("i", { class: "pi pi-share-alt" }), "Share this tab"));
        } else {
            const here = c.users.filter((u) => u.room === room.key);
            const last = s.lastEditor && Date.now() - s.lastEditor.at < 60000 ? ` · ${s.lastEditor.name} editing` : "";
            body.push(h("div", { class: "rs-live-row" },
                s.live
                    ? h("span", { class: "rs-live" }, h("span", { class: "rs-live-dot" }), `Live · rev ${s.version}${last}`)
                    : h("span", { class: "rs-live rs-muted" }, h("i", { class: "pi pi-spin pi-spinner" }), "Joining…"),
                h("span", { class: "rs-avatars" }, ...here.map((u) => h("span", { class: "rs-avatar rs-avatar-xs", style: `background:${u.color}`, title: u.name }, initials(u.name))))));
            body.push(this.accessLine());
            if (this.accessOpen && s.room?.manage) body.push(this.accessEditor());
            if (!s.canEdit) body.push(h("p", { class: "rs-note" }, h("i", { class: "pi pi-lock" }), c.perms.edit ? "View only in this workflow." : "View only — ask an admin for edit access."));
            if (s.canEdit) {
                row.append(h("button", {
                    class: "rs-btn", title: "Save a named snapshot", onclick: async () => {
                        const label = await this.prompt("Snapshot", "Name this snapshot", `Snapshot ${new Date().toLocaleString()}`);
                        if (label === null || label === undefined) return;
                        await this.run(() => c.request("POST", "/rigshare/api/snapshots", { room: room.key, label: label || "Manual" }), "Snapshot saved");
                        if (this.historyOpen) this.loadHistory();
                    },
                }, h("i", { class: "pi pi-camera" }), "Snapshot"));
            }
            row.append(
                h("button", { class: `rs-btn ${this.historyOpen ? "active" : ""}`, onclick: () => { this.historyOpen = !this.historyOpen; this.renderBody(); if (this.historyOpen) this.loadHistory(); } },
                    h("i", { class: "pi pi-history" }), "History"),
                h("button", { class: "rs-btn rs-btn-ghost", title: c.perms.admin ? "Stop sharing this tab (removed from the list if nobody else is in it)" : "Leave: stop syncing this tab and keep a private copy", onclick: () => s.unshareCurrent() },
                    h("i", { class: "pi pi-eye-slash" }), "Stop sharing"));
        }
        this.historyEl ??= h("div", { class: "rs-history" });
        return this.section("pi-file", "This tab", ...body, row, room && this.historyOpen ? this.historyEl : null);
    }

    accessLine() {
        const s = this.sync;
        const info = s.room;
        if (!info) return null;
        const owner = info.owner ? this.client.users.find((u) => u.key === info.owner)?.name ?? `@${info.owner}` : null;
        return h("div", { class: "rs-access" },
            h("i", { class: `pi ${info.restricted ? "pi-lock" : "pi-globe"}` }),
            h("span", { class: "rs-grow" }, info.restricted ? "Only people with access" : "Everyone can open it",
                owner ? h("span", { class: "rs-muted" }, ` · owner ${owner}`) : null),
            info.manage ? h("button", {
                class: `rs-btn rs-btn-sm ${this.accessOpen ? "active" : ""}`,
                onclick: () => { this.accessOpen = !this.accessOpen; this.accessDraft = null; this.renderBody(); },
            }, "Access") : null);
    }

    accessEditor() {
        const key = this.sync.targetKey;
        return this.accessEditorFor({
            load: () => this.client.request("GET", `/rigshare/api/room/acl?key=${encodeURIComponent(key)}`),
            save: (restricted, members) => this.sync.setAccess(restricted, members),
            everyoneHint: "Anyone with an account can open it, with their usual permissions",
            close: () => { this.accessOpen = false; this.accessDraft = null; this.renderBody(); },
            draftKey: "accessDraft",
        });
    }

    /** Access editor shared by live workflows and shared folders. */
    accessEditorFor({ load, save, everyoneHint, close, draftKey }) {
        const box = h("div", { class: "rs-access-editor" }, h("p", { class: "rs-muted" }, "Loading…"));
        Promise.all([this.run(load), this.run(() => this.client.request("GET", "/rigshare/api/people"))]).then(([acl, people]) => {
            if (!acl || !people) return;
            const draft = this[draftKey] ??= { restricted: acl.restricted, members: { ...acl.members } };
            const render = () => {
                const fixed = people.filter((p) => p.username === acl.owner || p.admin);
                const choosable = people.filter((p) => p.username !== acl.owner && !p.admin);
                const fixedRows = fixed.map((p) => h("div", { class: "rs-row-item" },
                    h("div", { class: "rs-grow rs-min0 rs-ellipsis" }, p.display_name, h("span", { class: "rs-muted" }, ` @${p.username}`)),
                    h("span", { class: "rs-chip" }, p.username === acl.owner ? "Owner · always" : "Admin · always")));
                const rows = choosable.map((p) => {
                    const select = h("select", {
                        class: "rs-input rs-select", disabled: !draft.restricted,
                        onchange: (e) => { if (e.target.value) draft.members[p.username] = e.target.value; else delete draft.members[p.username]; },
                    }, ...[["", "No access"], ["view", "Can view"], ["edit", "Can edit"]].map(([v, label]) =>
                        h("option", { value: v, selected: (draft.members[p.username] || "") === v }, label)));
                    return h("div", { class: "rs-row-item" },
                        h("div", { class: "rs-grow rs-min0 rs-ellipsis" }, p.display_name, h("span", { class: "rs-muted" }, ` @${p.username}`),
                            p.edit ? null : h("span", { class: "rs-muted rs-small" }, " · viewer account")),
                        select);
                });
                const name = `rs-access-${draftKey}`;
                const radio = (value, label, hint) => h("label", { class: "rs-check rs-block" },
                    h("input", { type: "radio", name, checked: draft.restricted === value, onchange: () => { draft.restricted = value; render(); } }),
                    h("span", {}, label, h("div", { class: "rs-muted rs-small" }, hint)));
                box.replaceChildren(...[
                    radio(false, "Everyone", everyoneHint),
                    radio(true, "Only people I choose", "The owner and admins always have access"),
                    draft.restricted ? h("div", { class: "rs-access-list" }, ...fixedRows, ...rows,
                        rows.length ? null : h("p", { class: "rs-muted rs-small" },
                            "Everyone else is an admin, and admins always have access. Add accounts without Admin under Admin → Accounts to choose who can open it.")) : null,
                    h("div", { class: "rs-actions" },
                        h("button", {
                            class: "rs-btn rs-btn-primary", onclick: async () => {
                                const ok = await this.run(() => save(draft.restricted, draft.restricted ? draft.members : {}), "Access updated");
                                if (ok !== undefined) { this[draftKey] = null; close(); }
                            },
                        }, "Save"),
                        h("button", { class: "rs-btn rs-btn-ghost", onclick: () => { this[draftKey] = null; close(); } }, "Cancel")),
                ].filter(Boolean));
            };
            render();
        });
        return box;
    }

    async loadHistory() {
        const room = this.sync.target;
        if (!room) return;
        this.historyEl.replaceChildren(h("p", { class: "rs-muted" }, "Loading…"));
        const snaps = await this.run(() => this.client.request("GET", `/rigshare/api/snapshots?room=${encodeURIComponent(room.key)}`));
        if (!snaps) return;
        if (!snaps.length) {
            this.historyEl.replaceChildren(h("p", { class: "rs-muted" }, "No snapshots yet. They are taken automatically every few minutes while people edit."));
            return;
        }
        this.historyEl.replaceChildren(...snaps.map((snap) => h("div", { class: "rs-row-item" },
            h("div", { class: "rs-grow rs-min0" },
                h("div", { class: "rs-ellipsis" }, snap.label || "Auto", h("span", { class: "rs-muted" }, ` · ${snap.nodes} nodes`)),
                h("div", { class: "rs-muted rs-small" }, `${timeAgo(snap.time * 1000)} · ${snap.author}`)),
            h("button", { class: "rs-btn rs-btn-icon", title: "Open a private copy", onclick: () => this.openSnapshot(snap) }, h("i", { class: "pi pi-external-link" })),
            this.sync.canEdit ? h("button", {
                class: "rs-btn rs-btn-icon", title: "Restore for everyone", onclick: async () => {
                    if (!(await this.confirm("Restore snapshot", `Restore "${snap.label || "Auto"}" for everyone in this workflow?`))) return;
                    await this.run(() => this.client.request("POST", `/rigshare/api/snapshots/${snap.id}/restore`), "Snapshot restored");
                    this.loadHistory();
                },
            }, h("i", { class: "pi pi-replay" })) : null)));
    }

    async openSnapshot(snap) {
        const data = await this.run(() => this.client.request("GET", `/rigshare/api/snapshots/${snap.id}`));
        if (!data) return;
        const doc = structuredClone(data.doc);
        if (doc.extra) delete doc.extra.rigshare; // a private copy, not the live room
        await this.app.loadGraphData(doc, true, true, `${snap.room_name || "Snapshot"} (${snap.label || snap.id}).json`);
    }

    roomsSection() {
        const c = this.client;
        const rooms = c.rooms || [];
        const byId = new Map(c.users.map((u) => [u.id, u]));
        const rows = rooms.map((r) => {
            const here = r.key === this.sync.targetKey;
            const members = r.members.map((id) => byId.get(id)).filter(Boolean);
            return h("div", { class: `rs-row-item rs-room ${here ? "here" : ""}`, title: r.key.replace(/^file:workflows\//, "") },
                h("i", { class: `pi ${r.kind === "file" ? "pi-file" : "pi-file-edit"} rs-row-icon` }),
                h("div", { class: "rs-grow rs-min0" },
                    h("div", { class: "rs-name rs-ellipsis" }, r.name, r.restricted ? h("i", { class: "pi pi-lock rs-inline-icon rs-muted", title: "Restricted" }) : null),
                    members.length
                        ? h("div", { class: "rs-avatars" }, ...members.map((u) => h("span", { class: "rs-avatar rs-avatar-xs", style: `background:${u.color}`, title: u.name }, initials(u.name))))
                        : h("div", { class: "rs-muted rs-small" }, `${timeAgo(r.updated * 1000)} · ${r.nodes} nodes`)),
                !here && !members.length && c.perms.admin ? h("button", {
                    class: "rs-btn rs-btn-icon rs-danger", title: "Stop sharing (remove from this list)",
                    onclick: async () => {
                        if (!(await this.confirm("Stop sharing", `Remove "${r.name}" from the shared workflows? A snapshot is kept in its history.`))) return;
                        await this.run(() => c.request("DELETE", `/rigshare/api/room?key=${encodeURIComponent(r.key)}`), `"${r.name}" is no longer shared`);
                    },
                }, h("i", { class: "pi pi-trash" })) : null,
                here ? h("span", { class: "rs-chip rs-chip-edit" }, "open") : h("button", {
                    class: "rs-btn rs-btn-icon", title: "Open",
                    onclick: () => this.run(() => this.sync.openRoom(r)),
                }, h("i", { class: "pi pi-arrow-right" })));
        });
        return this.section("pi-share-alt", "Shared workflows",
            ...(rows.length ? rows : [h("p", { class: "rs-muted" }, "Nothing shared yet. Open a saved workflow or edit a tab.")]));
    }

    // ----- files ----------------------------------------------------------

    filesView() {
        this.filesEl ??= h("div", {});
        this.loadFiles();
        return [this.filesEl];
    }

    async loadFiles() {
        const tree = await this.run(() => this.client.request("GET", "/rigshare/api/workspace"));
        if (!tree) return;
        this.tree = tree;
        const destinations = [
            tree.private ? { folder: tree.private.path, label: "My files" } : null,
            ...tree.shared.filter((f) => f.role === "edit").map((f) => ({ folder: f.path, label: f.name })),
            tree.common.role === "edit" ? { folder: "", label: "Common" } : null,
        ].filter(Boolean);

        const fileRow = (file, folder, canMoveOut) => h("div", { class: "rs-row-item rs-file" },
            h("i", { class: "pi pi-file rs-row-icon" }),
            h("div", { class: "rs-grow rs-min0" },
                h("div", { class: "rs-name rs-ellipsis", title: file.path.slice("workflows/".length) }, file.name.replace(/\.json$/, "")),
                h("div", { class: "rs-muted rs-small" }, timeAgo(file.modified * 1000))),
            canMoveOut && destinations.length > 1 ? h("select", {
                class: "rs-input rs-select", title: "Move to another folder",
                onchange: async (e) => {
                    const dest = e.target.value;
                    e.target.value = "__";
                    if (dest === "__") return;
                    const base = file.path.split("/").pop();
                    const target = dest ? `workflows/${dest}/${base}` : `workflows/${base}`;
                    await this.run(() => this.sync.movePath(file.path, target), "Moved");
                    this.loadFiles();
                },
            }, h("option", { value: "__" }, "Move to…"), ...destinations.filter((d) => d.folder !== folder).map((d) =>
                h("option", { value: d.folder }, d.label))) : null,
            h("button", { class: "rs-btn rs-btn-icon", title: "Open", onclick: () => this.run(() => this.sync.openPath(file.path)) },
                h("i", { class: "pi pi-arrow-right" })));

        const empty = (text) => h("p", { class: "rs-muted rs-small" }, text);
        const sections = [];
        if (tree.private) {
            sections.push(this.section("pi-user", "My files",
                h("p", { class: "rs-muted rs-small" }, "Only you (and admins) can see these."),
                ...(tree.private.files.length ? tree.private.files.map((f) => fileRow(f, tree.private.path, true)) : [empty("Nothing here yet. Save a workflow and choose My files.")])));
        }

        const folderBlocks = tree.shared.map((f) => {
            const open = this.openFolders?.has(f.path);
            const owner = f.owner ? this.client.users.find((u) => u.key === f.owner)?.name ?? `@${f.owner}` : null;
            const head = h("div", { class: "rs-row-item rs-folder" },
                h("button", { class: "rs-btn rs-btn-icon rs-btn-ghost", title: open ? "Collapse" : "Expand", onclick: () => {
                    this.openFolders ??= new Set();
                    open ? this.openFolders.delete(f.path) : this.openFolders.add(f.path);
                    this.loadFiles();
                } }, h("i", { class: `pi ${open ? "pi-chevron-down" : "pi-chevron-right"}` })),
                h("i", { class: `pi ${f.restricted ? "pi-lock" : "pi-folder"} rs-row-icon` }),
                h("div", { class: "rs-grow rs-min0" },
                    h("div", { class: "rs-name rs-ellipsis" }, f.name),
                    h("div", { class: "rs-muted rs-small" }, `${f.files.length} workflow${f.files.length === 1 ? "" : "s"}${owner ? ` · owner ${owner}` : ""}${f.role === "view" ? " · view only" : ""}`)),
                f.manage ? h("button", { class: `rs-btn rs-btn-sm ${this.folderAccess === f.path ? "active" : ""}`, onclick: () => {
                    this.folderAccess = this.folderAccess === f.path ? null : f.path;
                    this.folderDraft = null;
                    this.loadFiles();
                } }, "Access") : null,
                f.manage ? h("button", { class: "rs-btn rs-btn-icon", title: "Rename folder", onclick: async () => {
                    const name = await this.prompt("Rename folder", `New name for "${f.name}"`, f.name);
                    if (!name || name === f.name) return;
                    await this.run(() => this.client.request("PATCH", "/rigshare/api/workspace/folders", { path: f.path, name }), "Folder renamed");
                    this.loadFiles();
                } }, h("i", { class: "pi pi-pencil" })) : null,
                f.manage ? h("button", { class: "rs-btn rs-btn-icon rs-danger", title: "Delete folder (must be empty)", onclick: async () => {
                    if (!(await this.confirm("Delete folder", `Delete the empty folder "${f.name}"?`))) return;
                    await this.run(() => this.client.request("DELETE", `/rigshare/api/workspace/folders?path=${encodeURIComponent(f.path)}`), "Folder deleted");
                    this.loadFiles();
                } }, h("i", { class: "pi pi-trash" })) : null);
            const parts = [head];
            if (this.folderAccess === f.path) {
                parts.push(this.accessEditorFor({
                    load: async () => {
                        const t = await this.client.request("GET", "/rigshare/api/workspace");
                        const folder = t.shared.find((x) => x.path === f.path);
                        const members = await this.client.request("GET", `/rigshare/api/workspace/folder?path=${encodeURIComponent(f.path)}`);
                        return { owner: folder?.owner, restricted: !!folder?.restricted, members: members.members || {} };
                    },
                    save: (restricted, members) => this.client.request("PATCH", "/rigshare/api/workspace/folders", { path: f.path, restricted, members }),
                    everyoneHint: "Anyone with an account can open its workflows, with their usual permissions",
                    close: () => { this.folderAccess = null; this.loadFiles(); },
                    draftKey: "folderDraft",
                }));
            }
            if (open) {
                parts.push(h("div", { class: "rs-folder-files" },
                    ...(f.files.length ? f.files.map((file) => fileRow(file, f.path, f.manage)) : [empty("Empty folder.")])));
            }
            return h("div", { class: "rs-folder-block" }, ...parts);
        });
        const newFolderBtn = tree.can_create ? h("button", { class: "rs-btn", onclick: async () => {
            const name = await this.prompt("New shared folder", "Folder name");
            if (!name) return;
            await this.run(() => this.client.request("POST", "/rigshare/api/workspace/folders", { name }), "Folder created");
            this.loadFiles();
        } }, h("i", { class: "pi pi-folder-plus" }), "New shared folder") : null;
        sections.push(this.section("pi-folder", "Shared folders",
            ...(folderBlocks.length ? folderBlocks : [empty("No shared folders yet.")]),
            newFolderBtn ? h("div", { class: "rs-actions" }, newFolderBtn) : null));

        sections.push(this.section("pi-globe", "Common",
            h("p", { class: "rs-muted rs-small" }, "Top-level workflows, visible to everyone."),
            ...(tree.common.files.length ? tree.common.files.map((f) => fileRow(f, "", this.client.perms.admin)) : [empty("No workflows at the top level.")])));
        this.filesEl.replaceChildren(...sections);
    }

    // ----- people ---------------------------------------------------------

    peopleView() {
        const c = this.client;
        const isAdmin = c.perms.admin;
        const users = [...c.users].sort((a, b) => (a.id === c.self.id ? -1 : b.id === c.self.id ? 1 : a.joined - b.joined));
        const rows = users.map((u) => {
            const self = u.id === c.self.id;
            const following = this.presence.following === u.id;
            const toggles = [];
            if (isAdmin && !self && !u.perms.admin) {
                for (const perm of ["edit", "queue", "manager"]) {
                    toggles.push(h("button", {
                        class: `rs-toggle ${u.perms[perm] ? "on" : ""}`,
                        title: `${u.perms[perm] ? "Revoke" : "Grant"} ${perm} permission${u.kind === "guest" ? "" : ` for @${u.key}`}`,
                        onclick: () => this.setPerm(u, perm, !u.perms[perm]),
                    }, { edit: "Edit", queue: "Queue", manager: "Manager" }[perm]));
                }
            }
            const where = c.rooms.find((r) => r.key === u.room)?.name;
            return h("div", { class: "rs-row-item rs-person" },
                h("span", { class: "rs-avatar", style: `background:${u.color}` }, initials(u.name)),
                h("div", { class: "rs-grow rs-min0" },
                    h("div", { class: "rs-name rs-ellipsis" }, u.name, self ? h("span", { class: "rs-muted" }, " (you)") : null,
                        u.idle ? h("i", { class: "pi pi-moon rs-muted rs-inline-icon", title: "Away" }) : null),
                    h("div", { class: "rs-chips" }, ...(toggles.length ? toggles : roleChips(u.perms))),
                    h("div", { class: "rs-where" }, h("i", { class: `pi ${where ? "pi-file" : "pi-lock"}` }), h("span", { class: "rs-ellipsis" }, where ?? "private tab"))),
                self ? null : h("button", {
                    class: `rs-btn rs-btn-icon ${following ? "rs-btn-primary" : ""}`,
                    title: following ? "Stop following" : `Follow ${u.name} (jump to their tab and view)`,
                    onclick: () => this.presence.follow(following ? null : u.id),
                }, h("i", { class: following ? "pi pi-eye-slash" : "pi pi-eye" })));
        });
        return [this.section("pi-users", `Online (${users.length})`, ...rows)];
    }

    async setPerm(user, perm, value) {
        const perms = { [perm]: value };
        if (user.kind === "user") await this.run(() => this.client.request("PATCH", `/rigshare/api/users/${encodeURIComponent(user.key)}`, { perms }));
        else await this.run(() => this.client.request("POST", `/rigshare/api/guests/${encodeURIComponent(user.guest_id)}`, perms));
    }

    // ----- chat -----------------------------------------------------------

    sendChat() {
        const text = this.chatInput.value.trim();
        if (!text) return;
        if (this.client.send({ type: "chat", text })) this.chatInput.value = "";
    }

    chatLine(m) {
        if (m.system) return h("div", { class: "rs-msg rs-msg-system" }, h("span", { class: "rs-time" }, clock(m.ts)), m.text);
        const mine = m.from === this.client.self?.id;
        return h("div", { class: `rs-msg ${mine ? "mine" : ""}` },
            h("div", { class: "rs-msg-head" },
                h("span", { class: "rs-msg-name", style: `color:${m.color}` }, m.name),
                h("span", { class: "rs-time" }, clock(m.ts))),
            h("div", { class: "rs-msg-text" }, m.text));
    }

    renderChatLog() {
        this.chatLog.replaceChildren(...this.client.chat.slice(-200).map((m) => this.chatLine(m)));
        this.scrollChat();
    }

    scrollChat() {
        requestAnimationFrame(() => { this.chatLog.scrollTop = this.chatLog.scrollHeight; });
    }

    onChat(m) {
        const atBottom = this.chatLog.scrollHeight - this.chatLog.scrollTop - this.chatLog.clientHeight < 40;
        this.chatLog.append(this.chatLine(m));
        while (this.chatLog.childElementCount > 300) this.chatLog.firstChild.remove();
        if (atBottom || m.from === this.client.self?.id) this.scrollChat();
        const seen = this.visible && this.view === "chat" && !document.hidden;
        if (!seen && !m.system && m.from !== this.client.self?.id) {
            this.unread++;
            this.onBadge?.(this.badge);
            this.onNotify?.(m);
            if (this.chatToasts && !this.visible) this.toast("info", m.text, m.name);
            this.renderNav();
        }
    }

    // ----- server ---------------------------------------------------------

    serverView() {
        const st = this.client.stats;
        const floating = this.widget.enabled;
        const pop = h("button", {
            class: `rs-btn ${floating ? "active" : ""}`, title: "Show a small floating monitor over the canvas",
            onclick: () => this.widget.toggle(),
        }, h("i", { class: "pi pi-window-maximize" }), floating ? "Floating: on" : "Pop out");
        if (!st) return [this.section("pi-server", "Server", h("p", { class: "rs-muted" }, "Waiting for data…"), pop)];
        const items = [];
        if (st.cpu != null) items.push(meter("CPU", st.cpu, `${Math.round(st.cpu)}%`));
        if (st.ram_total) items.push(meter("RAM", (st.ram_used / st.ram_total) * 100, `${st.ram_used} / ${st.ram_total} GB`));
        const gpus = (st.gpus || []).map((g) => {
            const extra = [g.temp != null ? `${g.temp}°C` : null, g.power != null ? `${g.power} / ${g.power_limit} W` : null].filter(Boolean).join(" · ");
            return h("div", { class: "rs-gpu" },
                h("div", { class: "rs-gpu-name" }, h("span", {}, `GPU ${g.index} · ${g.name}`), h("span", { class: "rs-muted" }, extra)),
                meter("Load", g.util, `${g.util}%`),
                meter("VRAM", (g.vram_used / g.vram_total) * 100, `${g.vram_used.toFixed(1)} / ${g.vram_total.toFixed(0)} GB`));
        });
        const q = st.queue;
        const queue = q ? h("div", { class: "rs-queue-line" }, h("i", { class: "pi pi-list" }),
            q.running || q.pending ? `${q.running} running · ${q.pending} queued` : "Queue idle") : null;
        return [this.section("pi-server", "Server", queue, ...items, h("div", { class: "rs-actions" }, pop)),
            gpus.length ? this.section("pi-bolt", "GPUs", ...gpus) : null].filter(Boolean);
    }

    // ----- account --------------------------------------------------------

    accountView() {
        const me = this.client.self;
        const profile = this.section("pi-user", "Profile",
            h("div", { class: "rs-me" },
                h("span", { class: "rs-avatar rs-avatar-lg", style: `background:${me.color}` }, initials(me.name)),
                h("div", { class: "rs-grow rs-min0" },
                    h("div", { class: "rs-name" }, me.name),
                    h("div", { class: "rs-muted rs-small" }, me.key ? `@${me.key}` : "guest"),
                    h("div", { class: "rs-chips" }, ...roleChips(me.perms)))),
            me.kind === "user" ? this.profileForm(me) : null,
            h("div", { class: "rs-actions" },
                h("button", { class: "rs-btn", onclick: () => this.client.logout() }, h("i", { class: "pi pi-sign-out" }), "Log out")));
        const out = [profile];
        if (me.kind === "user") {
            out.push(this.passwordSection());
            this.keysEl ??= h("div", {});
            out.push(this.section("pi-key", "API keys",
                h("p", { class: "rs-muted rs-small" }, "Use a key to call the ComfyUI API from scripts or other apps with your permissions: ",
                    h("code", {}, "Authorization: Bearer <key>")),
                this.newKey ? h("div", { class: "rs-newkey" },
                    h("div", { class: "rs-small" }, "Copy it now — it will not be shown again."),
                    h("div", { class: "rs-row" }, h("code", { class: "rs-grow rs-keytext" }, this.newKey),
                        h("button", { class: "rs-btn rs-btn-icon", title: "Copy", onclick: async () => { await navigator.clipboard?.writeText(this.newKey); this.toast("success", "Copied"); } }, h("i", { class: "pi pi-copy" })))) : null,
                this.keysEl, this.keyForm()));
            this.loadKeys();
        }
        return out;
    }

    profileForm(me) {
        const display = h("input", { class: "rs-input", value: me.name, maxLength: 32 });
        return h("form", {
            class: "rs-form", onkeydown: (e) => e.stopPropagation(),
            onsubmit: async (e) => {
                e.preventDefault();
                await this.run(() => this.client.request("POST", "/rigshare/api/me", { display_name: display.value.trim() }), "Display name saved");
            },
        }, h("label", { class: "rs-label" }, "Display name"),
        h("div", { class: "rs-row" }, display, h("button", { class: "rs-btn", type: "submit" }, "Save")));
    }

    passwordSection() {
        const cur = h("input", { class: "rs-input", type: "password", placeholder: "Current password", autocomplete: "current-password" });
        const next = h("input", { class: "rs-input", type: "password", placeholder: "New password (min 8)", autocomplete: "new-password" });
        return this.section("pi-lock", "Password", h("form", {
            class: "rs-form", onkeydown: (e) => e.stopPropagation(),
            onsubmit: async (e) => {
                e.preventDefault();
                const res = await this.run(() => this.client.request("POST", "/rigshare/api/me",
                    { current_password: cur.value, new_password: next.value }), "Password changed; other sessions were signed out");
                if (res?.token) this.client.setToken(res.token);
                if (res) { cur.value = ""; next.value = ""; }
            },
        }, cur, next, h("button", { class: "rs-btn", type: "submit" }, "Change password")));
    }

    async loadKeys() {
        const keys = await this.run(() => this.client.request("GET", "/rigshare/api/me/keys"));
        if (!keys) return;
        this.keysEl.replaceChildren(...keys.map((k) => h("div", { class: "rs-row-item" },
            h("i", { class: "pi pi-key rs-row-icon" }),
            h("div", { class: "rs-grow rs-min0" },
                h("div", { class: "rs-name rs-ellipsis" }, k.name),
                h("div", { class: "rs-muted rs-small" }, `${k.hint} · ${k.last_used ? `used ${timeAgo(k.last_used * 1000)}` : "never used"}`)),
            h("button", {
                class: "rs-btn rs-btn-icon rs-danger", title: "Revoke", onclick: async () => {
                    if (!(await this.confirm("Revoke API key", `Revoke "${k.name}"? Apps using it stop working.`))) return;
                    await this.run(() => this.client.request("DELETE", `/rigshare/api/me/keys/${k.id}`), "Key revoked");
                    this.loadKeys();
                },
            }, h("i", { class: "pi pi-trash" })))));
    }

    keyForm() {
        const name = h("input", { class: "rs-input", placeholder: "Key name, e.g. Open WebUI", maxLength: 40 });
        return h("form", {
            class: "rs-form", onkeydown: (e) => e.stopPropagation(),
            onsubmit: async (e) => {
                e.preventDefault();
                const res = await this.run(() => this.client.request("POST", "/rigshare/api/me/keys", { name: name.value.trim() || "API key" }));
                if (res) { this.newKey = res.key; this.renderBody(); }
            },
        }, h("div", { class: "rs-row" }, name, h("button", { class: "rs-btn rs-btn-primary", type: "submit" }, h("i", { class: "pi pi-plus" }), "Create")));
    }

    // ----- admin ----------------------------------------------------------

    adminView() {
        this.adminAccounts ??= h("div", {});
        this.adminSettings ??= h("div", {});
        this.loadAdmin();
        return [
            this.section("pi-users", "Accounts", this.adminAccounts, this.createAccountForm()),
            this.section("pi-cog", "Server settings", this.adminSettings),
        ];
    }

    async loadAdmin() {
        const [users, config] = await Promise.all([
            this.run(() => this.client.request("GET", "/rigshare/api/users")),
            this.run(() => this.client.request("GET", "/rigshare/api/config")),
        ]);
        if (users) this.adminAccounts.replaceChildren(...users.map((u) => this.accountRow(u)));
        if (config) this.adminSettings.replaceChildren(this.configForm(config));
    }

    accountRow(u) {
        const me = u.username === this.client.self?.key;
        const toggle = (perm, label) => u.perms.admin && perm !== "admin" ? h("button", {
            class: "rs-toggle on locked", disabled: true, title: `Admins always have ${label}. Remove Admin to control it.`,
        }, label) : h("button", {
            class: `rs-toggle ${u.perms[perm] ? "on" : ""}`, title: `Toggle ${label}`,
            onclick: async () => {
                await this.run(() => this.client.request("PATCH", `/rigshare/api/users/${encodeURIComponent(u.username)}`, { perms: { [perm]: !u.perms[perm] } }));
                this.loadAdmin();
            },
        }, label);
        return h("div", { class: "rs-row-item" },
            h("div", { class: "rs-grow rs-min0" },
                h("div", { class: "rs-name rs-ellipsis" }, u.display_name, h("span", { class: "rs-muted" }, ` @${u.username}${me ? " (you)" : ""}`)),
                h("div", { class: "rs-chips" }, toggle("edit", "Edit"), toggle("queue", "Queue"), toggle("manager", "Manager"), toggle("admin", "Admin"))),
            h("button", {
                class: "rs-btn rs-btn-icon", title: "Change display name", onclick: async () => {
                    const name = await this.prompt("Display name", `Name shown to others for @${u.username}${me ? " (you)" : ""}`, u.display_name);
                    if (name == null || name.trim() === u.display_name) return;
                    const ok = await this.run(() => this.client.request("PATCH", `/rigshare/api/users/${encodeURIComponent(u.username)}`, { display_name: name.trim() }), "Display name saved");
                    if (ok) this.loadAdmin();
                },
            }, h("i", { class: "pi pi-id-card" })),
            h("button", {
                class: "rs-btn rs-btn-icon", title: "Change login username", onclick: async () => {
                    const name = await this.prompt("Change username", `New login username for @${u.username}${me ? " (you)" : ""}. Letters, digits, _ . -`, u.username);
                    if (!name || name.trim() === u.username) return;
                    const ok = await this.run(() => this.client.request("PATCH", `/rigshare/api/users/${encodeURIComponent(u.username)}`, { username: name.trim() }), `Renamed to @${name.trim()}`);
                    if (ok) this.loadAdmin();
                },
            }, h("i", { class: "pi pi-pencil" })),
            h("button", {
                class: "rs-btn rs-btn-icon", title: "Set password", onclick: async () => {
                    const pw = await this.prompt("Set password", `New password for @${u.username} (min 8 characters)`);
                    if (!pw) return;
                    await this.run(() => this.client.request("PATCH", `/rigshare/api/users/${encodeURIComponent(u.username)}`, { password: pw }), "Password changed; their sessions were signed out");
                },
            }, h("i", { class: "pi pi-key" })),
            me ? null : h("button", {
                class: "rs-btn rs-btn-icon rs-danger", title: "Delete account", onclick: async () => {
                    if (!(await this.confirm("Delete account", `Delete @${u.username}? This cannot be undone.`))) return;
                    await this.run(() => this.client.request("DELETE", `/rigshare/api/users/${encodeURIComponent(u.username)}`), "Account deleted");
                    this.loadAdmin();
                },
            }, h("i", { class: "pi pi-trash" })));
    }

    createAccountForm() {
        const username = h("input", { class: "rs-input", placeholder: "Username", autocomplete: "off" });
        const display = h("input", { class: "rs-input", placeholder: "Display name (optional)", autocomplete: "off" });
        const password = h("input", { class: "rs-input", placeholder: "Password (min 8)", type: "password", autocomplete: "new-password" });
        const check = (label, checked) => { const box = h("input", { type: "checkbox", checked }); return [box, h("label", { class: "rs-check" }, box, label)]; };
        const [edit, editL] = check("Edit", true);
        const [queue, queueL] = check("Queue", true);
        const [manager, managerL] = check("Manager", false);
        const [admin, adminL] = check("Admin", false);
        return h("details", { class: "rs-details" }, h("summary", {}, h("i", { class: "pi pi-user-plus" }), "New account"),
            h("form", {
                class: "rs-form", onkeydown: (e) => e.stopPropagation(),
                onsubmit: async (e) => {
                    e.preventDefault();
                    const ok = await this.run(() => this.client.request("POST", "/rigshare/api/users", {
                        username: username.value.trim(), password: password.value, display_name: display.value.trim() || null,
                        perms: { edit: edit.checked, queue: queue.checked, manager: manager.checked, admin: admin.checked },
                    }), "Account created");
                    if (ok) { username.value = display.value = password.value = ""; this.loadAdmin(); }
                },
            }, username, display, password,
            h("div", { class: "rs-row rs-wrap" }, editL, queueL, managerL, adminL),
            h("button", { class: "rs-btn rs-btn-primary", type: "submit" }, "Create account")));
    }

    configForm(cfg) {
        const text = (value, placeholder) => h("input", { class: "rs-input", value: value ?? "", placeholder });
        const box = (checked) => h("input", { type: "checkbox", checked: !!checked });
        const f = {
            name: text(cfg.server_name, "Server name"),
            login: box(cfg.require_login),
            guests: box(cfg.allow_guests),
            broadcast: box(cfg.broadcast_execution),
            protect: box(cfg.api_protection?.enabled),
            hideAccount: box(cfg.hide_comfy_account),
            hideApiTemplates: box(cfg.hide_api_templates),
            trusted: text((cfg.api_protection?.trusted_ips || []).join(", "), "127.0.0.1, 172.17.0.0/16"),
            interval: h("input", { class: "rs-input rs-num", type: "number", min: 0, value: Math.round((cfg.snapshot_interval_sec ?? 300) / 60) }),
            keep: h("input", { class: "rs-input rs-num", type: "number", min: 1, value: cfg.snapshot_keep ?? 30 }),
        };
        const line = (input, label, hint) => h("label", { class: "rs-check rs-block" }, input,
            h("span", {}, label, hint ? h("div", { class: "rs-muted rs-small" }, hint) : null));
        return h("form", {
            class: "rs-form", onkeydown: (e) => e.stopPropagation(),
            onsubmit: async (e) => {
                e.preventDefault();
                const ok = await this.run(() => this.client.request("PATCH", "/rigshare/api/config", {
                    server_name: f.name.value.trim() || "RigShare",
                    require_login: f.login.checked,
                    allow_guests: f.guests.checked,
                    broadcast_execution: f.broadcast.checked,
                    hide_comfy_account: f.hideAccount.checked,
                    hide_api_templates: f.hideApiTemplates.checked,
                    api_protection: { enabled: f.protect.checked, trusted_ips: f.trusted.value.split(/[\s,]+/).filter(Boolean) },
                    snapshot_interval_sec: Math.max(0, +f.interval.value || 0) * 60,
                    snapshot_keep: Math.max(1, +f.keep.value || 30),
                }), "Settings saved");
                if (ok) { this.client.server.name = ok.server_name; this.renderHeader(); }
            },
        },
        h("label", { class: "rs-label" }, "Server name"), f.name,
        line(f.login, "Require login", "Everyone signs in before ComfyUI loads. API clients use API keys."),
        line(f.guests, "Allow guests (only without required login)", "Visitors can watch and chat without an account"),
        line(f.broadcast, "Share execution progress", "Everyone sees progress and previews, not only whoever queued"),
        line(f.protect, "Enforce permissions on the ComfyUI API", "Blocks queueing, interrupting and uploads for users without permission"),
        line(f.hideAccount, "Hide the Comfy.org account login", "Removes ComfyUI's own sign-in button and dialog (used for paid API nodes)"),
        line(f.hideApiTemplates, "Hide API templates", "Removes templates that need paid API nodes from the template browser"),
        h("label", { class: "rs-label" }, "Trusted IPs / networks (skip login and checks)"), f.trusted,
        h("div", { class: "rs-row" }, h("label", { class: "rs-label rs-grow" }, "Auto snapshot every (min, 0 = off)"), f.interval),
        h("div", { class: "rs-row" }, h("label", { class: "rs-label rs-grow" }, "Automatic snapshots kept"), f.keep),
        h("button", { class: "rs-btn rs-btn-primary", type: "submit" }, h("i", { class: "pi pi-save" }), "Save settings"));
    }
}
