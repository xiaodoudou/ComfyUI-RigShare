// Performance: the run in progress against its ETA, and the last finished runs,
// server-wide. The server sends stats.performance every couple of seconds:
// {running: [{workflow, name, elapsed_ms, eta_ms, runs}], recent: [...],
// etas: {workflow: {ms, runs}}, now}. Between updates the clock keeps ticking here.

import { h } from "./ui.js";
import { modal } from "./files.js";

const MARKS = { done: ["✓", "ok"], stopped: ["■", "bad"], error: ["✕", "bad"] };

export function duration(ms, decimals = 1) {
    const total = Math.max(0, ms) / 1000;
    const hrs = Math.floor(total / 3600);
    const min = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const s = decimals > 0 ? sec.toFixed(decimals).padStart(3 + decimals, "0") : String(Math.floor(sec)).padStart(2, "0");
    return hrs ? `${hrs}:${String(min).padStart(2, "0")}:${s}` : `${String(min).padStart(2, "0")}:${s}`;
}

function ago(ms) {
    const s = Math.max(0, ms / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}

/** The run in progress: clock, ETA, progress bar. `since`: ms since the stats arrived. */
function runningBlock(run, since, { big = false, workflow = null } = {}) {
    const elapsed = run.elapsed_ms + since;
    const eta = run.eta_ms;
    const over = eta && elapsed > eta;
    const left = eta ? Math.round((eta - elapsed) / 1000) : null;
    const mine = !!workflow && run.workflow === workflow; // the workflow on screen: yellow clock
    return h("div", { class: `rs-perf-run ${big ? "big" : ""} ${mine ? "mine" : ""}` },
        h("div", { class: "rs-perf-top" },
            h("span", { class: "rs-perf-clock" }, duration(elapsed), eta ? h("span", { class: "rs-perf-eta" }, ` / ${duration(eta, 0)}`) : null),
            h("span", { class: "rs-grow" }),
            h("span", { class: `rs-small ${over ? "rs-perf-over" : "rs-muted"}` },
                eta ? (left >= 0 ? `~${left} s left` : `${-left} s over`) : "no ETA yet")),
        eta ? h("div", { class: `rs-perf-bar ${over ? "over" : ""}` }, h("div", { style: `width:${Math.min(100, (elapsed / eta) * 100)}%` })) : null,
        h("div", { class: "rs-muted rs-small rs-ellipsis" },
            run.workflow || "Workflow", run.name ? ` · ${run.name}` : "",
            eta ? ` · ETA from ${run.runs} run${run.runs > 1 ? "s" : ""}` : ""));
}

function runRow(run, now, { date = false } = {}) {
    const [mark, cls] = MARKS[run.result] || ["?", "bad"];
    const when = date ? new Date(run.end).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : ago(now - run.end);
    return h("div", { class: "rs-perf-row", title: [run.workflow, run.name, run.result].filter(Boolean).join(" · ") },
        h("span", { class: `rs-perf-mark ${cls}` }, mark),
        h("span", { class: "rs-perf-name rs-ellipsis" }, run.workflow || "Workflow",
            run.name ? h("span", { class: "rs-muted" }, ` · ${run.name}`) : null),
        h("b", {}, duration(run.ms)),
        h("span", { class: "rs-muted rs-perf-ago" }, when));
}

/** Server tab: the run in progress and the last 5 runs. */
export function perfView(perf, receivedAt, workflow = null) {
    if (!perf) return [h("p", { class: "rs-muted rs-small" }, "Waiting for the server…")];
    const since = Date.now() - receivedAt;
    const out = perf.running.length
        ? perf.running.map((r) => runningBlock(r, since, { workflow }))
        : [h("div", { class: "rs-perf-idle rs-muted" }, "Idle: nothing running")];
    if (perf.recent.length) {
        out.push(h("div", { class: "rs-perf-head rs-muted rs-small" }, "Last runs"));
        out.push(...perf.recent.map((r) => runRow(r, perf.now + since)));
    }
    return out;
}

/** Floating card: only the timer. Idle, it shows how long the workflow on screen usually takes. */
export function timerView(perf, receivedAt, workflow) {
    if (!perf) return [h("p", { class: "rs-muted rs-small" }, "Waiting for the server…")];
    const since = Date.now() - receivedAt;
    if (perf.running.length) return perf.running.map((r) => runningBlock(r, since, { big: true, workflow }));
    const eta = workflow ? perf.etas?.[workflow] : null;
    return [h("div", { class: "rs-perf-run big idle" },
        h("div", { class: "rs-perf-top" },
            h("span", { class: "rs-perf-clock rs-muted" }, eta ? duration(eta.ms) : "--:--"),
            h("span", { class: "rs-grow" }),
            h("span", { class: "rs-small rs-muted" }, "Idle")),
        h("div", { class: "rs-muted rs-small rs-ellipsis" },
            workflow ? (eta ? `${workflow} usually takes this · ${eta.runs} run${eta.runs > 1 ? "s" : ""}` : `${workflow}: no timings yet`)
                : "Open a workflow to see its usual time"))];
}

/** The full run history, in a window. */
export async function openHistory(client) {
    const list = h("div", { class: "rs-perf rs-perf-history" }, h("p", { class: "rs-muted" }, "Loading…"));
    modal("Run history", "pi-history", list, null);
    try {
        const data = await client.request("GET", "/rigshare/api/performance/history?limit=200");
        list.replaceChildren(...(data.runs.length
            ? [h("div", { class: "rs-muted rs-small" }, `${data.total} run${data.total === 1 ? "" : "s"}${data.total > data.runs.length ? `, the last ${data.runs.length} shown` : ""}`),
                ...data.runs.map((r) => runRow(r, Date.now(), { date: true }))]
            : [h("p", { class: "rs-muted" }, "No runs yet.")]));
    } catch (e) {
        list.replaceChildren(h("p", { class: "rs-muted" }, e.message || String(e)));
    }
}
