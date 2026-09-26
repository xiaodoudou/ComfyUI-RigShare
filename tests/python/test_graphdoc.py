"""Workflow patches: apply, link repair, conflict renumbering, JS parity."""

import copy
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from helpers import ROOT
from rigshare_core.graphdoc import apply_patch, reconcile, remap_conflicts, link_id, link_ends


def node(nid, n_in=2, n_out=1):
    return {"id": nid, "type": "T", "pos": [0, 0],
            "inputs": [{"name": f"i{i}", "link": None} for i in range(n_in)],
            "outputs": [{"name": f"o{j}", "links": []} for j in range(n_out)]}


def doc_with(n=3, links=()):
    doc = {"last_node_id": n, "last_link_id": len(links), "nodes": [node(i + 1) for i in range(n)],
           "links": [list(l) for l in links], "groups": [], "extra": {}, "version": 0.4}
    return reconcile(doc)


def assert_consistent(doc):
    ids = {n["id"] for n in doc["nodes"]}
    links = {link_id(l): l for l in doc["links"]}
    assert len(links) == len(doc["links"]), "duplicate link ids"
    assert len(ids) == len(doc["nodes"]), "duplicate node ids"
    for l in doc["links"]:
        origin, _, target, _ = link_ends(l)
        assert origin in ids and target in ids, "dangling link"
    for n in doc["nodes"]:
        for i, slot in enumerate(n["inputs"]):
            if slot["link"] is not None:
                _, _, target, target_slot = link_ends(links[slot["link"]])
                assert (target, target_slot) == (n["id"], i)


def test_upsert_and_remove_nodes():
    doc = doc_with(3)
    moved = copy.deepcopy(doc["nodes"][0]); moved["pos"] = [5, 5]
    out = apply_patch(doc, {"nodes": [moved, node(4)], "removed": [2]})
    assert [n["id"] for n in out["nodes"]] == [1, 3, 4]
    assert out["nodes"][0]["pos"] == [5, 5]
    assert doc["nodes"][0]["pos"] == [0, 0], "input document must not be mutated"


def test_links_merge_by_id():
    doc = doc_with(3, [(1, 1, 0, 2, 0, "X")])
    out = apply_patch(doc, {"links": {"upsert": [[2, 3, 0, 2, 1, "X"]]}})
    assert sorted(link_id(l) for l in out["links"]) == [1, 2], "a new link must not erase another"


def test_max_keys_never_go_backwards():
    doc = doc_with(3)
    doc["last_node_id"] = 10
    assert apply_patch(doc, {"set": {"last_node_id": 4}})["last_node_id"] == 10


def test_reconcile_drops_dangling_and_duplicate_inputs():
    doc = doc_with(3)
    doc["links"] = [[1, 1, 0, 2, 0, "X"], [2, 3, 0, 2, 0, "X"], [3, 9, 0, 2, 1, "X"]]
    reconcile(doc)
    assert [link_id(l) for l in doc["links"]] == [2], "newest link on a slot wins, dangling dropped"
    assert doc["nodes"][1]["inputs"][0]["link"] == 2
    assert doc["nodes"][2]["outputs"][0]["links"] == [2]
    assert_consistent(doc)


def test_remap_simultaneous_adds():
    base = doc_with(2)
    def add(target_slot):
        return {"nodes": [node(3)], "added": [3],
                "links": {"upsert": [[1, 3, 0, 2, target_slot, "X"]], "added": [1]},
                "set": {"last_node_id": 3, "last_link_id": 1}}
    server = base
    pa, changed_a = remap_conflicts(server, add(0)); server = apply_patch(server, pa)
    pb, changed_b = remap_conflicts(server, add(1)); server = apply_patch(server, pb)
    assert not changed_a and changed_b
    assert sorted(n["id"] for n in server["nodes"]) == [1, 2, 3, 4]
    assert sorted(link_id(l) for l in server["links"]) == [1, 2]
    assert_consistent(server)


def test_remap_leaves_updates_of_existing_nodes_alone():
    doc = doc_with(3)
    update = copy.deepcopy(doc["nodes"][0]); update["pos"] = [1, 1]
    patch, changed = remap_conflicts(doc, {"nodes": [update]})
    assert not changed and patch["nodes"][0]["id"] == 1


def test_concurrent_edits_converge():
    rnd = random.Random(1)
    for _ in range(100):
        server = doc_with(4, [(1, 1, 0, 2, 0, "X")])
        observer = copy.deepcopy(server)
        patches = []
        for _ in range(2):  # two people, same base, same instant
            nid, lid = server["last_node_id"] + 1, server["last_link_id"] + 1
            target = rnd.choice([n["id"] for n in server["nodes"]])
            patches.append({"nodes": [node(nid)], "added": [nid],
                            "links": {"upsert": [[lid, nid, 0, target, rnd.randint(0, 1), "X"]], "added": [lid]},
                            "set": {"last_node_id": nid, "last_link_id": lid}})
        for p in patches:
            p2, _ = remap_conflicts(server, p)
            server = apply_patch(server, p2)
            observer = apply_patch(observer, p2)
        assert_consistent(server)
        assert len(server["nodes"]) == 6
        assert json.dumps(server, sort_keys=True) == json.dumps(observer, sort_keys=True)


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_javascript_mirror_matches(tmp_path):
    """graphdoc.js must produce exactly the same documents as graphdoc.py."""
    rnd = random.Random(7)
    cases = []
    for _ in range(60):
        doc = doc_with(5, [(1, 1, 0, 2, 0, "X"), (2, 3, 0, 4, 1, "X")])
        patches, cur = [], doc
        for _ in range(5):
            ids = [n["id"] for n in cur["nodes"]]
            p = {}
            if rnd.random() < .5:
                n = copy.deepcopy(rnd.choice(cur["nodes"])); n["pos"] = [rnd.randint(0, 99), 0]; p["nodes"] = [n]
            if rnd.random() < .4 and len(ids) > 1:
                a, b = rnd.sample(ids, 2); lid = cur["last_link_id"] + 1
                p["links"] = {"upsert": [[lid, a, 0, b, rnd.randint(0, 1), "X"]], "added": [lid]}
                p["set"] = {"last_link_id": lid}
            if rnd.random() < .2 and len(ids) > 3:
                p["removed"] = [rnd.choice(ids)]
            patches.append(p)
            cur = apply_patch(cur, p)
        cases.append({"doc": doc, "patches": patches, "expected": cur})
    data = tmp_path / "cases.json"
    data.write_text(json.dumps(cases))
    module = (Path(ROOT) / "web" / "rigshare" / "graphdoc.js").as_uri()
    script = tmp_path / "check.mjs"
    script.write_text(
        f'import fs from "fs"; import {{ applyPatch }} from "{module}";\n'
        'const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); let bad = 0;\n'
        'for (const c of cases) { let cur = c.doc; for (const p of c.patches) cur = applyPatch(cur, p);\n'
        '  if (JSON.stringify(cur) !== JSON.stringify(c.expected)) bad++; }\n'
        'console.log(bad); process.exit(bad ? 1 : 0);\n')
    result = subprocess.run(["node", str(script), str(data)], capture_output=True, text=True)
    assert result.returncode == 0, f"{result.stdout} mismatching cases\n{result.stderr}"
