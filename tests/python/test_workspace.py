"""Folder rules: path normalisation, roles, deletes, moves, browsing."""

import os

import pytest

from helpers import Store
from rigshare_core.workspace import Workspace, norm

ADMIN = {"edit": True, "queue": True, "admin": True}
EDITOR = {"edit": True, "queue": True, "admin": False}
VIEWER = {"edit": False, "queue": False, "admin": False}


@pytest.fixture
def ws(tmp_path):
    root = tmp_path / "workflows"
    root.mkdir()
    return Workspace(Store(str(tmp_path / "data")), str(root))


def touch(ws, rel):
    path = os.path.join(ws.root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write("{}")


@pytest.mark.parametrize("raw,expected", [
    ("workflows/a.json", "workflows/a.json"),
    ("workflows%2Fusers%2Fbob%2Fa.json", "workflows/users/bob/a.json"),
    ("workflows%252Fusers%252Fbob%252Fa.json", "workflows/users/bob/a.json"),
    ("workflows/shared/../users/bob/a.json", "workflows/users/bob/a.json"),
    ("../../etc/passwd", "etc/passwd"),
    ("workflows\\users\\bob", "workflows/users/bob"),
    ("", ""),
])
def test_norm(raw, expected):
    assert norm(raw) == expected


def test_areas():
    assert Workspace.area("users/bob/x.json") == ("private", "bob")
    assert Workspace.area("shared/Team/x.json") == ("shared", "shared/Team")
    assert Workspace.area("x.json") == ("common", None)
    assert Workspace.workflows_rel("workflows/a/b.json") == "a/b.json"
    assert Workspace.workflows_rel("subgraphs/x.json") is None


def test_private_space(ws):
    assert ws.role("users/bob/x.json", "user", "bob", VIEWER) == "edit", "own space even for viewer accounts"
    assert ws.role("users/bob/x.json", "user", "alice", EDITOR) is None
    assert ws.role("users/bob/x.json", "user", "root", ADMIN) == "edit"
    assert ws.can_delete("users/bob/x.json", "user", "bob", VIEWER)
    assert not ws.can_delete("users/bob/x.json", "user", "alice", EDITOR)


def test_common_space(ws):
    assert ws.role("x.json", "user", "alice", EDITOR) == "edit"
    assert ws.role("x.json", "user", "dave", VIEWER) == "view"
    assert not ws.can_delete("x.json", "user", "alice", EDITOR), "Common deletes are admin-only"
    assert ws.can_delete("x.json", "user", "root", ADMIN)


def test_shared_folder_access_list(ws):
    folder = ws.create_folder("Team", "bob")
    assert ws.role(f"{folder}/a.json", "user", "alice", EDITOR) == "edit", "open by default"
    ws.set_acl(folder, {"members": {"carol": "view", "erin": "edit"}})
    assert ws.role(f"{folder}/a.json", "user", "alice", EDITOR) is None
    assert ws.role(f"{folder}/a.json", "user", "carol", EDITOR) == "view"
    assert ws.role(f"{folder}/a.json", "user", "erin", EDITOR) == "edit"
    assert ws.role(f"{folder}/a.json", "user", "erin", VIEWER) == "view", "a role never exceeds account perms"
    assert ws.role(f"{folder}/a.json", "user", "bob", EDITOR) == "edit", "owner always"
    assert ws.can_delete(f"{folder}/a.json", "user", "bob", EDITOR)
    assert not ws.can_delete(f"{folder}/a.json", "user", "erin", EDITOR)


def test_moves(ws):
    folder = ws.create_folder("Team", "bob")
    assert ws.can_move("users/bob/a.json", f"{folder}/a.json", "user", "bob", EDITOR)
    assert ws.can_move(f"{folder}/a.json", f"{folder}/b.json", "user", "alice", EDITOR), "rename in place"
    assert not ws.can_move(f"{folder}/a.json", "users/alice/a.json", "user", "alice", EDITOR), "only owner moves out"
    assert not ws.can_move("users/bob/a.json", "users/alice/a.json", "user", "bob", EDITOR)


@pytest.mark.parametrize("name", ["", "..", "a/b", "x" * 80, ".hidden"])
def test_bad_folder_names(ws, name):
    with pytest.raises(ValueError):
        ws.create_folder(name, "bob")


def test_list_dir(ws):
    folder = ws.create_folder("Team", "bob")
    touch(ws, "common.json")
    touch(ws, "users/alice/secret.json")
    touch(ws, f"{folder}/plan.json")
    shared = ws.list_dir("@shared", "user", "alice", EDITOR)
    assert {e["name"] for e in shared["entries"]} == {"Team", "common"}
    ws.set_acl(folder, {"members": {}})
    shared = ws.list_dir("@shared", "user", "alice", EDITOR)
    assert {e["name"] for e in shared["entries"]} == {"common"}
    with pytest.raises(PermissionError):
        ws.list_dir("users/alice", "user", "bob", EDITOR)
    with pytest.raises(PermissionError):
        ws.list_dir("users", "user", "bob", EDITOR)
    mine = ws.list_dir("users/alice", "user", "alice", EDITOR)
    assert [e["name"] for e in mine["entries"]] == ["secret"] and mine["can_mkdir"]


def test_folder_operations(ws):
    touch(ws, "users/alice/keep.json")
    sub = ws.make_dir("users/alice", "renders", "user", "alice", EDITOR)
    assert sub == "users/alice/renders"
    with pytest.raises(PermissionError):
        ws.make_dir("users/alice", "x", "user", "bob", EDITOR)
    with pytest.raises(PermissionError):
        ws.rename_dir("users/alice", "hack", "user", "alice", EDITOR)
    assert ws.rename_dir(sub, "finals", "user", "alice", EDITOR) == "users/alice/finals"
    team = ws.make_dir("@shared", "Team", "user", "bob", EDITOR)
    assert team == "shared/Team" and ws.folders[team]["owner"] == "bob"
    assert ws.move_dir("users/alice/finals", team, "user", "alice", EDITOR) == "shared/Team/finals"
    with pytest.raises(PermissionError):
        ws.delete_dir(team, "user", "alice", EDITOR)
    ws.delete_dir("shared/Team/finals", "user", "bob", EDITOR)
    with pytest.raises(PermissionError):
        ws.delete_dir("users/alice", "user", "alice", EDITOR)


def test_rename_user_moves_private_folder(ws):
    touch(ws, "users/alice/keep.json")
    ws.create_folder("Team", "alice")
    ws.rename_user("alice", "alicia")
    assert os.path.exists(os.path.join(ws.root, "users", "alicia", "keep.json"))
    assert ws.folders["shared/Team"]["owner"] == "alicia"
