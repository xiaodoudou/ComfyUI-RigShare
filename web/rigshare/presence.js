// Remote cursors, remote selections and "follow" (spectate) mode.

const CURSOR_TTL = 20000;

export class Presence extends EventTarget {
    constructor(app, client, sync) {
        super();
        this.app = app;
        this.client = client;
        this.sync = sync;
        this.cursors = new Map(); // client id -> {x, y, graph, sel, vp, at}
        this.following = null;
        this.showCursors = true;
        this.showNames = true;
        this.lastSent = "";
        this.pending = false;

        client.on("cursor", (m) => this.onCursor(m));
        let lastRoom = null;
        sync.addEventListener("state", () => {
            if (sync.targetKey !== lastRoom) {
                lastRoom = sync.targetKey;
                this.cursors.clear();
                this.redraw();
            }
        });
        client.on("leave", (m) => { this.cursors.delete(m.id); this.redraw(); });
        client.on("presence", (users) => {
            const ids = new Set(users.map((u) => u.id));
            for (const id of this.cursors.keys()) if (!ids.has(id)) this.cursors.delete(id);
            if (this.following && !ids.has(this.following)) this.follow(null);
        });

        window.addEventListener("pointermove", () => { this.pending = true; }, { passive: true });
        // User takes the wheel: stop following.
        window.addEventListener("pointerdown", (e) => {
            if (this.following && e.target?.tagName === "CANVAS") this.follow(null);
        }, true);
        window.addEventListener("wheel", (e) => {
            if (this.following && e.target?.tagName === "CANVAS") this.follow(null);
        }, { capture: true, passive: true });

        setInterval(() => this.sendState(), 70);
        document.addEventListener("visibilitychange", () => {
            client.send({ type: "idle", idle: document.hidden });
        });
    }

    install() {
        const canvas = this.app.canvas;
        const previous = canvas.onDrawForeground;
        canvas.onDrawForeground = (ctx, area) => {
            previous?.call(canvas, ctx, area);
            try { this.draw(ctx); } catch (e) { console.error("[RigShare] draw", e); }
        };
    }

    currentGraphId() {
        const g = this.app.canvas?.graph;
        const root = this.app.rootGraph ?? this.app.graph;
        return !g || g === root ? null : g.id ?? null;
    }

    viewport() {
        const canvas = this.app.canvas;
        const rect = canvas.canvas.getBoundingClientRect();
        const center = canvas.ds.convertCanvasToOffset([rect.width / 2, rect.height / 2]);
        return { cx: Math.round(center[0]), cy: Math.round(center[1]), scale: +canvas.ds.scale.toFixed(3) };
    }

    sendState() {
        if (!this.client.online || !this.app.canvas) return;
        let msg;
        if (!this.sync.live || document.hidden || this.sync.inAppMode) {
            msg = { type: "cursor", x: null, y: null };
        } else {
            const [x, y] = this.app.canvas.graph_mouse ?? [0, 0];
            const sel = Object.keys(this.app.canvas.selected_nodes ?? {});
            msg = { type: "cursor", x: Math.round(x), y: Math.round(y), graph: this.currentGraphId(), sel, vp: this.viewport() };
        }
        const key = JSON.stringify(msg);
        if (key === this.lastSent) return;
        this.lastSent = key;
        this.client.send(msg);
    }

    onCursor(m) {
        if (m.room !== this.sync.targetKey) return;
        this.cursors.set(m.id, { ...m, at: Date.now() });
        if (m.id === this.following && m.vp && this.sync.live) this.applyViewport(m.vp, m.graph);
        this.redraw();
    }

    async follow(id) {
        this.following = id || null;
        const user = id && this.userFor(id);
        const room = user?.room && this.client.rooms.find((r) => r.key === user.room);
        if (room && room.key !== this.sync.targetKey) {
            try { await this.sync.openRoom(room); } catch (e) { console.error("[RigShare] follow", e); }
        }
        const c = id && this.cursors.get(id);
        if (c?.vp) this.applyViewport(c.vp, c.graph);
        this.dispatchEvent(new CustomEvent("follow", { detail: this.following }));
    }

    applyViewport(vp, graphId) {
        if (graphId !== this.currentGraphId() || this.sync.inAppMode) return;
        const canvas = this.app.canvas;
        const rect = canvas.canvas.getBoundingClientRect();
        canvas.ds.scale = vp.scale;
        canvas.ds.offset[0] = rect.width / 2 / vp.scale - vp.cx;
        canvas.ds.offset[1] = rect.height / 2 / vp.scale - vp.cy;
        canvas.setDirty(true, true);
    }

    redraw() {
        this.app.canvas?.setDirty(true, false);
    }

    userFor(id) {
        return this.client.users.find((u) => u.id === id);
    }

    draw(ctx) {
        const visible = new Set();
        if (!this.sync.live || !this.showCursors || this.sync.inAppMode) return this.pruneCursorEls(visible);
        const canvas = this.app.canvas;
        const graph = canvas.graph;
        const scale = canvas.ds.scale;
        const here = this.currentGraphId();
        const now = Date.now();

        for (const [id, c] of this.cursors) {
            const user = this.userFor(id);
            if (!user || (c.graph ?? null) !== here) continue;
            const color = user.color;

            // Selection outlines.
            for (const nodeId of c.sel || []) {
                const node = graph.getNodeById(isNaN(+nodeId) ? nodeId : +nodeId);
                if (!node) continue;
                const [x, y, w, h] = node.boundingRect ?? [node.pos[0], node.pos[1] - 30, node.size[0], node.size[1] + 30];
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2 / scale;
                ctx.setLineDash([6 / scale, 4 / scale]);
                ctx.strokeRect(x - 4 / scale, y - 4 / scale, w + 8 / scale, h + 8 / scale);
                ctx.restore();
            }

            if (c.x == null || now - c.at > CURSOR_TTL) continue;
            visible.add(id);
            this.placeCursor(id, user, c);
        }
        this.pruneCursorEls(visible);
    }

    // Cursors live in a DOM layer above the canvas so they stay on top of
    // DOM-rendered content (image previews, text widgets, Vue nodes).
    overlay() {
        if (!this.layer) {
            this.layer = document.createElement("div");
            this.layer.className = "rs-cursor-layer";
            document.body.append(this.layer);
            this.els = new Map();
        }
        return this.layer;
    }

    placeCursor(id, user, c) {
        const layer = this.overlay();
        let el = this.els.get(id);
        if (!el) {
            el = document.createElement("div");
            el.className = "rs-cursor";
            el.innerHTML = '<svg width="16" height="22" viewBox="0 0 16 22"><path d="M1 1v17l4.5-4 3.5 7.5 3-1.5-3.5-7.2H14z" stroke="rgba(0,0,0,.6)" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="rs-cursor-name"></span>';
            layer.append(el);
            this.els.set(id, el);
        }
        const canvas = this.app.canvas;
        const rect = canvas.canvas.getBoundingClientRect();
        const [x, y] = canvas.ds.convertOffsetToCanvas([c.x, c.y]);
        const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
        el.style.display = inside ? "" : "none";
        el.style.transform = `translate(${rect.left + x}px, ${rect.top + y}px)`;
        el.querySelector("path").setAttribute("fill", user.color);
        const name = el.querySelector(".rs-cursor-name");
        name.textContent = user.name;
        name.style.background = user.color;
        name.style.display = this.showNames ? "" : "none";
    }

    pruneCursorEls(visible) {
        if (!this.els) return;
        for (const [id, el] of this.els) {
            if (!visible.has(id)) {
                el.remove();
                this.els.delete(id);
            }
        }
    }
}
