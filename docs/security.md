# Security

What RigShare does to keep the rig yours, and what it leaves to you.

## Passwords

- Stored hashed (PBKDF2-SHA256, salted), never in plain text.
- At least 8 characters.
- Unknown usernames take as long to reject as wrong passwords, so accounts cannot be discovered by timing.
- Five failed logins from one address in a minute blocks that address for a minute.
- There are no default accounts. The first admin is created on first run, and only while no account exists.

## Sessions

- Signing in issues a **JWT** (HS256), signed with a 64-byte random key generated on first start (`secret.key`, file mode 600).
- Tokens live 12 hours and are silently renewed while in use. A login lasts at most 30 days.
- Each token names a server-side session. Logging out, changing a password or deleting an account ends access immediately, instead of whenever the token expires.
- Only HS256 is accepted, so `alg: none` and algorithm-swapping tokens are rejected. Signature, expiry, not-before and issuer are all checked.
- The token travels in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` over HTTPS. Page scripts cannot read it, and other sites cannot make your browser use it for changes.

## API keys

- Random 256-bit keys, stored only as SHA-256 hashes and shown once when created.
- They carry their owner's permissions, can be revoked at any time, and record when they were last used.

## Permissions

- The server checks identity and permissions on every websocket message and API call; the UI only mirrors them. A modified browser cannot impersonate someone else or edit without *Edit*.
- ComfyUI's queue, interrupt, free and upload endpoints are checked server-side, and so are saving (Edit) and deleting (Admin) workflow files (`api_protection`).
- Without *Admin*, account and server settings are refused.
- Without *Manager*, ComfyUI Manager's API is refused and its button hidden. Only a few read-only lookups the frontend makes for everyone stay open.
- A restricted workflow is refused to anyone not on its list: joining it, reading it, its snapshots, and its file through ComfyUI's API.

## What is up to you

- **Use HTTPS.** Over plain HTTP, the login and cookie cross the network in the clear. See [Reverse proxy](reverse-proxy.md).
- **Finish setup right away.** Until the first admin exists, anyone who reaches the page can create it.
- **Keep trusted IPs short.** They skip every check.
- **Custom nodes run code on the server.** RigShare controls who uses ComfyUI, but anyone who can queue can run whatever nodes are installed. Give *Queue* to people you trust.
- **Protect the data folder.** `secret.key` signs sessions and `users.json` holds the hashes.

Found a problem? Please open an issue, or for anything sensitive contact the maintainer privately first.
