// Optional floating server monitor: a small draggable card over the canvas.
//
// The magnet docks it in the bottom-right corner and keeps it there: beside the
// minimap in the graph, in the corner of the App view. Dragging it undocks it.
// Admins also get ComfyUI's memory actions (unload models, free models & cache).

import { h, storage } from "./ui.js";

const KEY_ON = "rigshare.serverFloat";
const KEY_POS = "rigshare.serverFloatPos";
const KEY_MAGNET = "rigshare.serverFloatMagnet";
const GAP = 10;

// Lucide "magnet" (ISC), inline: neither PrimeIcons nor ComfyUI ships one.
const MAGNET_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round"><path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/>
  <path d="m5 8 4 4"/><path d="m12 15 4 4"/></svg>`;

function mini(label, pct, text) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const level = p > 90 ? "hot" : p > 70 ? "warm" : "";
    return h("div", { class: "rs-mini", title: `${label}: ${text}` },
        h("span", { class: "rs-mini-label" }, label),
        h("span", { class: "rs-mini-track" }, h("span", { class: `rs-meter-fill ${level}`, style: `width:${p}%` })),
        h("span", { class: "rs-mini-text" }, text));
}

/** Visible element's box, or null. */
function box(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
}

export class ServerWidget {
    constructor(client, onChange, { inAppMode } = {}) {
        this.client = client;
        this.onChange = onChange;
        this.inAppMode = inAppMode ?? (() => false);
        this.enabled = storage.get(KEY_ON) === "1";
        this.magnet = storage.get(KEY_MAGNET) !== "0"; // docked unless the user moved it
        this.el = null;
        client.on("stats", () => this.render());
        client.on("self", () => this.render());
        window.addEventListener("resize", () => this.dock());
        setInterval(() => this.dock(), 500); // panels open and close, the minimap toggles...
        if (this.enabled) this.show();
    }

    toggle() {
        this.enabled = !this.enabled;
        storage.set(KEY_ON, this.enabled ? "1" : null);
        this.enabled ? this.show() : this.hide();
        this.onChange?.();
    }

    show() {
        if (this.el) return;
        this.body = h("div", { class: "rs-float-body" });
        this.magnetBtn = h("button", {
            class: "rs-float-close rs-float-magnet", title: "Dock in the bottom-right corner",
            onclick: () => this.setMagnet(!this.magnet),
        });
        this.magnetBtn.innerHTML = MAGNET_SVG;
        const head = h("div", { class: "rs-float-head" },
            h("i", { class: "pi pi-server" }), h("span", { class: "rs-grow" }, "Server"),
            this.magnetBtn,
            h("button", { class: "rs-float-close", title: "Close", onclick: () => this.toggle() }, h("i", { class: "pi pi-times" })));
        this.actions = h("div", { class: "rs-float-actions" });
        this.el = h("div", { class: "rs-float rs-panel-vars" }, head, this.body, this.actions);
        let pos = null;
        try { pos = JSON.parse(storage.get(KEY_POS)); } catch { /* default */ }
        document.body.append(this.el);
        this.place(pos?.x ?? window.innerWidth - 300, pos?.y ?? 70);
        this.drag(head);
        this.render();
        this.paintMagnet();
        this.dock();
    }

    hide() {
        this.el?.remove();
        this.el = null;
    }

    setMagnet(on) {
        this.magnet = on;
        storage.set(KEY_MAGNET, on ? null : "0");
        this.paintMagnet();
        this.dock();
    }

    paintMagnet() {
        this.magnetBtn?.classList.toggle("active", this.magnet);
        if (this.magnetBtn) this.magnetBtn.title = this.magnet ? "Docked: drag to undock" : "Dock in the bottom-right corner";
    }

    /** The docked position: beside the minimap in the graph, the corner of the App view. */
    dockTarget() {
        const w = this.el.offsetWidth;
        const hgt = this.el.offsetHeight;
        if (this.inAppMode()) {
            const area = box("#linearCenterPanel") ?? { right: window.innerWidth, bottom: window.innerHeight };
            return { x: area.right - w - GAP, y: area.bottom - hgt - GAP };
        }
        const minimap = box('[data-testid="minimap-container"]');
        if (minimap) return { x: minimap.left - w - GAP, y: minimap.bottom - hgt };
        // No minimap: the canvas corner, above ComfyUI's zoom controls.
        const canvas = box("#graph-canvas-container") ?? box("#graph-canvas") ?? { right: window.innerWidth, bottom: window.innerHeight };
        const controls = box('[data-testid="toggle-minimap-button"]');
        const bottom = controls ? Math.min(canvas.bottom, controls.top) : canvas.bottom;
        return { x: canvas.right - w - GAP, y: bottom - hgt - GAP };
    }

    dock() {
        if (!this.el || !this.magnet) return;
        const { x, y } = this.dockTarget();
        this.place(x, y);
    }

    place(x, y) {
        const w = this.el.offsetWidth || 260;
        const hgt = this.el.offsetHeight || 120;
        x = Math.max(4, Math.min(window.innerWidth - w - 4, x));
        y = Math.max(4, Math.min(window.innerHeight - hgt - 4, y));
        this.el.style.left = `${Math.round(x)}px`;
        this.el.style.top = `${Math.round(y)}px`;
        return { x, y };
    }

    drag(handle) {
        handle.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button")) return;
            e.preventDefault();
            const startX = e.clientX - this.el.offsetLeft;
            const startY = e.clientY - this.el.offsetTop;
            let moved = false;
            const move = (ev) => {
                if (!moved && this.magnet) this.setMagnet(false); // moving it by hand undocks it
                moved = true;
                this.place(ev.clientX - startX, ev.clientY - startY);
            };
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                if (moved) storage.set(KEY_POS, JSON.stringify({ x: this.el.offsetLeft, y: this.el.offsetTop }));
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        });
    }

    async free(options, done) {
        try {
            const res = await this.client.request("POST", "/api/free", options);
            this.client.emit("toast", { severity: "success", summary: "RigShare", detail: done });
            return res;
        } catch (e) {
            this.client.emit("toast", { severity: "error", summary: "RigShare", detail: e.message || String(e) });
        }
    }

    render() {
        if (!this.el) return;
        const st = this.client.stats;
        const admin = !!this.client.perms?.admin;
        this.actions.style.display = admin ? "" : "none";
        if (admin && !this.actions.childElementCount) {
            this.actions.append(
                h("button", {
                    class: "rs-btn rs-btn-sm", title: "Unload the models ComfyUI is holding in memory",
                    onclick: () => this.free({ unload_models: true }, "Models unloaded"),
                }, "Unload models"),
                h("button", {
                    class: "rs-btn rs-btn-sm", title: "Unload the models and clear the node cache (the next run starts from scratch)",
                    onclick: () => this.free({ unload_models: true, free_memory: true }, "Models and cache freed"),
                }, "Free models & cache"));
        }
        if (!st) {
            this.body.replaceChildren(h("div", { class: "rs-muted rs-small" }, "Waiting for data…"));
            return;
        }
        const rows = [];
        if (st.cpu != null) rows.push(mini("CPU", st.cpu, `${Math.round(st.cpu)}%`));
        if (st.ram_total) rows.push(mini("RAM", (st.ram_used / st.ram_total) * 100, `${Math.round(st.ram_used)}G`));
        for (const g of st.gpus || []) {
            rows.push(mini(`GPU${g.index}`, g.util, `${g.util}%${g.temp != null ? ` ${g.temp}°` : ""}`));
            rows.push(mini(`VRAM${g.index}`, (g.vram_used / g.vram_total) * 100, `${g.vram_used.toFixed(1)}G`));
        }
        const q = st.queue;
        if (q) rows.push(h("div", { class: "rs-mini-queue" }, q.running || q.pending ? `${q.running} running · ${q.pending} queued` : "queue idle"));
        this.body.replaceChildren(...rows);
    }
}
