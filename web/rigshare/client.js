// Connection, identity and HTTP helpers shared by every RigShare module.

const LS = {
    token: "rigshare.token",
    guestId: "rigshare.guestId",
    guestName: "rigshare.guestName",
};

function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
    try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch { /* private mode */ }
}

function randomId() {
    return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class RigClient extends EventTarget {
    constructor() {
        super();
        this.ws = null;
        this.status = "offline"; // offline | connecting | online | denied
        this.self = null;
        this.users = [];
        this.chat = [];          // loaded chat messages, oldest first
        this.chatMore = false;   // older messages exist on the server
        this.rooms = [];
        this.stats = null;
        this.server = {};
        this.retry = 0;
        this.token = storageGet(LS.token);
        this.guestId = storageGet(LS.guestId) || randomId();
        storageSet(LS.guestId, this.guestId);
        this.guestName = storageGet(LS.guestName) || "";
    }

    get perms() {
        return this.self?.perms ?? { edit: false, queue: false, admin: false };
    }

    get online() {
        return this.status === "online";
    }

    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    on(type, fn) {
        this.addEventListener(type, (e) => fn(e.detail));
    }

    // ----- websocket ------------------------------------------------------

    connect() {
        clearTimeout(this.reconnectTimer);
        const base = location.pathname.replace(/[^/]*$/, "");
        const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}rigshare/ws`;
        this.setStatus("connecting");
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => {
            this.retry = 0;
            this.hello();
        };
        ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            this.handle(msg);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            if (this.status !== "denied") this.setStatus("offline");
            const delay = Math.min(15000, 1000 * 2 ** this.retry++);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        };
    }

    hello() {
        this.send({ type: "hello", token: this.token, guest_id: this.guestId, name: this.guestName });
    }

    send(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
            return true;
        }
        return false;
    }

    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.emit("status", status);
    }

    handle(msg) {
        switch (msg.type) {
            case "welcome":
                this.self = msg.self;
                this.users = msg.users;
                this.chat = msg.chat || [];
                this.chatMore = !!msg.chat_more;
                this.rooms = msg.rooms || [];
                this.stats = msg.stats;
                this.server = msg.server || {};
                this.setStatus("online");
                this.emit("self", this.self);
                this.emit("presence", this.users);
                this.emit("chat-history", this.chat);
                this.emit("welcome", msg);
                this.emit("server", this.server);
                break;
            case "denied":
                this.self = null;
                this.denyReason = msg.reason;
                this.setStatus("denied");
                this.emit("self", null);
                if (msg.login) this.gotoLogin();
                break;
            case "self":
                this.self = msg.self;
                this.emit("self", this.self);
                break;
            case "logged_out":
                this.setToken(null);
                this.gotoLogin();
                this.emit("toast", { severity: "warn", summary: "RigShare", detail: "Your session ended. You are now a guest." });
                break;
            case "presence":
                this.users = msg.users;
                this.rooms = msg.rooms || this.rooms;
                this.emit("presence", this.users);
                break;
            case "server":
                this.server = msg.server || {};
                this.emit("server", this.server);
                break;
            case "stats":
                this.stats = msg.stats;
                this.emit("stats", msg.stats);
                break;
            case "chat_cleared":
                this.chat = [];
                this.chatMore = false;
                this.emit("chat-history", this.chat);
                break;
            case "chat":
                this.chat.push(msg.message);
                this.emit("chat", msg.message);
                break;
            default:
                this.emit(msg.type, msg);
        }
    }

    // ----- identity -------------------------------------------------------

    setToken(token) {
        this.token = token;
        storageSet(LS.token, token);
    }

    async login(username, password) {
        const res = await this.request("POST", "/rigshare/api/login", { username, password });
        this.setToken(res.token);
        this.reconnect();
        return res.user;
    }

    async logout() {
        try { await this.request("POST", "/rigshare/api/logout"); } catch { /* ignore */ }
        this.setToken(null);
        this.gotoLogin();
    }

    gotoLogin() {
        const base = location.pathname.replace(/[^/]*$/, "");
        const next = encodeURIComponent(location.pathname + location.search + location.hash);
        location.replace(`${base}rigshare/login?next=${next}`);
    }

    rename(name) {
        this.guestName = name;
        storageSet(LS.guestName, name);
        this.send({ type: "rename", name });
    }

    reconnect() {
        const ws = this.ws;
        this.ws = null;
        this.status = "offline";
        ws?.close();
        this.connect();
    }

    // Headers that identify this browser to the ComfyUI HTTP API.
    authHeaders() {
        if (this.token) return { "X-RigShare-Token": this.token };
        return { "X-RigShare-Guest": this.guestId };
    }

    /** Fetch the page of chat before the oldest loaded message; returns them (oldest first). */
    async loadOlderChat(limit = 50) {
        const oldest = this.chat[0]?.seq;
        if (!this.chatMore || oldest === undefined) return [];
        const data = await this.request("GET", `/rigshare/api/chat?before=${oldest}&limit=${limit}`);
        // A reconnect may have replaced the history meanwhile.
        if (this.chat[0]?.seq !== oldest) return [];
        this.chat.unshift(...data.messages);
        this.chatMore = data.more;
        return data.messages;
    }

    async request(method, path, body) {
        const base = location.pathname.replace(/[^/]*$/, "");
        const res = await fetch(base + path.replace(/^\//, ""), {
            method,
            headers: { "Content-Type": "application/json", ...this.authHeaders() },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let data = null;
        try { data = await res.json(); } catch { /* empty */ }
        if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
        return data;
    }
}
