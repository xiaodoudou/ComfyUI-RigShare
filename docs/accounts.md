# Accounts and permissions

## Permissions

| Permission | Allows |
|---|---|
| *(none)*, a viewer | Watch shared workflows, chat, follow people, open snapshots as private copies |
| **Edit** | Change shared workflows, save or rename workflow files, take and restore snapshots, upload files |
| **Queue** | Queue prompts, interrupt, free memory |
| **Manager** | Open ComfyUI Manager: install, update or remove custom nodes and models, snapshots, restart |
| **Admin** | Everything, plus deleting workflow files, accounts and server settings |

Queueing, uploads, and saving or deleting workflow files are checked by the server too, when *Enforce permissions on the ComfyUI API* is on (the default). A viewer cannot get around it with a script.

## Managing accounts

Admins use **Admin → Accounts** in the RigShare panel:

- **New account**: username, optional display name, password, permissions
- toggle **Edit / Queue / Manager / Admin** per account; the change applies immediately, with no re-login needed
- 🪪 change the display name shown to others
- ✏️ change the login username, your own included. Sessions and API keys keep working.
- 🔑 set a new password, which signs that user out everywhere
- 🗑 delete the account

Admins can also toggle Edit, Queue and Manager straight from the **People** tab.

A shared workflow can also be restricted to chosen people, with *Can view* or *Can edit* each. See [Who can open it](sharing.md#who-can-open-it).

The last admin cannot be demoted or deleted.

## Your own account

Click your avatar at the top of the panel:

- change your display name
- change your password; your other sessions are signed out, this one stays signed in
- create and revoke [API keys](api.md)
- log out

## Guests

With **Require login** off, *Allow guests* lets people in without an account. They appear as *Guest-xxxx* and get the guest permissions from `config.json`. That suits a trusted LAN only; the default is to require a login.
