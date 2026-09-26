// Live sync of workflow tabs between browsers.
//
// Every shared tab maps to a room on the server: a saved workflow is the room
// "file:<path>" (everyone opening the same file lands in the same room), an
// unsaved tab joins a room only after "Share this tab" ("tmp:<id>", stored in
// the workflow's extra so it survives reloads and travels with the doc).
//
// Only the tab on screen is live. Switching tabs leaves the old room and joins
// the new one; the server copy is authoritative when a room already exists.
//
// Local edits are detected through the frontend change tracker (`graphChanged`)
// plus a light poll while dragging, diffed per node against the last synced
// state and sent as small patches. Remote patches that only touch existing
// nodes (move, resize, widget values, title, mode…) are applied in place;
// anything structural (added/removed nodes, links, groups, subgraphs) reloads
// the tab from the room document, keeping the local viewport.

const LS_OVERRIDES = "rigshare.shareOverrides";

import { applyPatch, itemId } from "./graphdoc.js";

export { applyPatch };

// Split a workflow into keyed parts so edits diff per node / link / group.
export function snapshotOf(wf) {
    const nodes = new Map();
    for (const n of wf?.nodes || []) nodes.set(n.id, JSON.stringify(n));
    const keyed = {};
    const groupsKeyed = Array.isArray(wf?.groups) && wf.groups.every((g) => g && g.id !== undefined && g.id !== null);
    for (const key of ["links", "groups"]) {
        if (key === "groups" && !groupsKeyed) continue;
        if (!Array.isArray(wf?.[key])) continue;
        keyed[key] = new Map(wf[key].map((it) => [itemId(key, it), JSON.stringify(it)]));
    }
    const rest = new Map();
    for (const [k, v] of Object.entries(wf || {})) if (k !== "nodes" && !keyed[k]) rest.set(k, JSON.stringify(v));
    return { nodes, keyed, rest };
}

export function diffSnapshots(base, snap) {
    const patch = {};
    const nodes = [];
    const added = [];
    const removed = [];
    for (const [id, json] of snap.nodes) {
        const old = base.nodes.get(id);
        if (old !== json) nodes.push(JSON.parse(json));
        if (old === undefined) added.push(id);
    }
    for (const id of base.nodes.keys()) if (!snap.nodes.has(id)) removed.push(id);
    if (nodes.length) patch.nodes = nodes;
    if (added.length) patch.added = added;
    if (removed.length) patch.removed = removed;

    const set = {};
    const unset = [];
    for (const key of ["links", "groups"]) {
        const now = snap.keyed[key];
        const was = base.keyed[key];
        if (!now || !was) {
            // Not keyed on one side (unusual shape): fall back to a plain set.
            if (now) set[key] = [...now.values()].map((j) => JSON.parse(j));
            continue;
        }
        const upsert = [];
        const newIds = [];
        const gone = [];
        for (const [id, json] of now) {
            if (was.get(id) !== json) upsert.push(JSON.parse(json));
            if (!was.has(id)) newIds.push(id);
        }
        for (const id of was.keys()) if (!now.has(id)) gone.push(id);
        if (upsert.length || gone.length) {
            patch[key] = { upsert, removed: gone };
            if (key === "links" && newIds.length) patch[key].added = newIds;
        }
    }
    for (const [k, json] of snap.rest) if (base.rest.get(k) !== json) set[k] = JSON.parse(json);
    for (const k of base.rest.keys()) if (!snap.rest.has(k) && !snap.keyed[k]) unset.push(k);
    if (Object.keys(set).length) patch.set = set;
    if (unset.length) patch.unset = unset;
    return Object.keys(patch).length ? patch : null;
}

function stripView(wf) {
    if (wf?.extra) {
        delete wf.extra.ds;
    }
    return wf;
}

