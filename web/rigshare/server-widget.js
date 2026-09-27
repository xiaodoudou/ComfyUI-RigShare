// Floating cards over the canvas: the server monitor and performance. Docking,
// dragging and the magnet come from FloatCard (float.js).

import { h } from "./ui.js";
import { FloatCard } from "./float.js";
import { timerView } from "./perf.js";
import { confirmModal } from "./files.js";

function mini(label, pct, text) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const level = p > 90 ? "hot" : p > 70 ? "warm" : "";
    return h("div", { class: "rs-mini", title: `${label}: ${text}` },
        h("span", { class: "rs-mini-label" }, label),
        h("span", { class: "rs-mini-track" }, h("span", { class: `rs-meter-fill ${level}`, style: `width:${p}%` })),
        h("span", { class: "rs-mini-text" }, text));
}

/** Server monitor; admins also get ComfyUI's memory actions. */
export class ServerWidget extends FloatCard {
    constructor(client, onChange, { inAppMode } = {}) {
        super({ key: "rigshare.serverFloat", title: "Server", icon: "pi-server", inAppMode, onChange });
        this.client = client;
        client.on("stats", () => this.render());
        client.on("self", () => this.render());
        this.start();
    }

    async free(options, done) {
        try {
            await this.client.request("POST", "/api/free", options);
            this.client.emit("toast", { severity: "success", summary: "RigShare", detail: done });
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

/** Performance: only the timer (the history is in the Server tab). */
export class PerfWidget extends FloatCard {
    constructor(client, onChange, { inAppMode, workflow } = {}) {
        super({ key: "rigshare.perfFloat", title: "Performance", icon: "pi-stopwatch", inAppMode, onChange, className: "rs-float-perf" });
        this.client = client;
        this.workflow = workflow ?? (() => null); // name of the workflow on screen
        this.receivedAt = Date.now();
        client.on("stats", () => { this.receivedAt = Date.now(); this.render(); });
        // The clock keeps ticking between server updates; the workflow on screen may change.
        setInterval(() => { if (this.el) this.render(); }, 250);
        this.start();
    }

    headButtons() {
        return [h("button", {
            class: "rs-float-close", title: "Clear the timings of the workflow on screen",
            onclick: () => this.clear(),
        }, h("i", { class: "pi pi-eraser" }))];
    }

    async clear() {
        const wf = this.workflow();
        if (!wf) return this.client.emit("toast", { severity: "info", summary: "RigShare", detail: "Open a workflow first." });
        const runs = this.client.stats?.performance?.etas?.[wf]?.runs;
        const ok = await confirmModal("Clear timings",
            `Forget every recorded run of "${wf}"? Its ETA starts over${runs ? ` (it is based on ${runs} run${runs > 1 ? "s" : ""})` : ""}.`,
            "Clear", true);
        if (!ok) return;
        try {
            const res = await this.client.request("DELETE", `/rigshare/api/performance?workflow=${encodeURIComponent(wf)}`);
            this.client.emit("toast", { severity: "success", summary: "RigShare", detail: `Cleared ${res.cleared} run${res.cleared === 1 ? "" : "s"} of "${wf}"` });
        } catch (e) {
            this.client.emit("toast", { severity: "error", summary: "RigShare", detail: e.message || String(e) });
        }
    }

    render() {
        if (!this.el) return;
        const key = JSON.stringify([this.client.stats?.performance?.running, this.client.stats?.performance?.etas, this.workflow()]);
        const running = this.client.stats?.performance?.running?.length;
        if (!running && key === this.lastKey) return; // idle: nothing moves
        this.lastKey = key;
        this.body.replaceChildren(...timerView(this.client.stats?.performance, this.receivedAt, this.workflow()));
    }
}
