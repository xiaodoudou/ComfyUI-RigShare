"""Workflow document patches: apply, conflict remapping and link repair.

``web/rigshare/graphdoc.js`` mirrors ``apply_patch`` and ``reconcile`` exactly;
clients and server must reach the same document from the same patches.

A patch (all keys optional)::

    {
      "nodes":   [node, ...],                      # upserted by id
      "removed": [node_id, ...],
      "added":   [node_id, ...],                   # ids the sender believes are new
      "links":   {"upsert": [...], "removed": [...], "added": [...]},
      "groups":  {"upsert": [...], "removed": [...]},
      "set":     {key: value, ...},                # any other top-level key
      "unset":   [key, ...],
      "full":    doc                               # replace everything
    }

Links and groups merge by id, so two people connecting things at the same
time keep both changes. ``reconcile`` then rebuilds every node's slot link
references from the links list, dropping dangling links and keeping only
the newest link on an input slot.
"""

import copy

KEYED = ("links", "groups")
MAX_KEYS = ("last_node_id", "last_link_id")


def link_id(link):
    return link[0] if isinstance(link, list) else (link or {}).get("id")


def link_ends(link):
    """(origin_id, origin_slot, target_id, target_slot)"""
    if isinstance(link, list):
        return link[1], link[2], link[3], link[4]
    return link.get("origin_id"), link.get("origin_slot"), link.get("target_id"), link.get("target_slot")


def _set_link(link, **values):
    if isinstance(link, list):
        link = list(link)
        for key, value in values.items():
            link[{"id": 0, "origin_id": 1, "target_id": 3}[key]] = value
        return link
    return {**link, **values}


def item_id(key, item):
    return link_id(item) if key == "links" else (item or {}).get("id")


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("-inf")


def _merge_keyed(key, current, change):
    items = list(current or [])
    removed = set(change.get("removed") or [])
    index = {item_id(key, it): i for i, it in enumerate(items)}
    for it in change.get("upsert") or []:
        i = index.get(item_id(key, it))
        if i is None:
            index[item_id(key, it)] = len(items)
            items.append(it)
        else:
            items[i] = it
    return [it for it in items if item_id(key, it) not in removed]


def reconcile(doc):
    """Make node slot references agree with the links list."""
    nodes = doc.get("nodes") or []
    node_ids = {n.get("id") for n in nodes}
    links = doc.get("links")
    if not isinstance(links, list):
        return doc
    by_target = {}
    for link in sorted(links, key=lambda l: _num(link_id(l))):
        origin, _, target, target_slot = link_ends(link)
        if origin in node_ids and target in node_ids:
            by_target[(target, target_slot)] = link
    keep = {link_id(l) for l in by_target.values()}
    doc["links"] = [l for l in links if link_id(l) in keep]
    for node in nodes:
        nid = node.get("id")
        for i, slot in enumerate(node.get("inputs") or []):
            if isinstance(slot, dict):
                link = by_target.get((nid, i))
                slot["link"] = link_id(link) if link else None
        for j, slot in enumerate(node.get("outputs") or []):
            if isinstance(slot, dict):
                ids = [link_id(l) for l in doc["links"] if link_ends(l)[0] == nid and link_ends(l)[1] == j]
                slot["links"] = ids if ids or slot.get("links") is not None else None
    return doc


def apply_patch(doc, patch):
    if "full" in patch:
        return copy.deepcopy(patch["full"])
    doc = copy.deepcopy(doc or {})
    nodes = list(doc.get("nodes") or [])
    removed = set(patch.get("removed") or [])
    index = {n.get("id"): i for i, n in enumerate(nodes)}
    for node in patch.get("nodes") or []:
        node = copy.deepcopy(node)
        i = index.get(node.get("id"))
        if i is None:
            index[node.get("id")] = len(nodes)
            nodes.append(node)
        else:
            nodes[i] = node
    doc["nodes"] = [n for n in nodes if n.get("id") not in removed]
    for key in KEYED:
        if isinstance(patch.get(key), dict):
            doc[key] = _merge_keyed(key, doc.get(key), copy.deepcopy(patch[key]))
    for key, value in (patch.get("set") or {}).items():
        if key == "nodes":
            continue
        if key in MAX_KEYS and isinstance(value, (int, float)) and isinstance(doc.get(key), (int, float)):
            doc[key] = max(doc[key], value)
        else:
            doc[key] = copy.deepcopy(value)
    for key in patch.get("unset") or []:
        doc.pop(key, None)
    links_change = patch.get("links") if isinstance(patch.get("links"), dict) else {}
    if links_change.get("upsert") or links_change.get("removed") or patch.get("nodes") or patch.get("removed"):
        reconcile(doc)
    return doc


