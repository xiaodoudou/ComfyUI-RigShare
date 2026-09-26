// Drive-style file browser for the RigShare workspace.
//
//   [My files]  users/<you>/…      only you (and admins)
//   [Shared]    shared folders + the common top level
//   [All]       the whole workflows folder, everyone's files (admins)
//
// One component serves the Files tab ("browse"), the "Open from RigShare"
// dialog ("open"), the Save dialog ("save") and the "Move to…" picker ("pick").

import { h, timeAgo, storage, APP_ICON } from "./ui.js";

const SHARED = "@shared";
const ALL = "";

export class FilesBrowser {
    constructor({ app, client, sync, mode = "browse", start, onOpenFile, onPickFile, onChange, accessEditor }) {
        Object.assign(this, { app, client, sync, mode, onOpenFile, onPickFile, onChange, accessEditor });
        this.path = null;
        this.tab = null;
        this.listing = null;
        this.filter = "";
        this.accessFor = null;
        this.crumbs = h("div", { class: "rs-fb-crumbs" });
        this.search = h("input", {
            class: "rs-input rs-fb-search", placeholder: "Filter", type: "search",
            oninput: () => { this.filter = this.search.value.trim().toLowerCase(); this.renderList(); },
            onkeydown: (e) => e.stopPropagation(),
        });
        this.actions = h("div", { class: "rs-fb-actions" });
        this.tabsEl = h("div", { class: "rs-fb-tabs", role: "tablist" });
        this.list = h("div", { class: "rs-fb-list" });
        this.el = h("div", { class: `rs-fb rs-fb-${mode}` },
            this.tabsEl,
            h("div", { class: "rs-fb-bar" }, this.crumbs, this.actions),
            h("div", { class: "rs-fb-tools" }, this.search),
            this.list);
        // The sidebar browser lives as long as the page: keep its live dots current.
        if (mode === "browse") client.on("presence", () => { if (this.listing && this.el.isConnected) this.renderList(); });
        this.setStart(start);
    }

    get me() {
        return this.client.self?.key;
    }

    /** The folder tabs: each is a root the browser can't go above. */
    get tabs() {
        return [
            this.me ? { id: "mine", label: "My files", icon: "pi-user", root: `users/${this.me}`, hint: "Only you" } : null,
            { id: "shared", label: "Shared", icon: "pi-users", root: SHARED, hint: "Shared folders and common workflows" },
            this.client.perms.admin ? { id: "all", label: "All", icon: "pi-shield", root: ALL, hint: "The whole workflows folder, everyone's files (admins)" } : null,
        ].filter(Boolean);
    }

    /** Which tab a path belongs to when opened directly (not through a tab). */
    tabFor(path) {
        const ids = this.tabs.map((t) => t.id);
        if (this.me && (path === `users/${this.me}` || path?.startsWith(`users/${this.me}/`))) return "mine";
        if (path === ALL || path === "users" || path?.startsWith("users/")) return ids.includes("all") ? "all" : ids[0];
        return "shared";
    }

    setStart(start) {
        if (start === undefined || start === null || start === "@home") start = this.me ? `users/${this.me}` : SHARED;
        this.tab = this.tabFor(start);
        const allowed = this.tab === "all" || this.tab === "shared" || start.startsWith(`users/${this.me}`);
        this.path = allowed && !(this.tab === "shared" && (start === ALL || start.startsWith("users"))) ? start : this.currentTab.root;
    }

    get currentTab() {
        return this.tabs.find((t) => t.id === this.tab) ?? this.tabs[0];
    }

    async switchTab(id) {
        const tab = this.tabs.find((t) => t.id === id);
        if (!tab) return;
        this.tab = id;
        await this.go(tab.root);
    }

    /** Folder path usable for saving ("" is the common top level), or null. */
    get saveFolder() {
        if (!this.listing || this.listing.role !== "edit") return null;
        if (this.path === "users") return null;
        return this.path === SHARED ? "" : this.path;
    }

