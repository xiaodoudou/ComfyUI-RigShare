// Workflow document patches. Mirrors apply_patch()/reconcile() in
// rigshare_core/graphdoc.py exactly: clients and server must reach the same
// document from the same patches. See that file for the patch format.

const KEYED = ["links", "groups"];
const MAX_KEYS = ["last_node_id", "last_link_id"];

export function linkId(link) {
    return Array.isArray(link) ? link[0] : link?.id;
}

export function linkEnds(link) {
    return Array.isArray(link)
        ? [link[1], link[2], link[3], link[4]]
        : [link.origin_id, link.origin_slot, link.target_id, link.target_slot];
}

export function itemId(key, item) {
    return key === "links" ? linkId(item) : item?.id;
}

function num(value) {
    const n = Number(value);
    return value === null || value === undefined || Number.isNaN(n) ? -Infinity : n;
}

function mergeKeyed(key, current, change) {
    const items = [...(current || [])];
    const removed = new Set(change.removed || []);
    const index = new Map(items.map((it, i) => [itemId(key, it), i]));
    for (const it of change.upsert || []) {
        const i = index.get(itemId(key, it));
        if (i === undefined) {
            index.set(itemId(key, it), items.length);
            items.push(it);
        } else {
            items[i] = it;
        }
    }
    return items.filter((it) => !removed.has(itemId(key, it)));
}

const slotKey = (id, slot) => JSON.stringify([id, slot]);

export function reconcile(doc) {
    const nodes = doc.nodes || [];
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = doc.links;
    if (!Array.isArray(links)) return doc;
    const byTarget = new Map();
    // Stable sort by id: the newest link on an input slot wins.
    const sorted = links.map((l, i) => [l, i]).sort((a, b) => (num(linkId(a[0])) - num(linkId(b[0]))) || (a[1] - b[1]));
    for (const [link] of sorted) {
        const [origin, , target, targetSlot] = linkEnds(link);
        if (nodeIds.has(origin) && nodeIds.has(target)) byTarget.set(slotKey(target, targetSlot), link);
    }
    const keep = new Set([...byTarget.values()].map(linkId));
    doc.links = links.filter((l) => keep.has(linkId(l)));
    for (const node of nodes) {
        (node.inputs || []).forEach((slot, i) => {
            if (slot && typeof slot === "object") {
                const link = byTarget.get(slotKey(node.id, i));
                slot.link = link ? linkId(link) : null;
            }
        });
        (node.outputs || []).forEach((slot, j) => {
            if (slot && typeof slot === "object") {
                const ids = doc.links.filter((l) => { const e = linkEnds(l); return e[0] === node.id && e[1] === j; }).map(linkId);
                slot.links = ids.length || (slot.links !== null && slot.links !== undefined) ? ids : null;
            }
        });
    }
    return doc;
}

export function applyPatch(doc, patch) {
    if ("full" in patch) return structuredClone(patch.full);
    doc = structuredClone(doc || {});
    const nodes = [...(doc.nodes || [])];
    const removed = new Set(patch.removed || []);
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    for (let node of patch.nodes || []) {
        node = structuredClone(node);
        const i = index.get(node.id);
        if (i === undefined) {
            index.set(node.id, nodes.length);
            nodes.push(node);
        } else {
            nodes[i] = node;
        }
    }
    doc.nodes = nodes.filter((n) => !removed.has(n.id));
    for (const key of KEYED) {
        const change = patch[key];
        if (change && typeof change === "object" && !Array.isArray(change)) doc[key] = mergeKeyed(key, doc[key], structuredClone(change));
    }
    for (const [key, value] of Object.entries(patch.set || {})) {
        if (key === "nodes") continue;
        if (MAX_KEYS.includes(key) && typeof value === "number" && typeof doc[key] === "number") doc[key] = Math.max(doc[key], value);
        else doc[key] = structuredClone(value);
    }
    for (const key of patch.unset || []) delete doc[key];
    const hasLinks = !!(patch.links?.upsert?.length || patch.links?.removed?.length);
    if (hasLinks || patch.nodes?.length || patch.removed?.length) reconcile(doc);
    return doc;
}