export class RoomSync extends EventTarget {
    constructor(app, api, client) {
        super();
        this.app = app;
        this.api = api;
        this.client = client;
        this.autoShareFiles = false;
        this.autoShareUnsaved = false;
        this.loading = 0;       // a graph load (ours or ComfyUI's) is in progress
        this.ownLoad = 0;       // the load in progress was started by RigShare
        this.installLoadGuard();
        this.optedOut = new WeakSet(); // unsaved tabs the user chose to keep private
        this.seen = new WeakMap();      // unsaved tab -> nodes when first seen
        this.overrides = this.loadOverrides();

        this.target = null;     // room info of the tab on screen, or null
        this.targetWf = null;   // that tab's workflow object
        this.targetKey = undefined;
        this.ready = false;     // server confirmed the join
        this.doc = null;
        this.version = 0;
        this.baseline = null;
        this.busy = Promise.resolve();
        this.applying = 0;
        this.settleUntil = 0;
        this.pointerDown = false;
        this.lastEditor = null;
        this.readOnlyForced = false;
        this.room = null;       // {role, manage, restricted, owner} of the joined room
        this.denied = new Set(); // rooms we were refused; not retried until access changes
        this.inFlight = 0;      // our patches not yet acknowledged
        this.crossed = false;   // a remote patch arrived while ours were in flight

        client.on("welcome", () => { this.targetKey = undefined; this.tick(); });
        client.on("status", (s) => { if (s !== "online") { this.ready = false; this.emitState(); } });
        client.on("room", (msg) => this.onRoom(msg));
        client.on("room_info", (msg) => {
            if (msg.room !== this.targetKey) return;
            this.room = { role: msg.role, manage: msg.manage, restricted: msg.restricted, owner: msg.owner };
            this.updateReadOnly();
            this.emitState();
        });
        client.on("room_denied", (msg) => {
            this.denied.add(msg.room);
            if (msg.room === this.targetKey) {
                this.ready = false;
                this.room = null;
            }
            client.emit("toast", { severity: "warn", summary: "RigShare", detail: `You don't have access to "${msg.name}". Your tab stays as a private copy.` });
            this.updateReadOnly();
            this.emitState();
        });
        client.on("presence", () => {
            // Access granted again: the room shows up in our list.
            for (const key of this.denied) if (client.rooms.some((r) => r.key === key)) this.denied.delete(key);
        });
        client.on("graph", (msg) => this.onRemotePatch(msg));
        client.on("doc", (msg) => this.onRemoteDoc(msg));
        client.on("ack", (msg) => {
            if (msg.room !== this.targetKey) return;
            this.version = msg.version;
            this.inFlight = Math.max(0, this.inFlight - 1);
            if (!this.inFlight && this.crossed) {
                // Our edits and someone else's crossed on the way: fetch the
                // server's merged result so every copy converges.
                this.crossed = false;
                this.client.send({ type: "request_doc", room: this.targetKey });
            }
            this.emitState();
        });
        client.on("self", () => this.updateReadOnly());
        client.on("unshared", (msg) => {
            const detail = msg.removed
                ? `"${msg.name}" is no longer shared.`
                : msg.others.length
                    ? `You left "${msg.name}". Still shared with ${msg.others.join(", ")}.`
                    : `You left "${msg.name}".`;
            client.emit("toast", { severity: "info", summary: "RigShare", detail });
        });

        api.addEventListener("graphChanged", () => this.checkLocal());
        window.addEventListener("pointerdown", (e) => {
            if (e.target?.tagName === "CANVAS") this.pointerDown = true;
        }, true);
        window.addEventListener("pointerup", () => {
            if (this.pointerDown) {
                this.pointerDown = false;
                setTimeout(() => this.checkLocal(), 30);
            }
        }, true);
        // Drag updates stream at ~8 Hz; the tick notices tab switches and
        // catches edits that bypass the change tracker.
        setInterval(() => { if (this.pointerDown) this.checkLocal(); }, 120);
        setInterval(() => this.tick(), 400);
    }

    emitState() {
        this.dispatchEvent(new CustomEvent("state"));
    }

    get store() {
        return this.app.extensionManager?.workflow;
    }

    /** The tab on screen is shared and in sync with its room. */
    get live() {
        return this.ready && !!this.targetKey;
    }

    /** May edit the tab on screen: account permission, narrowed by the room's access list. */
    get canEdit() {
        if (!this.client.perms.edit) return false;
        return !this.targetKey || !this.room || this.room.role === "edit";
    }

    graph() {
        return this.app.rootGraph ?? this.app.graph;
    }

    serialize() {
        return stripView(JSON.parse(JSON.stringify(this.graph().serialize())));
    }

    // ----- which room does a tab belong to --------------------------------

    loadOverrides() {
        try { return JSON.parse(localStorage.getItem(LS_OVERRIDES)) || {}; } catch { return {}; }
    }