    toast(severity, detail) {
        this.client.emit("toast", { severity, summary: "RigShare", detail });
    }

    async run(fn, ok) {
        try {
            const r = await fn();
            if (ok) this.toast("success", ok);
            return r ?? true;
        } catch (e) {
            this.toast("error", e.message || String(e));
            return undefined;
        }
    }

    async go(path) {
        this.path = path;
        this.filter = "";
        this.search.value = "";
        this.accessFor = null;
        await this.reload();
    }

    async reload() {
        // Tabs depend on who is signed in (admin, username): keep the current one valid.
        if (!this.tabs.some((t) => t.id === this.tab)) {
            this.tab = this.tabs[0].id;
            this.path = this.tabs[0].root;
        }
        this.list.replaceChildren(h("div", { class: "rs-fb-empty" }, h("i", { class: "pi pi-spin pi-spinner" })));
        try {
            this.listing = await this.client.request("GET", `/rigshare/api/workspace/list?path=${encodeURIComponent(this.path)}`);
        } catch (e) {
            this.toast("error", e.message);
            this.listing = null;
            const root = this.currentTab.root;
            if (this.path !== root) return this.go(root);
        }
        this.render();
        this.onChange?.(this);
    }

    // ----- breadcrumbs ------------------------------------------------------

    /** Breadcrumbs from the current tab's root down to the current folder. */
    trail() {
        const tab = this.currentTab;
        const out = [{ label: tab.label, path: tab.root }];
        const p = this.path;
        if (p === tab.root) return out;
        const parts = p.split("/");
        // Number of leading path parts the tab root stands for.
        let skip = 0;
        if (tab.id === "mine") skip = 2;
        else if (tab.id === "shared" && parts[0] === "shared") skip = 1;
        parts.slice(skip).forEach((part, i) => out.push({ label: part, path: parts.slice(0, i + 1 + skip).join("/") }));
        return out;
    }

    /** Human label of the current folder, e.g. "My files / renders". */
    get label() {
        return this.trail().map((c) => c.label).join(" / ");
    }

    render() {
        this.tabsEl.replaceChildren(...this.tabs.map((t) => h("button", {
            class: `rs-fb-tab ${t.id === this.tab ? "active" : ""}`, role: "tab", title: t.hint,
            "aria-selected": String(t.id === this.tab),
            onclick: () => { if (t.id !== this.tab || this.path !== t.root) this.switchTab(t.id); },
        }, h("i", { class: `pi ${t.icon}` }), h("span", {}, t.label))));
        const trail = this.trail();
        this.crumbs.replaceChildren(...trail.flatMap((c, i) => [
            i ? h("i", { class: "pi pi-angle-right rs-fb-sep" }) : null,
            h("button", { class: `rs-fb-crumb ${i === trail.length - 1 ? "current" : ""}`, onclick: () => this.go(c.path) },
                c.icon ? h("i", { class: `pi ${c.icon}` }) : null, i === 0 && c.icon ? null : c.label),
        ]).filter(Boolean));
        const shared = this.listing?.shared_folder;
        this.actions.replaceChildren(...[
            // Inside a shared folder: its access list, like the 🔒 on its row one level up.
            shared?.manage && this.mode === "browse" && this.accessEditor ? h("button", {
                class: `rs-btn rs-btn-icon ${this.accessFor === shared.path ? "active" : ""}`,
                title: `Who can open "${shared.name}"${shared.restricted ? " (restricted)" : ""}`,
                onclick: () => { this.accessFor = this.accessFor === shared.path ? null : shared.path; this.render(); },
            }, h("i", { class: `pi ${shared.restricted ? "pi-lock" : "pi-lock-open"}` })) : null,
            this.listing?.can_mkdir && this.mode !== "open" ? h("button", {
                class: "rs-btn rs-btn-icon", title: this.path === SHARED ? "New shared folder" : "New folder",
                onclick: () => this.newFolder(),
            }, h("i", { class: "pi pi-folder-plus" })) : null,
            h("button", { class: "rs-btn rs-btn-icon", title: "Refresh", onclick: () => this.reload() }, h("i", { class: "pi pi-refresh" })),
        ].filter(Boolean));
        this.renderList();
    }