def remap_conflicts(doc, patch):
    """Renumber nodes/links the sender added that already exist in ``doc``.

    Returns ``(patch, changed)``. Only ids listed in ``added`` are considered:
    those are new for the sender, so an existing id means someone else took
    it in the meantime.
    """
    doc = doc or {}
    existing_nodes = {n.get("id") for n in doc.get("nodes") or []}
    existing_links = {link_id(l) for l in doc.get("links") or []}
    links_change = patch.get("links") if isinstance(patch.get("links"), dict) else {}

    def next_free(start, taken):
        value = start
        while value in taken:
            value += 1
        return value

    node_numbers = [i for i in existing_nodes if isinstance(i, int)] + [doc.get("last_node_id") or 0]
    link_numbers = [i for i in existing_links if isinstance(i, int)] + [doc.get("last_link_id") or 0]
    node_map, link_map = {}, {}
    taken_nodes = set(existing_nodes) | {n.get("id") for n in patch.get("nodes") or []}
    taken_links = set(existing_links) | {link_id(l) for l in links_change.get("upsert") or []}
    candidate = max(n for n in node_numbers if isinstance(n, (int, float))) + 1
    for nid in patch.get("added") or []:
        if nid in existing_nodes and isinstance(nid, int):
            candidate = next_free(int(candidate), taken_nodes)
            node_map[nid] = candidate
            taken_nodes.add(candidate)
    candidate = max(n for n in link_numbers if isinstance(n, (int, float))) + 1
    for lid in links_change.get("added") or []:
        if lid in existing_links and isinstance(lid, int):
            candidate = next_free(int(candidate), taken_links)
            link_map[lid] = candidate
            taken_links.add(candidate)
    if not node_map and not link_map:
        return patch, False

    patch = copy.deepcopy(patch)
    added_nodes = set(patch.get("added") or [])
    added_links = set(links_change.get("added") or [])
    for node in patch.get("nodes") or []:
        # Only the sender's new node carries the conflicting id; an existing
        # node with the same id in the patch is an update of someone else's.
        if node.get("id") in node_map and node.get("id") in added_nodes:
            node["id"] = node_map[node["id"]]
        for slot in node.get("inputs") or []:
            if isinstance(slot, dict) and slot.get("link") in link_map:
                slot["link"] = link_map[slot["link"]]
        for slot in node.get("outputs") or []:
            if isinstance(slot, dict) and slot.get("links"):
                slot["links"] = [link_map.get(l, l) for l in slot["links"]]
    if isinstance(patch.get("links"), dict):
        fixed = []
        for link in patch["links"].get("upsert") or []:
            lid = link_id(link)
            origin, _, target, _ = link_ends(link)
            values = {}
            if lid in link_map and lid in added_links:
                values["id"] = link_map[lid]
            if origin in node_map:
                values["origin_id"] = node_map[origin]
            if target in node_map:
                values["target_id"] = node_map[target]
            fixed.append(_set_link(link, **values) if values else link)
        patch["links"]["upsert"] = fixed
        patch["links"]["added"] = [link_map.get(l, l) for l in links_change.get("added") or []]
    patch["added"] = [node_map.get(n, n) for n in patch.get("added") or []]
    patch.setdefault("set", {})
    if node_map:
        patch["set"]["last_node_id"] = max([patch["set"].get("last_node_id") or 0, *node_map.values()])
    if link_map:
        patch["set"]["last_link_id"] = max([patch["set"].get("last_link_id") or 0, *link_map.values()])
    return patch, True
