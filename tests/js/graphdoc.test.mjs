// Workflow patch logic on the client (mirror of rigshare_core/graphdoc.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, reconcile, linkId } from "../../web/rigshare/graphdoc.js";

const node = (id) => ({ id, type: "T", inputs: [{ name: "a", link: null }, { name: "b", link: null }], outputs: [{ name: "o", links: [] }] });
const doc = (links = []) => reconcile({ last_node_id: 3, last_link_id: links.length, nodes: [1, 2, 3].map(node), links, groups: [], extra: {} });

test("upserts and removes nodes without mutating the input", () => {
    const base = doc();
    const moved = { ...structuredClone(base.nodes[0]), pos: [5, 5] };
    const out = applyPatch(base, { nodes: [moved, node(4)], removed: [2] });
    assert.deepEqual(out.nodes.map((n) => n.id), [1, 3, 4]);
    assert.equal(base.nodes.length, 3);
});

test("links merge by id instead of replacing each other", () => {
    const out = applyPatch(doc([[1, 1, 0, 2, 0, "X"]]), { links: { upsert: [[2, 3, 0, 2, 1, "X"]] } });
    assert.deepEqual(out.links.map(linkId).sort(), [1, 2]);
    assert.deepEqual(out.nodes[1].inputs.map((s) => s.link), [1, 2]);
});

test("last ids never go backwards", () => {
    const base = { ...doc(), last_node_id: 10 };
    assert.equal(applyPatch(base, { set: { last_node_id: 4 } }).last_node_id, 10);
});

test("reconcile drops dangling links and keeps the newest link per input", () => {
    const d = doc();
    d.links = [[1, 1, 0, 2, 0, "X"], [2, 3, 0, 2, 0, "X"], [3, 9, 0, 2, 1, "X"]];
    reconcile(d);
    assert.deepEqual(d.links.map(linkId), [2]);
    assert.equal(d.nodes[1].inputs[0].link, 2);
    assert.deepEqual(d.nodes[2].outputs[0].links, [2]);
});

test("full replaces the document", () => {
    const out = applyPatch(doc(), { full: { nodes: [], links: [] } });
    assert.deepEqual(out, { nodes: [], links: [] });
});