    renderList() {
        const entries = (this.listing?.entries || []).filter((e) => !this.filter || e.name.toLowerCase().includes(this.filter));
        // The access editor of the shared folder we are in shows above its content.
        const here = this.listing?.shared_folder;
        const top = here && this.accessFor === here.path && this.accessEditor
            ? this.accessEditor(here.path, () => { this.accessFor = null; this.reload(); }) : null;
        if (top) {
            this.list.replaceChildren(top, ...entries.map((e) => this.row(e)));
            return;
        }
        if (!entries.length) {
            this.list.replaceChildren(h("div", { class: "rs-fb-empty" },
                this.filter ? "Nothing matches." : this.path === `users/${this.me}` ? "Nothing here yet. Save a workflow and choose My files." : "This folder is empty."));
            return;
        }
        const rows = [];
        for (const e of entries) {
            rows.push(this.row(e));
            if (this.accessFor === e.path && this.accessEditor) rows.push(this.accessEditor(e.path, () => { this.accessFor = null; this.reload(); }));
        }
        this.list.replaceChildren(...rows);
    }

    row(e) {
        const isFolder = e.type === "folder";
        const owner = e.owner ? this.client.users.find((u) => u.key === e.owner)?.name ?? `@${e.owner}` : null;
        const meta = isFolder
            ? [e.owner !== undefined && owner ? `owner ${owner}` : null, e.role === "view" ? "view only" : null].filter(Boolean).join(" · ")
            : [e.app ? "App" : null, timeAgo(e.modified * 1000), e.role === "view" ? "view only" : null].filter(Boolean).join(" · ");
        const icon = isFolder ? (e.restricted ? "pi-lock" : "pi-folder") : e.app ? "app" : "pi-file";
        // Files outside private folders are live while open: show who is in them.
        const live = isFolder ? null : this.client.rooms?.find((r) => r.key === `file:workflows/${e.path}`);
        const disabled = this.mode === "pick" && !isFolder;
        const tools = this.mode === "browse" ? this.rowTools(e) : [];
        return h("div", { class: `rs-fb-row ${isFolder ? "folder" : "file"} ${disabled ? "disabled" : ""}` },
            h("button", {
                class: "rs-fb-main", disabled,
                ondblclick: () => { if (!isFolder && this.mode === "save") this.onOpenFile?.(e.path); },
                onclick: () => {
                    if (isFolder) return this.go(e.path);
                    if (this.mode === "save") return this.onPickFile?.(e);
                    if (this.mode !== "pick") this.onOpenFile?.(`workflows/${e.path}`);
                },
            },
            h("i", { class: `${icon === "app" ? `${APP_ICON} rs-comfy-icon` : `pi ${icon}`} rs-fb-icon ${isFolder ? "folder" : ""}` }),
            h("span", { class: "rs-grow rs-min0" },
                h("div", { class: "rs-name rs-ellipsis", title: e.name }, e.name,
                    live ? h("span", { class: "rs-live rs-inline-icon", title: `Live · ${live.members.length} open` }, h("span", { class: "rs-live-dot" })) : null),
                meta ? h("div", { class: "rs-muted rs-small rs-ellipsis" }, meta) : null)),
            tools.length ? h("div", { class: "rs-fb-tools-row" }, ...tools) : null);
    }

