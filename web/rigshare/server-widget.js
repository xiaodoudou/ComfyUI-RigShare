// Optional floating server monitor: a small draggable card over the canvas.

import { h, storage } from "./ui.js";

const KEY_ON = "rigshare.serverFloat";
const KEY_POS = "rigshare.serverFloatPos";

function mini(label, pct, text) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const level = p > 90 ? "hot" : p > 70 ? "warm" : "";
    return h("div", { class: "rs-mini", title: `${label}: ${text}` },
        h("span", { class: "rs-mini-label" }, label),
        h("span", { class: "rs-mini-track" }, h("span", { class: `rs-meter-fill ${level}`, style: `width:${p}%` })),
        h("span", { class: "rs-mini-text" }, text));
}

export class ServerWidget {
    constructor(client, onChange) {
        this.client = client;
        this.onChange = onChange;
        this.enabled = storage.get(KEY_ON) === "1";
        this.el = null;
        client.on("stats", () => this.render());
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
        const head = h("div", { class: "rs-float-head" },
            h("i", { class: "pi pi-server" }), h("span", { class: "rs-grow" }, "Server"),
            h("button", { class: "rs-float-close", title: "Close", onclick: () => this.toggle() }, h("i", { class: "pi pi-times" })));
        this.el = h("div", { class: "rs-float rs-panel-vars" }, head, this.body);
        let pos = null;
        try { pos = JSON.parse(storage.get(KEY_POS)); } catch { /* default */ }
        this.place(pos?.x ?? window.innerWidth - 300, pos?.y ?? 70);
        document.body.append(this.el);
        this.drag(head);
        this.render();
    }

    hide() {
        this.el?.remove();
        this.el = null;
    }

    place(x, y) {
        const w = this.el.offsetWidth || 260;
        const hgt = this.el.offsetHeight || 120;
        x = Math.max(4, Math.min(window.innerWidth - w - 4, x));
        y = Math.max(4, Math.min(window.innerHeight - hgt - 4, y));
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
        return { x, y };
    }

    drag(handle) {
        handle.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button")) return;
            e.preventDefault();
            const startX = e.clientX - this.el.offsetLeft;
            const startY = e.clientY - this.el.offsetTop;
            const move = (ev) => this.place(ev.clientX - startX, ev.clientY - startY);
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                storage.set(KEY_POS, JSON.stringify({ x: this.el.offsetLeft, y: this.el.offsetTop }));
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        });
    }

    render() {
        if (!this.el) return;
        const st = this.client.stats;
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
