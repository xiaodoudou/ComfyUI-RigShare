"""Workspace folders: a private space per account plus shared folders.

Inside ComfyUI's workflows directory::

    users/<username>/...   private: only its owner (and admins)
    shared/<folder>/...    shared folders: owner + optional access list
    anything else          common: everyone, with their account permissions

Paths handled here are relative to the *userdata* root, e.g.
``workflows/users/bob/flow.json``. ComfyUI decodes request paths twice, so
every path is fully URL-decoded and normalised before it is checked.
"""

import os
import posixpath
import re
import shutil
import time
from urllib.parse import unquote

WORKFLOWS = "workflows"
FOLDER_NAME_RE = re.compile(r"^[\w][\w .()-]{0,63}$")
ROLE_RANK = {None: 0, "view": 1, "edit": 2}


def full_unquote(value):
    for _ in range(5):
        if "%" not in value:
            break
        decoded = unquote(value)
        if decoded == value:
            break
        value = decoded
    return value


def norm(path):
    """Decode and normalise a userdata-relative path ('' for the root)."""
    path = full_unquote(str(path or "")).replace("\\", "/")
    return posixpath.normpath("/" + path).lstrip("/") if path else ""


def min_role(a, b):
    return a if ROLE_RANK[a] <= ROLE_RANK[b] else b


