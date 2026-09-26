// RigShare in ComfyUI's App mode.
//
// The App view shows a fixed set of sidebar tabs (assets and apps), so the
// RigShare and Files tabs disappear there. While the tab on screen is in the
// App view, a small dock offers them instead, each opening the same panel in
// a drawer.

import { h } from "./ui.js";

export class AppDock {
    /**
     * views: { id: { icon, title, mount(el), unmount() } }
     */
    constructor({ sync, views }) {
        this.sync = sync;
        this.views = views;
        this.open = null;
        this.buttons = {};
        this.body = h("div", { class: "rs-host rs-dock-drawer-body" });
        this.drawer = h("div", { class: "rs-dock-drawer rs-panel-vars", role: "dialog" },
            h("button", { class: "rs-dock-close", title: "Close", onclick: () => this.show(null) }, h("i", { class: "pi pi-times" })),
            this.body);
        this.dock = h("div", { class: "rs-dock rs-panel-vars" }, ...Object.entries(views).map(([id, v]) => {
            const badge = h("span", { class: "rs-dock-badge" });
            const btn = h("button", {
                class: "rs-dock-btn", title: v.title, "aria-label": v.title,
                onclick: () => this.show(this.open === id ? null : id),
            }, h("i", { class: `pi ${v.icon}` }), badge);
            this.buttons[id] = { btn, badge };
            return btn;
        }));
        this.dock.style.display = "none";
        this.drawer.style.display = "none";
        document.body.append(this.dock, this.drawer);
        document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.open) this.show(null); });
        setInterval(() => this.update(), 500);
    }

    update() {
        const active = this.sync.inAppMode;
        this.dock.style.display = active ? "" : "none";
        if (!active && this.open) this.show(null);
    }

    show(id) {
        if (this.open) this.views[this.open].unmount?.();
        this.open = id;
        for (const [key, b] of Object.entries(this.buttons)) b.btn.classList.toggle("active", key === id);
        this.drawer.style.display = id ? "" : "none";
        if (id) this.views[id].mount(this.body);
        else this.body.replaceChildren();
    }

    setBadge(id, text) {
        const b = this.buttons[id];
        if (!b) return;
        b.badge.textContent = text || "";
        b.badge.style.display = text ? "block" : "none";
    }
}
