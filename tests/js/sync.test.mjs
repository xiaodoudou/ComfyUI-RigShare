// Client sync: diffs round-trip, and loading a graph never leaks into the old tab's room.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= new EventTarget();
// RoomSync polls with setInterval; let those timers not keep the test process alive.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { const t = nativeSetInterval(...args); t.unref?.(); return t; };
globalThis.performance ??= { now: () => Date.now() };
const { RoomSync, snapshotOf, diffSnapshots } = await import("../../web/rigshare/sync.js");
const { applyPatch, reconcile } = await import("../../web/rigshare/graphdoc.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (id) => ({ id, type: "T", pos: [0, 0], inputs: [{ name: "a", link: null }, { name: "b", link: null }], outputs: [{ name: "o", links: [] }] });

test("diff then apply reproduces the edited workflow", () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let t = 0; t < 300; t++) {
        const base = reconcile({ last_node_id: 5, last_link_id: 2, nodes: [1, 2, 3, 4, 5].map(node),
            links: [[1, 1, 0, 2, 0, "X"], [2, 3, 0, 4, 1, "X"]], groups: [{ id: 1, title: "g" }], extra: { a: 1 }, version: 0.4 });
        const cur = structuredClone(base);
        if (rnd() < 0.5) cur.nodes[0].pos = [rnd(), rnd()];
        if (rnd() < 0.4) { cur.last_node_id++; cur.nodes.push(node(cur.last_node_id)); }
        if (rnd() < 0.4) { cur.last_link_id++; cur.links.push([cur.last_link_id, cur.nodes.at(-1).id, 0, 5, 0, "X"]); }
        if (rnd() < 0.3) cur.links = cur.links.filter((l) => l[0] !== 1);
        if (rnd() < 0.3) cur.groups[0].title = "renamed";
        if (rnd() < 0.2) cur.extra.b = 2;
        if (rnd() < 0.15) cur.nodes = cur.nodes.filter((n) => n.id !== 3);
        reconcile(cur);
        const patch = diffSnapshots(snapshotOf(base), snapshotOf(cur));
        const out = patch ? applyPatch(base, patch) : base;
        assert.equal(diffSnapshots(snapshotOf(out), snapshotOf(cur)), null);
    }
});

test("opening a file never overwrites the shared workflow of the previous tab", async () => {
    const graphA = { nodes: [node(1), node(2)], links: [], extra: {}, version: 0.4 };
    const fromDisk = { nodes: [{ id: 1, type: "ReActorFaceSwap" }, { id: 2, type: "LoadImage" }, { id: 3, type: "SaveImage" }], links: [], extra: {}, version: 0.4 };
    let current = structuredClone(graphA);
    const tabA = { path: "workflows/shared.json", filename: "shared.json", isTemporary: false };
    const store = { activeWorkflow: tabA, openWorkflows: [tabA] };
    const sent = [];
    const client = Object.assign(new EventTarget(), {
        online: true, perms: { edit: true }, rooms: [], users: [],
        on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); },
        emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); },
        send(m) { sent.push(m); return true; },
    });
    const app = {
        extensionManager: { workflow: store }, canvas: null,
        rootGraph: { serialize: () => structuredClone(current), extra: {}, getNodeById: () => null },
        // Like ComfyUI: swap the graph, yield, then switch to a new tab.
        async loadGraphData(data, clean, restore, target) {
            current = structuredClone(data);
            await sleep(30);
            if (typeof target === "string" || target == null) {
                const tab = { path: `workflows/${target}`, filename: target, isTemporary: true };
                store.openWorkflows.push(tab);
                store.activeWorkflow = tab;
            }
        },
    };
    const api = new EventTarget();
    const sync = new RoomSync(app, api, client);
    sync.overrides[tabA.path] = true;
    sync.tick();
    client.emit("room", { room: `file:${tabA.path}`, version: 1, doc: graphA, role: "edit", manage: true });
    await sleep(400);
    sent.length = 0;

    const loading = app.loadGraphData(fromDisk, true, true, "face swap.json");
    for (let i = 0; i < 5; i++) { api.dispatchEvent(new Event("graphChanged")); sync.checkLocal(); sync.tick(); await sleep(5); }
    await loading;
    for (let i = 0; i < 5; i++) { api.dispatchEvent(new Event("graphChanged")); sync.tick(); await sleep(20); }

    const leaked = sent.filter((m) => m.type === "graph" && m.room === `file:${tabA.path}`);
    assert.equal(leaked.length, 0, "the previous tab's room must not receive the new graph");
});