    saveOverrides() {
        try { localStorage.setItem(LS_OVERRIDES, JSON.stringify(this.overrides)); } catch { /* ignore */ }
    }

    tabName(wf) {
        return (wf.filename ?? wf.path?.split("/").pop() ?? "Workflow").replace(/\.json$/, "");
    }

    roomFor(wf, extra) {
        if (!wf) return null;
        if (!wf.isTemporary) {
            const shared = this.overrides[wf.path] ?? this.autoShareFiles;
            return shared ? { key: `file:${wf.path}`, name: this.tabName(wf), kind: "file" } : null;
        }
        extra ??= (wf.changeTracker?.activeState ?? wf.activeState)?.extra;
        const id = extra?.rigshare?.room;
        return id ? { key: id, name: this.tabName(wf), kind: "tmp" } : null;
    }

    activeRoom() {
        const wf = this.store?.activeWorkflow;
        // For the tab on screen, read the live graph (share flag may be fresh).
        const room = this.roomFor(wf, this.graph()?.extra);
        return { wf, room: room && this.denied.has(room.key) ? null : room };
    }

    /** Change who can open the room on screen (owner or admin). */
    async setAccess(restricted, members) {
        if (!this.targetKey) return;
        return await this.client.request("PUT", "/rigshare/api/room/acl", { key: this.targetKey, restricted, members });
    }

    // ----- joining --------------------------------------------------------

    tick() {
        if (!this.client.online || !this.store) return;
        this.maybeAutoShare();
        const { wf, room } = this.activeRoom();
        const key = room?.key ?? null;
        if (key !== this.targetKey || (key && wf !== this.targetWf)) {
            this.switchTo(room, wf);
        } else if (room && this.target && room.name !== this.target.name) {
            this.target = room; // tab renamed
            this.emitState();
        } else if (this.live && this.canEdit) {
            this.checkLocal();
        }
        this.updateReadOnly();
    }

    switchTo(room, wf) {
        this.target = room;
        this.targetWf = wf;
        this.targetKey = room?.key ?? null;
        this.ready = false;
        this.baseline = null;
        this.doc = null;
        this.lastEditor = null;
        this.inFlight = 0;
        this.crossed = false;
        this.room = null;
        this.client.send(room
            ? { type: "join", room: room.key, name: room.name, doc: this.serialize() }
            : { type: "join", room: null });
        this.updateReadOnly();
        this.emitState();
    }

    onRoom(msg) {
        if (msg.room !== this.targetKey) return;
        this.version = msg.version;
        this.room = { role: msg.role, manage: msg.manage, restricted: msg.restricted, owner: msg.owner };
        if (msg.created || !msg.doc) {
            this.doc = this.serialize();
            this.ready = true;
            this.settle();
            this.emitState();
            return;
        }
        this.doc = msg.doc;
        this.ready = true;
        const differs = diffSnapshots(snapshotOf(this.serialize()), snapshotOf(this.doc));
        if (differs) this.enqueue(() => this.loadDoc(true));
        else this.settle();
        this.updateReadOnly();
        this.emitState();
    }

    enqueue(fn) {
        this.busy = this.busy.then(fn).catch((e) => console.error("[RigShare] sync error", e));
        return this.busy;
    }

    /** Reload the tab on screen from the room document. */
    async loadDoc(keepView) {
        const wf = this.store?.activeWorkflow;
        if (!this.live || wf !== this.targetWf) return;
        const doc = structuredClone(this.doc);
        const ds = this.app.canvas?.ds;
        if (keepView && ds) doc.extra = { ...(doc.extra || {}), ds: { scale: ds.scale, offset: [...ds.offset] } };
        this.applying++;
        this.ownLoad++;
        try {
            await this.app.loadGraphData(doc, true, keepView, wf, { skipAssetScans: true, silentAssetErrors: true });
        } finally {
            this.ownLoad--;
            this.applying--;
        }
        this.settle();
        this.updateReadOnly();
    }