    rowTools(e) {
        const isFolder = e.type === "folder";
        const topShared = isFolder && e.manage !== undefined;
        const tools = [];
        if (topShared && e.manage) {
            tools.push(h("button", { class: "rs-btn rs-btn-icon rs-btn-sm", title: "Who can open it", onclick: () => {
                this.accessFor = this.accessFor === e.path ? null : e.path; this.renderList();
            } }, h("i", { class: "pi pi-lock" })));
        }
        const canRename = isFolder ? (topShared ? e.manage : e.deletable) : e.role === "edit";
        if (canRename) tools.push(h("button", { class: "rs-btn rs-btn-icon rs-btn-sm", title: "Rename", onclick: () => this.rename(e) }, h("i", { class: "pi pi-pencil" })));
        if (e.deletable && !topShared) tools.push(h("button", { class: "rs-btn rs-btn-icon rs-btn-sm", title: "Move to…", onclick: () => this.move(e) }, h("i", { class: "pi pi-arrow-right-arrow-left" })));
        if (e.deletable) tools.push(h("button", { class: "rs-btn rs-btn-icon rs-btn-sm rs-danger", title: "Delete", onclick: () => this.remove(e) }, h("i", { class: "pi pi-trash" })));
        return tools;
    }

    // ----- actions ----------------------------------------------------------

    async ask(title, message, value = "") {
        // Inside the Save / Move / Open dialogs ComfyUI's own prompt would open underneath.
        if (this.mode !== "browse") return await promptModal(title, message, value);
        const dialog = this.app.extensionManager?.dialog;
        if (dialog?.prompt) return await dialog.prompt({ title, message, defaultValue: value });
        return window.prompt(message, value);
    }

    async confirm(title, message) {
        const dialog = this.app.extensionManager?.dialog;
        if (dialog?.confirm) return !!(await dialog.confirm({ title, message }));
        return window.confirm(message);
    }

    async refreshComfy() {
        await this.app.extensionManager?.workflow?.syncWorkflows?.();
    }

    async newFolder() {
        const name = await this.ask(this.path === SHARED ? "New shared folder" : "New folder", "Folder name");
        if (!name) return;
        const res = await this.run(() => this.client.request("POST", "/rigshare/api/workspace/mkdir", { parent: this.path, name }));
        if (res) this.reload();
    }

    async rename(e) {
        const name = await this.ask("Rename", `New name for "${e.name}"`, e.name);
        if (!name || name === e.name) return;
        if (e.type === "folder") {
            await this.run(() => this.client.request("POST", "/rigshare/api/workspace/rename-folder", { path: e.path, name }), "Renamed");
            await this.refreshComfy();
        } else {
            const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/") + 1) : "";
            const clean = name.replace(/\.json$/i, "").replace(/[\\/]+/g, "-");
            await this.run(() => this.sync.movePath(`workflows/${e.path}`, `workflows/${dir}${clean}.json`), "Renamed");
        }
        this.reload();
    }

    async move(e) {
        const dest = await pickFolder({ app: this.app, client: this.client, sync: this.sync, title: `Move "${e.name}" to…`, start: this.path });
        if (dest === null || dest === undefined) return;
        if (e.type === "folder") {
            await this.run(() => this.client.request("POST", "/rigshare/api/workspace/move-folder", { path: e.path, dest }), "Moved");
            await this.refreshComfy();
        } else {
            const base = e.path.split("/").pop();
            await this.run(() => this.sync.movePath(`workflows/${e.path}`, dest ? `workflows/${dest}/${base}` : `workflows/${base}`), "Moved");
        }
        this.reload();
    }

    async remove(e) {
        const what = e.type === "folder" ? `the folder "${e.name}"` : `"${e.name}"`;
        if (!(await this.confirm("Delete", `Delete ${what}? This cannot be undone.`))) return;
        if (e.type === "folder") {
            await this.run(() => this.client.request("POST", "/rigshare/api/workspace/delete-folder", { path: e.path }), "Deleted");
        } else {
            await this.run(async () => {
                const store = this.app.extensionManager.workflow;
                await store.syncWorkflows?.();
                const wf = store.getWorkflowByPath?.(`workflows/${e.path}`);
                if (wf && store.deleteWorkflow) await store.deleteWorkflow(wf);
                else {
                    const { api } = await import("../../../scripts/api.js");
                    const res = await api.deleteUserData(`workflows/${e.path}`);
                    if (res.status !== 204) throw new Error(`Could not delete (${res.status})`);
                }
            }, "Deleted");
        }
        await this.refreshComfy();
        this.reload();
    }
}

