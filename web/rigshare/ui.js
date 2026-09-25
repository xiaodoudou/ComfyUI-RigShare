// Small DOM helpers shared by the panel and widgets.

export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style") el.style.cssText = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k in el && typeof v !== "string") el[k] = v;
        else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

export function initials(name) {
    return (name || "?").split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join("") || "?";
}

export function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
}

export function clock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function roleChips(perms) {
    if (perms.admin) return [h("span", { class: "rs-chip rs-chip-admin" }, "Admin")];
    const chips = [];
    if (perms.edit) chips.push(h("span", { class: "rs-chip rs-chip-edit" }, "Editor"));
    if (perms.queue) chips.push(h("span", { class: "rs-chip rs-chip-queue" }, "Queue"));
    if (perms.manager) chips.push(h("span", { class: "rs-chip rs-chip-manager" }, "Manager"));
    if (!chips.length) chips.push(h("span", { class: "rs-chip" }, "Viewer"));
    return chips;
}

export function meter(label, pct, text) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const level = p > 90 ? "hot" : p > 70 ? "warm" : "";
    return h("div", { class: "rs-meter" },
        h("div", { class: "rs-meter-top" }, h("span", {}, label), h("span", { class: "rs-muted" }, text)),
        h("div", { class: "rs-meter-track" }, h("div", { class: `rs-meter-fill ${level}`, style: `width:${p}%` })));
}

export const storage = {
    get(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
        try {
            if (value == null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch { /* private mode */ }
    },
};