class Workspace:
    def __init__(self, store, root):
        self.store = store
        self.root = root  # absolute path of the workflows directory
        self.folders = store._read("folders.json", {})  # "shared/<name>" -> {owner, acl, created}
        os.makedirs(os.path.join(root, "users"), exist_ok=True)
        os.makedirs(os.path.join(root, "shared"), exist_ok=True)

    def save(self):
        self.store._write("folders.json", self.folders)

    # ----- classification -------------------------------------------------

    @staticmethod
    def area(rel):
        """Classify a path relative to the workflows dir.

        Returns ("private", username) | ("shared", "shared/<name>") |
        ("users-root", None) | ("shared-root", None) | ("common", None).
        """
        parts = [p for p in rel.split("/") if p]
        if not parts:
            return "common", None
        if parts[0] == "users":
            return ("private", parts[1]) if len(parts) > 1 else ("users-root", None)
        if parts[0] == "shared":
            return ("shared", "shared/" + parts[1]) if len(parts) > 1 else ("shared-root", None)
        return "common", None

    @staticmethod
    def workflows_rel(userdata_path):
        """'workflows/a/b.json' -> 'a/b.json'; None if outside workflows."""
        path = norm(userdata_path)
        if path == WORKFLOWS:
            return ""
        if path.startswith(WORKFLOWS + "/"):
            return path[len(WORKFLOWS) + 1:]
        return None

    # ----- access -------------------------------------------------------

    def folder_role(self, folder, kind, key, perms):
        can_edit = bool(perms.get("edit") or perms.get("admin"))
        meta = self.folders.get(folder)
        if perms.get("admin") or meta is None or not meta.get("acl"):
            return "edit" if can_edit else "view"
        if kind == "user" and key == meta.get("owner"):
            return "edit" if can_edit else "view"
        role = (meta["acl"].get("members") or {}).get(key) if kind == "user" else None
        if role not in ("view", "edit"):
            return None
        return "edit" if role == "edit" and can_edit else "view"

    def role(self, rel, kind, key, perms):
        """What someone may do with a path under workflows/: None, "view" or "edit"."""
        area, owner = self.area(rel)
        if area == "private":
            if perms.get("admin") or (kind == "user" and key == owner):
                return "edit"  # your own space, even with a viewer account
            return None
        if area == "shared":
            return self.folder_role(owner, kind, key, perms)
        if area in ("users-root", "shared-root"):
            return "view"
        return "edit" if (perms.get("edit") or perms.get("admin")) else "view"

    def can_manage(self, folder, kind, key, perms):
        meta = self.folders.get(folder) or {}
        return bool(perms.get("admin")) or (kind == "user" and key is not None and key == meta.get("owner"))

    def can_delete(self, rel, kind, key, perms):
        """Deleting (or moving out of a folder) removes the file for others."""
        area, owner = self.area(rel)
        if perms.get("admin"):
            return True
        if area == "private":
            return kind == "user" and key == owner
        if area == "shared":
            return self.can_manage(owner, kind, key, perms)
        return False  # common files: admins only

    def can_move(self, src, dest, kind, key, perms):
        if self.role(src, kind, key, perms) is None or self.role(dest, kind, key, perms) != "edit":
            return False
        if posixpath.dirname(src) == posixpath.dirname(dest):
            return self.role(src, kind, key, perms) == "edit"  # a rename in place
        return self.can_delete(src, kind, key, perms)

    # ----- listings -------------------------------------------------------

    def visible(self, rel, kind, key, perms):
        return self.role(rel, kind, key, perms) is not None

    def _files(self, rel_dir):
        base = os.path.join(self.root, *rel_dir.split("/")) if rel_dir else self.root
        out = []
        if not os.path.isdir(base):
            return out
        for dirpath, dirnames, filenames in os.walk(base):
            rel_here = os.path.relpath(dirpath, self.root).replace(os.sep, "/")
            rel_here = "" if rel_here == "." else rel_here
            if not rel_dir and rel_here.split("/")[0] in ("users", "shared"):
                dirnames[:] = []
                continue
            if not rel_dir:
                dirnames[:] = [d for d in dirnames if d not in ("users", "shared")]
            for name in filenames:
                if not name.endswith(".json"):
                    continue
                full = os.path.join(dirpath, name)
                rel = f"{rel_here}/{name}" if rel_here else name
                out.append({"path": f"{WORKFLOWS}/{rel}", "name": rel[len(rel_dir) + 1:] if rel_dir else rel,
                            "modified": int(os.path.getmtime(full))})
        out.sort(key=lambda f: f["name"].lower())
        return out

    def tree(self, kind, key, perms):
        """Everything this person may see, for the Files tab."""
        can_edit = bool(perms.get("edit") or perms.get("admin"))
        private = None
        if kind == "user":
            self.ensure_private(key)
            private = {"path": f"users/{key}", "files": self._files(f"users/{key}")}
        shared = []
        shared_dir = os.path.join(self.root, "shared")
        names = sorted(os.listdir(shared_dir), key=str.lower) if os.path.isdir(shared_dir) else []
        for name in names:
            folder = f"shared/{name}"
            if not os.path.isdir(os.path.join(shared_dir, name)):
                continue
            role = self.folder_role(folder, kind, key, perms)
            if role is None:
                continue
            meta = self.folders.get(folder) or {}
            shared.append({"path": folder, "name": name, "owner": meta.get("owner"),
                           "restricted": bool(meta.get("acl")), "role": role,
                           "manage": self.can_manage(folder, kind, key, perms),
                           "files": self._files(folder)})
        return {"me": key if kind == "user" else None, "private": private, "shared": shared,
                "common": {"files": self._files(""), "role": "edit" if can_edit else "view"},
                "can_create": can_edit}

    # ----- changes ------------------------------------------------------

    def ensure_private(self, username):
        os.makedirs(os.path.join(self.root, "users", username), exist_ok=True)

    def create_folder(self, name, owner):
        name = (name or "").strip()
        if not FOLDER_NAME_RE.match(name) or name in (".", ".."):
            raise ValueError("Folder names: up to 64 letters, digits, spaces and . _ - ( )")
        path = os.path.join(self.root, "shared", name)
        if os.path.exists(path):
            raise ValueError("A folder with that name already exists")
        os.makedirs(path)
        self.folders[f"shared/{name}"] = {"owner": owner, "acl": None, "created": int(time.time())}
        self.save()
        return f"shared/{name}"

    def rename_folder(self, folder, new_name):
        new_name = (new_name or "").strip()
        if not FOLDER_NAME_RE.match(new_name):
            raise ValueError("Folder names: up to 64 letters, digits, spaces and . _ - ( )")
        new_folder = f"shared/{new_name}"
        src = os.path.join(self.root, *folder.split("/"))
        dst = os.path.join(self.root, "shared", new_name)
        if os.path.exists(dst):
            raise ValueError("A folder with that name already exists")
        os.rename(src, dst)
        self.folders[new_folder] = self.folders.pop(folder, {"owner": None, "acl": None})
        self.save()
        return new_folder

    def delete_folder(self, folder):
        path = os.path.join(self.root, *folder.split("/"))
        if self._files(folder):
            raise ValueError("Move or delete the workflows inside it first")
        shutil.rmtree(path, ignore_errors=True)
        self.folders.pop(folder, None)
        self.save()

    def set_acl(self, folder, acl, fallback_owner=None):
        meta = self.folders.setdefault(folder, {"owner": None, "acl": None, "created": int(time.time())})
        meta["acl"] = acl
        if acl and not meta.get("owner"):
            meta["owner"] = fallback_owner
        self.save()
        return meta

    def rename_user(self, old, new):
        src = os.path.join(self.root, "users", old)
        dst = os.path.join(self.root, "users", new)
        if os.path.isdir(src) and not os.path.exists(dst):
            os.rename(src, dst)
        for meta in self.folders.values():
            if meta.get("owner") == old:
                meta["owner"] = new
            members = (meta.get("acl") or {}).get("members") or {}
            if old in members:
                members[new] = members.pop(old)
        self.save()

    def forget_member(self, username):
        for meta in self.folders.values():
            members = (meta.get("acl") or {}).get("members") or {}
            members.pop(username, None)
        self.save()
