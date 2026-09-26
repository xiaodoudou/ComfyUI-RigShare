"""Accounts, passwords, JWT sessions, API keys, snapshots."""

import json
import time

import pytest

from helpers import PASSWORD
from rigshare_core import jwt
import rigshare_core.store as store_module


def make_admin(store, name="admin"):
    return store.setup_admin(name, PASSWORD)


# ----- setup and accounts ------------------------------------------------

def test_no_default_accounts(store):
    assert store.needs_setup
    assert store.users == {}


def test_setup_only_once(store):
    user = make_admin(store)
    assert user["perms"]["admin"] and not store.needs_setup
    with pytest.raises(PermissionError):
        store.setup_admin("intruder", PASSWORD)


def test_env_provisioning(tmp_path, monkeypatch):
    monkeypatch.setenv("RIGSHARE_ADMIN_USER", "ops")
    monkeypatch.setenv("RIGSHARE_ADMIN_PASSWORD", PASSWORD)
    s = store_module.Store(str(tmp_path))
    assert s.users["ops"]["perms"]["admin"]


def test_passwords_are_hashed(store, tmp_path):
    make_admin(store)
    raw = (tmp_path / "users.json").read_text()
    assert PASSWORD not in raw
    assert store.users["admin"]["password"].startswith("pbkdf2_sha256$")


def test_authenticate(store):
    make_admin(store)
    assert store.authenticate("admin", PASSWORD)
    assert store.authenticate("admin", "wrong-password") is None
    assert store.authenticate("nobody", PASSWORD) is None


@pytest.mark.parametrize("username,password", [("x", PASSWORD), ("bad name", PASSWORD), ("ok_name", "short")])
def test_create_user_validation(store, username, password):
    make_admin(store)
    with pytest.raises(ValueError):
        store.create_user(username, password)


def test_last_admin_is_protected(store):
    make_admin(store)
    with pytest.raises(ValueError):
        store.delete_user("admin")
    with pytest.raises(ValueError):
        store.update_user("admin", perms={"admin": False})


def test_password_change_revokes_sessions(store):
    make_admin(store)
    token = store.create_session("admin")
    store.update_user("admin", password="another-password")
    assert store.user_for_token(token) is None


# ----- JWT sessions --------------------------------------------------------

def claims_of(token):
    return json.loads(jwt._b64d(token.split(".")[1]))


def test_session_is_jwt(store):
    make_admin(store)
    token = store.create_session("admin")
    assert token.count(".") == 2
    assert store.user_for_token(token)["username"] == "admin"


def test_tampered_token_rejected(store):
    make_admin(store)
    header, body, sig = store.create_session("admin").split(".")
    forged = jwt._b64e(json.dumps({**claims_of(f"{header}.{body}.{sig}"), "sub": "someone"}).encode())
    assert store.user_for_token(f"{header}.{forged}.{sig}") is None
    assert store.user_for_token(f"{header}.{body}.{sig[:-2]}AA") is None


def test_alg_none_rejected(store):
    make_admin(store)
    _, body, _ = store.create_session("admin").split(".")
    none_header = jwt._b64e(b'{"alg":"none","typ":"JWT"}')
    assert store.user_for_token(f"{none_header}.{body}.") is None


def test_expired_token_rejected(store):
    make_admin(store)
    sid = claims_of(store.create_session("admin"))["sid"]
    old = jwt.encode({"iss": "rigshare", "sub": "admin", "sid": sid, "iat": 0, "nbf": 0, "exp": 1}, store.secret)
    assert store.user_for_token(old) is None


def test_logout_revokes_immediately(store):
    make_admin(store)
    token = store.create_session("admin")
    store.revoke_session(token)
    assert store.user_for_token(token) is None


def test_refresh_only_when_old(store, monkeypatch):
    make_admin(store)
    token = store.create_session("admin")
    assert store.refresh_token(token) is None
    monkeypatch.setattr(store_module, "TOKEN_REFRESH", -1)
    fresh = store.refresh_token(token)
    assert fresh and store.user_for_token(fresh)["username"] == "admin"
    assert claims_of(fresh)["sid"] == claims_of(token)["sid"]


def test_rename_keeps_sessions_and_keys(store):
    make_admin(store)
    token = store.create_session("admin")
    key, _ = store.create_api_key("admin", "k")
    store.rename_user("admin", "root")
    assert store.user_for_token(token)["username"] == "root"
    assert store.user_for_token(key)["username"] == "root"


# ----- API keys ---------------------------------------------------------------

def test_api_keys(store, tmp_path):
    make_admin(store)
    key, meta = store.create_api_key("admin", "script")
    assert key.startswith("rs_") and key not in (tmp_path / "users.json").read_text()
    assert store.user_for_token(key)["username"] == "admin"
    assert "hash" not in store.list_api_keys("admin")[0]
    store.revoke_api_key("admin", meta["id"])
    assert store.user_for_token(key) is None


# ----- snapshots ----------------------------------------------------------------

def test_snapshot_rotation_keeps_labelled(store):
    store.update_config({"snapshot_keep": 2})
    for i in range(4):
        store.add_snapshot({"nodes": []}, "me", "room", "Room")
        time.sleep(0.01)
    store.add_snapshot({"nodes": []}, "me", "room", "Room", label="keep me")
    snaps = store.list_snapshots("room")
    assert len([s for s in snaps if not s["label"]]) == 2
    assert any(s["label"] == "keep me" for s in snaps)