// ----- modal helpers ----------------------------------------------------------

export function modal(title, icon, body, footer) {
    let resolveClose;
    const closed = new Promise((r) => { resolveClose = r; });
    const close = (value) => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        resolveClose(value);
    };
    // Stacked modals (a prompt over the Save dialog): Escape closes only the top one.
    const onKey = (e) => {
        if (e.key !== "Escape" || !backdrop.isConnected) return;
        if ([...document.querySelectorAll(".rs-modal-backdrop")].at(-1) !== backdrop) return;
        e.stopPropagation();
        close(null);
    };
    const backdrop = h("div", { class: "rs-modal-backdrop rs-panel-vars", onmousedown: (e) => { if (e.target === backdrop) close(null); } },
        h("div", { class: "rs-modal rs-modal-wide", role: "dialog", "aria-label": title },
            h("div", { class: "rs-modal-title" }, h("i", { class: `pi ${icon}` }), h("span", { class: "rs-grow" }, title),
                h("button", { class: "rs-btn rs-btn-icon rs-btn-ghost", title: "Close", onclick: () => close(null) }, h("i", { class: "pi pi-times" }))),
            body,
            footer ? h("div", { class: "rs-modal-footer" }, footer) : null));
    backdrop.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.append(backdrop);
    document.addEventListener("keydown", onKey, true);
    return { close, closed };
}

/** A text prompt in RigShare's own modal, so it stacks above another RigShare modal. */
export async function promptModal(title, message, value = "") {
    const input = h("input", { class: "rs-input", value, maxLength: 120 });
    const ok = h("button", { class: "rs-btn rs-btn-primary" }, "OK");
    const m = modal(title, "pi-pencil", h("div", { class: "rs-save-body" }, h("label", { class: "rs-label" }, message), input),
        [h("span", { class: "rs-grow" }), h("button", { class: "rs-btn rs-btn-ghost", onclick: () => m.close(null) }, "Cancel"), ok]);
    const submit = () => m.close(input.value);
    ok.onclick = submit;
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); submit(); } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return await m.closed;
}

/** Folder picker; resolves to a folder path ("" = common top level) or null. */
export async function pickFolder({ app, client, sync, title, start }) {
    const browser = new FilesBrowser({ app, client, sync, mode: "pick", start });
    const choose = h("button", { class: "rs-btn rs-btn-primary" }, "Move here");
    const where = h("span", { class: "rs-muted rs-small rs-grow rs-ellipsis" });
    browser.onChange = () => {
        choose.disabled = browser.saveFolder === null;
        where.textContent = browser.saveFolder === null ? "Open a folder you can edit" : browser.label;
    };
    const m = modal(title, "pi-arrow-right-arrow-left", browser.el, [where, choose]);
    choose.onclick = () => m.close(browser.saveFolder);
    await browser.reload();
    return m.closed;
}

/** "Open from RigShare": browse and open a workflow. */
export async function openFromWorkspace({ app, client, sync }) {
    const browser = new FilesBrowser({
        app, client, sync, mode: "open", start: storage.get("rigshare.lastOpenFolder") ?? undefined,
        onOpenFile: async (path) => {
            storage.set("rigshare.lastOpenFolder", browser.path);
            m.close(true);
            try { await sync.openPath(path); } catch (e) { client.emit("toast", { severity: "error", summary: "RigShare", detail: e.message }); }
        },
    });
    const m = modal("Open from RigShare", "pi-folder-open", browser.el, null);
    await browser.reload();
    return m.closed;
}