    settle(ms = 250) {
        this.baseline = snapshotOf(this.serialize());
        this.settleUntil = performance.now() + ms;
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            if (this.live && !this.applying) this.baseline = snapshotOf(this.serialize());
        }, ms + 20);
    }

    // ----- local -> remote ------------------------------------------------

    checkLocal() {
        if (!this.live || this.applying || this.loading || !this.baseline || !this.client.online) return;
        if (this.store?.activeWorkflow !== this.targetWf) return;
        if (performance.now() < this.settleUntil) return;
        const snap = snapshotOf(this.serialize());
        const patch = diffSnapshots(this.baseline, snap);
        if (!patch) return;
        if (!this.canEdit) {
            // Viewers cannot change shared tabs: put it back.
            clearTimeout(this.revertTimer);
            this.revertTimer = setTimeout(() => this.enqueue(() => this.loadDoc(true)), 300);
            return;
        }
        this.baseline = snap;
        this.doc = applyPatch(this.doc, patch);
        this.inFlight++;
        this.client.send({ type: "graph", room: this.targetKey, patch });
    }

    // ----- remote -> local ------------------------------------------------

    onRemoteDoc(msg) {
        if (msg.room !== this.targetKey) return;
        this.doc = msg.doc;
        this.version = msg.version;
        if (msg.reason) this.client.emit("toast", { severity: "info", summary: "RigShare", detail: msg.reason });
        this.enqueue(() => this.loadDoc(true));
        this.emitState();
    }

    onRemotePatch(msg) {
        if (msg.room !== this.targetKey || !this.ready) return;
        if (this.inFlight) this.crossed = true;
        const patch = msg.patch;
        this.doc = applyPatch(this.doc, patch);
        this.version = msg.version;
        this.lastEditor = { id: msg.from, name: msg.name, at: Date.now() };
        this.emitState();
        this.enqueue(async () => {
            if (this.isStructural(patch)) {
                // Send our own pending edits first so they are not lost.
                this.checkLocal();
                await this.loadDoc(true);
            } else {
                this.applyInPlace(patch.nodes || []);
            }
        });
    }

    isStructural(patch) {
        if ("full" in patch || patch.removed?.length || patch.unset?.length || patch.added?.length) return true;
        if (patch.links || patch.groups) return true;
        if (Object.keys(patch.set || {}).some((k) => !["last_node_id", "last_link_id"].includes(k))) return true;
        const graph = this.graph();
        for (const data of patch.nodes || []) {
            const node = graph.getNodeById(data.id);
            if (!node) return true;
            const links = (arr, key) => JSON.stringify((arr || []).map((s) => s?.[key] ?? null));
            if (links(data.inputs, "link") !== links(node.inputs, "link")) return true;
            if (links(data.outputs, "links") !== links(node.outputs, "links")) return true;
            if (data.type !== node.type) return true;
        }
        return false;
    }

    applyInPlace(nodes) {
        if (this.store?.activeWorkflow !== this.targetWf) return;
        const graph = this.graph();
        const focused = document.activeElement;
        // Keep unsent local edits: diff before touching anything.
        this.checkLocal();
        this.applying++;
        try {
            for (const data of nodes) {
                const node = graph.getNodeById(data.id);
                if (!node) continue;
                // Don't yank a text box out from under someone typing in it.
                const typing = focused && node.widgets?.some((w) => w.element?.contains?.(focused));
                if (typing) continue;
                node.configure(structuredClone(data));
            }
        } finally {
            this.applying--;
        }
        this.app.canvas?.setDirty(true, true);
        this.settle();
    }

    // ----- permissions ----------------------------------------------------

    updateReadOnly() {
        const canvas = this.app.canvas;
        if (!canvas) return;
        const lock = this.live && !this.canEdit;
        if (lock && !canvas.read_only) {
            canvas.read_only = true;
            this.readOnlyForced = true;
        } else if (!lock && this.readOnlyForced) {
            canvas.read_only = false;
            this.readOnlyForced = false;
        this.room = null;       // {role, manage, restricted, owner} of the joined room
        this.denied = new Set(); // rooms we were refused; not retried until access changes
        this.inFlight = 0;      // our patches not yet acknowledged
        this.crossed = false;   // a remote patch arrived while ours were in flight
        }
    }

    // ----- actions --------------------------------------------------------

    /** Start sharing the tab on screen. */
    shareCurrent() {
        const wf = this.store?.activeWorkflow;
        if (!wf) return;
        if (wf.isTemporary) {
            const graph = this.graph();
            graph.extra ??= {};
            graph.extra.rigshare = { room: `tmp:${crypto.randomUUID?.() ?? Date.now().toString(36)}` };
            wf.changeTracker?.checkState();
        } else {
            this.overrides[wf.path] = true;
            this.saveOverrides();
        }
        this.tick();
    }

    /**
     * Unsaved tabs join a room on their own once someone edits them. Tabs that
     * are merely open (the default workflow, restored tabs) stay private so the
     * shared list is not flooded with untouched copies.
     */
    maybeAutoShare() {
        const wf = this.store.activeWorkflow;
        if (!this.autoShareUnsaved || !wf?.isTemporary || this.optedOut.has(wf)) return;
        const graph = this.graph();
        if (!graph || graph.extra?.rigshare?.room) return;
        const sig = JSON.stringify(graph.serialize().nodes);
        const seen = this.seen.get(wf);
        const now = performance.now();
        // Keep re-baselining while the tab is still loading/settling.
        if (!seen || now - seen.at < 3000) {
            this.seen.set(wf, { sig, at: seen?.at ?? now });
            if (seen) seen.sig = sig;
            return;
        }
        if (sig !== seen.sig && graph.nodes?.length) this.shareCurrent();
    }

    /** Stop sharing the tab on screen (keeps a private copy). */
    unshareCurrent() {
        const wf = this.store?.activeWorkflow;
        if (!wf) return;
        if (this.targetKey) this.client.send({ type: "unshare", room: this.targetKey });
        if (wf.isTemporary) {
            this.optedOut.add(wf);
            delete this.graph().extra?.rigshare;
            wf.changeTracker?.checkState();
        } else {
            this.overrides[wf.path] = false;
            this.saveOverrides();
        }
        this.tick();
    }

    /**
     * ComfyUI replaces the graph first and only then switches the active tab
     * (opening a file, a template, drag-and-drop, switching tabs). Without a
     * guard, that half-finished state looks like "someone replaced the whole
     * shared workflow" and would be sent to the room of the old tab.
     */
    installLoadGuard() {
        const app = this.app;
        const original = app.loadGraphData.bind(app);
        app.loadGraphData = async (graphData, ...rest) => {
            const own = this.ownLoad > 0;
            // Content coming from outside (a file from disk, a template, a paste)
            // must not drag a RigShare room id along with it.
            const target = rest[2];
            if (!own && (target === undefined || target === null || typeof target === "string")
                && graphData && typeof graphData === "object" && graphData.extra?.rigshare) {
                graphData = { ...graphData, extra: { ...graphData.extra } };
                delete graphData.extra.rigshare;
            }
            this.loading++;
            try {
                return await original(graphData, ...rest);
            } finally {
                this.loading--;
                if (!own) {
                    // Re-evaluate the tab on screen from scratch: rejoin its room
                    // (the server copy wins) instead of diffing against the old tab.
                    this.baseline = null;
                    this.ready = false;
                    this.targetKey = undefined;
                    this.settleUntil = performance.now() + 1500;
                    setTimeout(() => this.tick(), 50);
                }
            }
        };
    }

    /** Find an already-open tab for a room. */
    findTab(room) {
        for (const wf of this.store?.openWorkflows || []) {
            const r = this.roomFor(wf);
            if (r?.key === room.key) return wf;
        }
        return null;
    }

    /** Open a room from the list (switching to its tab if already open). */
    async openRoom(room) {
        const store = this.store;
        let wf = this.findTab(room);
        if (wf && wf === store.activeWorkflow) return;
        const data = await this.client.request("GET", `/rigshare/api/room?key=${encodeURIComponent(room.key)}`);
        if (!wf && room.kind === "file") {
            const path = room.key.slice(5);
            if (this.overrides[path] === false) {
                delete this.overrides[path];
                this.saveOverrides();
            }
            await store.syncWorkflows?.();
            wf = store.getWorkflowByPath?.(path) ?? null;
            if (wf && !wf.isLoaded) await wf.load();
        }
        if (wf) {
            this.ownLoad++;
            try {
                await this.app.loadGraphData(data.doc ?? wf.activeState, true, true, wf);
            } finally {
                this.ownLoad--;
            }
        } else {
            // Unsaved shared tab (or a file that no longer exists): open a
            // temporary tab carrying the room id.
            const doc = structuredClone(data.doc || {});
            doc.extra = { ...(doc.extra || {}), rigshare: { room: room.key } };
            this.ownLoad++;
            try {
                await this.app.loadGraphData(doc, true, true, `${room.name}.json`);
            } finally {
                this.ownLoad--;
            }
        }
        this.tick();
    }
}
