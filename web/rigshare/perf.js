// Performance: the run in progress against an ETA, and the last finished runs,
// server-wide. The server sends stats.performance every couple of seconds:
// {running: [{workflow, name, elapsed_ms, eta_ms}], recent: [{ms, end, result,
// workflow, name}], now}. Between updates the elapsed time keeps ticking here.

import { h } from "./ui.js";

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
function runningBlock(run, since, compact) {
    const elapsed = run.elapsed_ms + since;
    const eta = run.eta_ms;
    const over = eta && elapsed > eta;
    const left = eta ? Math.round((eta - elapsed) / 1000) : null;
    return h("div", { class: "rs-perf-run" },
        h("div", { class: "rs-perf-top" },
            h("span", { class: "rs-perf-clock" }, duration(elapsed), eta ? h("span", { class: "rs-perf-eta" }, ` / ${duration(eta, 0)}`) : null),
            h("span", { class: "rs-grow" }),
            h("span", { class: `rs-small ${over ? "rs-perf-over" : "rs-muted"}` },
                eta ? (left >= 0 ? `~${left} s left` : `${-left} s over`) : "no ETA yet")),
        eta ? h("div", { class: `rs-perf-bar ${over ? "over" : ""}` }, h("div", { style: `width:${Math.min(100, (elapsed / eta) * 100)}%` })) : null,
        h("div", { class: "rs-muted rs-small rs-ellipsis" },
            run.workflow || "Workflow", run.name ? ` · ${run.name}` : "",
            !compact && eta ? ` · ETA from ${run.runs} run${run.runs > 1 ? "s" : ""}` : ""));
}

function recentRow(run, now) {
    const [mark, cls] = MARKS[run.result] || ["?", "bad"];
    return h("div", { class: "rs-perf-row", title: [run.workflow, run.name, run.result].filter(Boolean).join(" · ") },
        h("span", { class: `rs-perf-mark ${cls}` }, mark),
        h("span", { class: "rs-perf-name rs-ellipsis" }, run.workflow || "Workflow",
            run.name ? h("span", { class: "rs-muted" }, ` · ${run.name}`) : null),
        h("b", {}, duration(run.ms)),
        h("span", { class: "rs-muted rs-perf-ago" }, ago(now - run.end)));
}

/** Elements for the performance view. `receivedAt`: Date.now() when the stats arrived. */
export function perfView(perf, receivedAt, { compact = false } = {}) {
    if (!perf) return [h("p", { class: "rs-muted rs-small" }, "Waiting for the server…")];
    const since = Date.now() - receivedAt;
    const out = [];
    if (perf.running.length) out.push(...perf.running.map((r) => runningBlock(r, since, compact)));
    else out.push(h("div", { class: "rs-perf-idle rs-muted" }, "Idle: nothing running"));
    if (perf.recent.length) {
        out.push(h("div", { class: "rs-perf-head rs-muted rs-small" }, "Last runs"));
        out.push(...perf.recent.map((r) => recentRow(r, perf.now + since)));
    }
    return out;
}
