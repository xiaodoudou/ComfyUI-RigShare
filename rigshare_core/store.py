"""Persistent state for RigShare: accounts, sessions, guests, config, rooms
and snapshots.

Everything lives as small JSON files in ``<ComfyUI>/rigshare``. Writes are atomic
(write to a temp file then rename) so a crash never leaves a half-written file.
"""

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time

from . import jwt

log = logging.getLogger("ComfyUI-RigShare")

PBKDF2_ITERATIONS = 240_000
SESSION_TTL = 30 * 24 * 3600      # a login lasts at most this long
TOKEN_TTL = 12 * 3600              # each JWT is short-lived...
TOKEN_REFRESH = 6 * 3600           # ...and re-issued while in use once older than this
ISSUER = "rigshare"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
PERMS = ("edit", "queue", "manager", "admin")
API_KEY_PREFIX = "rs_"

DEFAULT_CONFIG = {
    "server_name": "RigShare",
    # Everyone must log in before ComfyUI loads (login page + session cookie).
    # API clients authenticate with a personal API key.
    "require_login": True,
    # Only when require_login is off: visitors without an account can watch and chat.
    "allow_guests": False,
    "guest_permissions": {"edit": False, "queue": False},
    # Relay execution progress/previews to every connected browser, not only
    # the one that queued the prompt.
    "broadcast_execution": True,
    # Reject queue/interrupt/upload HTTP calls from users lacking permission.
    # Requests from trusted IPs skip both this and the login requirement.
    "api_protection": {
        "enabled": True,
        "trusted_ips": ["127.0.0.1", "::1"],
    },
    # Hide ComfyUI's own Comfy.org account sign-in (top-bar button and dialog).
    "hide_comfy_account": False,
    # ComfyUI's own Workflows and Apps sidebar tabs duplicate RigShare's Files tab.
    "hide_comfy_file_tabs": True,
    # Remove templates that need paid API nodes from the template browser.
    "hide_api_templates": False,
    # Rooms nobody opened for this many days are forgotten.
    "room_expiry_days": 14,
    "snapshot_interval_sec": 300,
    "snapshot_keep": 30,
    "chat_keep": 0,  # 0 keeps the whole chat; N trims it to the last N messages at startup
}


def _hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def _verify_password(password, stored):
    try:
        _, iterations, salt, digest = stored.split("$")
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(candidate.hex(), digest)
    except (ValueError, AttributeError):
        return False


def _deep_merge(base, override):
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


