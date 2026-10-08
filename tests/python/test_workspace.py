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


@pytest.mark.parametrize("raw", ["C:/models", "C:", "a/D:x/b", r"..\..\x", "c%3A%5Cmodels"])
def test_norm_drops_drive_segments(raw):
    assert ":" not in norm(raw) and ".." not in norm(raw).split("/")


@pytest.mark.parametrize("bad", ["C:/models", "C:", "..", "a/../..", "x:y"])
def test_safe_join_refuses_escapes(ws, bad):
    from rigshare_core.workspace import safe_join
    with pytest.raises(PermissionError):
        safe_join(ws.root, bad)


def test_folder_ops_cannot_leave_the_workspace(ws, tmp_path):
    outside = tmp_path / "models"
    outside.mkdir()
    (outside / "keep.txt").write_text("x")
    # A colon segment (drive prefix) is refused outright; a plain absolute path is only ever
    # read relative to the workflows root (a leading slash is dropped), so it can't reach `outside`.
    for bad in ("C:" + str(outside)[2:], "shared/C:evil"):
        with pytest.raises(PermissionError):
            ws.delete_folder(bad)
        with pytest.raises(PermissionError):
            ws.rename_folder(bad, "renamed")
    for plain in (str(outside), str(outside).replace("\\", "/")):
        try:
            ws.delete_folder(plain)
        except (PermissionError, ValueError):
            pass
    assert (outside / "keep.txt").exists()


@pytest.mark.parametrize("raw", ["users./bob/a.json", "users /bob", "USERS~1/bob", "users/bob./a.json"])
def test_norm_drops_windows_aliases(raw):
    if os.name != "nt" and ("." in raw.split("/")[0] or " " in raw.split("/")[0]):
        pytest.skip("trailing dots and spaces only alias on Windows")
    assert "~1" not in norm(raw)


@pytest.mark.skipif(os.name != "nt", reason="case-insensitive filesystem")
def test_case_variants_cannot_bypass_private_folders(ws):
    touch(ws, "users/alice/a.json")
    assert norm("Users/Alice/a.json") == "users/alice/a.json"
    assert norm("Workflows/USERS/ALICE") == "workflows/users/alice"
    assert ws.role(norm("USERS/alice/a.json"), "user", "bob", EDITOR) is None


def test_name_rules():
    from rigshare_core.workspace import FOLDER_NAME_RE
    from rigshare_core.store import USERNAME_RE
    for bad in ("con", "NUL", "com1.txt", "art.", "art ", "bad\n"):
        assert not FOLDER_NAME_RE.match(bad), bad
    for bad in ("..", "bob.", ".bob", "con", "aux", "ab\n", "a"):
        assert not USERNAME_RE.match(bad), bad
    for ok in ("Art (v2)", "a", "my-folder"):
        assert FOLDER_NAME_RE.match(ok), ok
    for ok in ("bob", "al.ice", "x_y-z", "ab"):
        assert USERNAME_RE.match(ok), ok