class Store:
    def __init__(self, folder):
        self.folder = folder
        self.snapshot_dir = os.path.join(folder, "snapshots")
        self.room_dir = os.path.join(folder, "rooms")
        os.makedirs(self.snapshot_dir, exist_ok=True)
        os.makedirs(self.room_dir, exist_ok=True)
        self._lock = threading.RLock()

        self.secret = self._load_secret()
        self.config = _deep_merge(DEFAULT_CONFIG, self._read("config.json", {}))
        self._write("config.json", self.config)
        self.users = self._read("users.json", {})
        self.sessions = self._read("sessions.json", {})
        self.guests = self._read("guests.json", {})

        self._provision_admin()
        self._prune_sessions()

    # ----- file helpers -------------------------------------------------

    def _path(self, name):
        return os.path.join(self.folder, name)

    def _read(self, name, default):
        try:
            with open(self._path(name), "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return default
        except (OSError, ValueError) as e:
            log.error(f"[RigShare] Could not read {name}: {e}")
            return default

    def _write(self, name, data):
        with self._lock:
            path = self._path(name)
            tmp = f"{path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, path)

    # ----- setup --------------------------------------------------------

    def _load_secret(self):
        """JWT signing key, generated once and kept private to the server."""
        path = self._path("secret.key")
        try:
            with open(path, "rb") as f:
                secret = f.read()
            if len(secret) >= 32:
                return secret
        except FileNotFoundError:
            pass
        secret = secrets.token_bytes(64)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(secret)
        return secret

    def _provision_admin(self):
        """Optional scripted install: create the first admin from env vars.

        Otherwise there are no accounts until someone completes the first-run
        setup on the login page.
        """
        username = os.environ.get("RIGSHARE_ADMIN_USER")
        password = os.environ.get("RIGSHARE_ADMIN_PASSWORD")
        if self.users or not (username and password):
            if not self.users:
                log.warning("[RigShare] No accounts yet: open ComfyUI in a browser to create the admin account.")
            return
        self.create_user(username, password, perms={"edit": True, "queue": True, "admin": True})
        log.info(f"[RigShare] Created admin '{username}' from environment variables.")

    @property
    def needs_setup(self):
        return not self.users

    def setup_admin(self, username, password, display_name=None):
        """First-run setup: only allowed while no account exists."""
        with self._lock:
            if self.users:
                raise PermissionError("Setup is already complete")
            return self.create_user(username, password, display_name, {"edit": True, "queue": True, "admin": True})

    def _new_user(self, username, password, perms):
        return {
            "username": username,
            "display_name": username,
            "password": _hash_password(password),
            "perms": {p: bool(perms.get(p)) for p in PERMS},
            "created": int(time.time()),
        }

    def _prune_sessions(self):
        now = time.time()
        alive = {t: s for t, s in self.sessions.items() if s["expires"] > now and s["username"] in self.users}
        if len(alive) != len(self.sessions):
            self.sessions = alive
            self._write("sessions.json", self.sessions)

    # ----- config -------------------------------------------------------

    def update_config(self, patch):
        allowed = set(DEFAULT_CONFIG)
        clean = {k: v for k, v in patch.items() if k in allowed}
        self.config = _deep_merge(self.config, clean)
        self._write("config.json", self.config)
        return self.config

    # ----- accounts -----------------------------------------------------

    @staticmethod
    def public_user(user):
        return {
            "username": user["username"],
            "display_name": user.get("display_name") or user["username"],
            "perms": user["perms"],
            "created": user.get("created"),
        }

    def authenticate(self, username, password):
        user = self.users.get(username)
        if user and _verify_password(password, user["password"]):
            return user
        # Burn comparable time so unknown usernames are not distinguishable.
        _verify_password(password, _hash_password("x", b"0" * 16))
        return None

    def create_user(self, username, password, display_name=None, perms=None):
        if not USERNAME_RE.match(username or ""):
            raise ValueError("Username must be 2-32 characters: letters, digits, _ . -")
        if username in self.users:
            raise ValueError("Username already exists")
        if len(password or "") < 8:
            raise ValueError("Password must be at least 8 characters")
        user = self._new_user(username, password, perms or {})
        if display_name:
            user["display_name"] = display_name[:32]
        self.users[username] = user
        self._write("users.json", self.users)
        return user

    def rename_user(self, username, new_username):
        """Change a login name; sessions and API keys follow the account."""
        new_username = (new_username or "").strip()
        if new_username == username:
            return self.users[username]
        if username not in self.users:
            raise KeyError(username)
        if not USERNAME_RE.match(new_username):
            raise ValueError("Username must be 2-32 characters: letters, digits, _ . -")
        if new_username in self.users:
            raise ValueError("Username already exists")
        with self._lock:
            user = self.users.pop(username)
            user["username"] = new_username
            if user.get("display_name") in (None, "", username):
                user["display_name"] = new_username
            self.users[new_username] = user
            for session in self.sessions.values():
                if session["username"] == username:
                    session["username"] = new_username
            self._write("users.json", self.users)
            self._write("sessions.json", self.sessions)
        return user

    def update_user(self, username, display_name=None, perms=None, password=None):
        user = self.users.get(username)
        if not user:
            raise KeyError(username)
        if display_name is not None:
            user["display_name"] = display_name.strip()[:32] or username
        if perms is not None:
            new_perms = {p: bool(perms.get(p, user["perms"].get(p))) for p in PERMS}
            if user["perms"].get("admin") and not new_perms["admin"] and self._admin_count() <= 1:
                raise ValueError("Cannot remove the last admin")
            user["perms"] = new_perms
        if password is not None:
            if len(password) < 8:
                raise ValueError("Password must be at least 8 characters")
            user["password"] = _hash_password(password)
            self.revoke_sessions(username)
        self._write("users.json", self.users)
        return user

    def delete_user(self, username):
        user = self.users.get(username)
        if not user:
            raise KeyError(username)
        if user["perms"].get("admin") and self._admin_count() <= 1:
            raise ValueError("Cannot delete the last admin")
        del self.users[username]
        self._write("users.json", self.users)
        self.revoke_sessions(username)

    def _admin_count(self):
        return sum(1 for u in self.users.values() if u["perms"].get("admin"))

    # ----- sessions -----------------------------------------------------

    # Browser logins are JWTs (HS256, 12 h) that reference a server-side
    # session id. The session makes logout, password changes and account
    # deletion take effect immediately instead of waiting for expiry.

    def _issue(self, sid, username):
        now = int(time.time())
        return jwt.encode({"iss": ISSUER, "sub": username, "sid": sid, "iat": now, "nbf": now,
                           "exp": now + TOKEN_TTL}, self.secret)

    def create_session(self, username):
        sid = secrets.token_urlsafe(16)
        self.sessions[sid] = {"username": username, "expires": time.time() + SESSION_TTL, "created": int(time.time())}
        self._write("sessions.json", self.sessions)
        return self._issue(sid, username)

    def _session_claims(self, token, verify_exp=True):
        try:
            claims = jwt.decode(token, self.secret, ISSUER, verify_exp=verify_exp)
        except jwt.InvalidToken:
            return None
        session = self.sessions.get(claims.get("sid", ""))
        if not session or session["expires"] < time.time():
            return None
        # The session (not the token) says who this is, so renames keep sessions valid.
        return {**claims, "sub": session["username"]}

    def user_for_token(self, token):
        """Resolve a session JWT or a personal API key to a user."""
        if not token:
            return None
        if token.startswith(API_KEY_PREFIX):
            return self.user_for_api_key(token)
        claims = self._session_claims(token)
        return self.users.get(claims["sub"]) if claims else None

    def refresh_token(self, token):
        """Return a fresh JWT for the same session when this one is getting old."""
        if not token or token.startswith(API_KEY_PREFIX):
            return None
        claims = self._session_claims(token)
        if not claims or time.time() - claims.get("iat", 0) < TOKEN_REFRESH:
            return None
        return self._issue(claims["sid"], claims["sub"])

    # ----- API keys -----------------------------------------------------

    @staticmethod
    def _key_hash(key):
        return hashlib.sha256(key.encode()).hexdigest()

    def list_api_keys(self, username):
        user = self.users.get(username) or {}
        return [{k: v for k, v in key.items() if k != "hash"} for key in user.get("api_keys", [])]

    def create_api_key(self, username, name):
        user = self.users[username]
        key = API_KEY_PREFIX + secrets.token_urlsafe(32)
        entry = {"id": secrets.token_hex(4), "name": (name or "API key").strip()[:40],
                 "hash": self._key_hash(key), "hint": key[:len(API_KEY_PREFIX) + 4] + "..." + key[-4:],
                 "created": int(time.time()), "last_used": None}
        user.setdefault("api_keys", []).append(entry)
        self._write("users.json", self.users)
        return key, {k: v for k, v in entry.items() if k != "hash"}

    def revoke_api_key(self, username, key_id):
        user = self.users[username]
        before = len(user.get("api_keys", []))
        user["api_keys"] = [k for k in user.get("api_keys", []) if k["id"] != key_id]
        if len(user["api_keys"]) != before:
            self._write("users.json", self.users)
            return True
        return False

    def user_for_api_key(self, key):
        digest = self._key_hash(key)
        for user in self.users.values():
            for entry in user.get("api_keys", []):
                if hmac.compare_digest(entry["hash"], digest):
                    now = int(time.time())
                    if not entry.get("last_used") or now - entry["last_used"] > 300:
                        entry["last_used"] = now
                        self._write("users.json", self.users)
                    return user
        return None

    def revoke_session(self, token):
        claims = self._session_claims(token, verify_exp=False) if token else None
        if claims and self.sessions.pop(claims["sid"], None):
            self._write("sessions.json", self.sessions)

    def revoke_sessions(self, username):
        before = len(self.sessions)
        self.sessions = {t: s for t, s in self.sessions.items() if s["username"] != username}
        if len(self.sessions) != before:
            self._write("sessions.json", self.sessions)

    # ----- guests -------------------------------------------------------

    def guest_perms(self, guest_id):
        base = self.config["guest_permissions"]
        override = self.guests.get(guest_id, {})
        return {"edit": bool(override.get("edit", base.get("edit"))),
                "queue": bool(override.get("queue", base.get("queue"))),
                "admin": False}

    def set_guest_perms(self, guest_id, perms):
        entry = self.guests.setdefault(guest_id, {})
        for p in ("edit", "queue"):
            if p in perms:
                entry[p] = bool(perms[p])
        self._write("guests.json", self.guests)

    # ----- rooms ----------------------------------------------------------

    def _room_path(self, key):
        return os.path.join(self.room_dir, hashlib.sha1(key.encode()).hexdigest()[:20] + ".json")

    def load_rooms(self):
        rooms = []
        for name in os.listdir(self.room_dir):
            if name.endswith(".json"):
                try:
                    with open(os.path.join(self.room_dir, name), "r", encoding="utf-8") as f:
                        rooms.append(json.load(f))
                except (OSError, ValueError):
                    pass
        return rooms

    def save_room(self, room):
        path = self._room_path(room["key"])
        with self._lock:
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                json.dump(room, f)
            os.replace(path + ".tmp", path)

    def delete_room(self, key):
        try:
            os.remove(self._room_path(key))
        except OSError:
            pass

    # ----- snapshots ------------------------------------------------------

    def list_snapshots(self, room=None):
        items = []
        for name in sorted(os.listdir(self.snapshot_dir), reverse=True):
            if not name.endswith(".json"):
                continue
            path = os.path.join(self.snapshot_dir, name)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    meta = json.load(f).get("meta", {})
            except (OSError, ValueError):
                continue
            if room is None or meta.get("room") == room:
                items.append({"id": name[:-5], **meta})
        return items

    def add_snapshot(self, doc, author, room, room_name, label=None):
        snap_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
        meta = {
            "time": int(time.time()),
            "author": author,
            "label": (label or "")[:80],
            "room": room,
            "room_name": room_name,
            "nodes": len(doc.get("nodes", [])) if isinstance(doc, dict) else 0,
        }
        with open(os.path.join(self.snapshot_dir, snap_id + ".json"), "w", encoding="utf-8") as f:
            json.dump({"meta": meta, "doc": doc}, f)
        self._prune_snapshots(room)
        return {"id": snap_id, **meta}

    def get_snapshot(self, snap_id):
        if not re.match(r"^[\w-]+$", snap_id or ""):
            return None
        try:
            with open(os.path.join(self.snapshot_dir, snap_id + ".json"), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _prune_snapshots(self, room):
        keep = max(1, int(self.config.get("snapshot_keep", 30)))
        # Labelled (manual) snapshots are kept; only automatic ones rotate.
        auto = [s for s in self.list_snapshots(room) if not s.get("label")]
        for snap in auto[keep:]:
            try:
                os.remove(os.path.join(self.snapshot_dir, snap["id"] + ".json"))
            except OSError:
                pass
