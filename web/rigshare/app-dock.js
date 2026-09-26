// RigShare in ComfyUI's App mode.
//
// The App view's sidebar shows a fixed set of tabs (assets and apps), so the
// RigShare and Files tabs disappear there. While the tab on screen is in the
// App view, RigShare adds its own buttons to that sidebar, copied from
// ComfyUI's so they look the same, and opens the panels in a drawer next to it.
// If the sidebar can't be found, a small floating dock offers them instead.

import { h } from "./ui.js";

const RAIL = 'nav[data-testid="side-toolbar"]';

export class AppDock {
    /**
     * views: { id: { icon, title, mount(el), unmount() } }
     */
    constructor({ sync, views }) {
        this.sync = sync;
        this.views = views;
        this.open = null;
        this.badges = {};
        this.railButtons = {};
        this.dockButtons = {};
        this.body = h("div", { class: "rs-host rs-dock-drawer-body" });
        this.drawer = h("div", { class: "rs-dock-drawer rs-panel-vars", role: "dialog" },
            h("button", { class: "rs-dock-close", title: "Close", onclick: () => this.show(null) }, h("i", { class: "pi pi-times" })),
            this.body);
        this.dock = h("div", { class: "rs-dock rs-panel-vars" }, ...Object.entries(views).map(([id, v]) => {
            const badge = h("span", { class: "rs-dock-badge" });
            const btn = h("button", {
                class: "rs-dock-btn", title: v.title, "aria-label": v.title,
                onclick: () => this.toggle(id),
            }, h("i", { class: `pi ${v.icon}` }), badge);
            this.dockButtons[id] = { btn, badge };
            return btn;
        }));
        this.dock.style.display = "none";
        this.drawer.style.display = "none";
        document.body.append(this.dock, this.drawer);
        document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.open) this.show(null); });
        setInterval(() => this.update(), 400);
    }

    toggle(id) {
        this.show(this.open === id ? null : id);
    }

    update() {
        const active = this.sync.inAppMode;
        const rail = active ? document.querySelector(RAIL) : null;
        if (rail) this.addToRail(rail);
        else this.removeFromRail();
        this.dock.style.display = active && !rail ? "" : "none";
        if (!active && this.open) this.show(null);
        if (this.open) this.place(rail);
    }

    /** Copy one of ComfyUI's sidebar buttons for each view, placed after its own tabs. */
    addToRail(rail) {
        const ours = Object.values(this.railButtons);
        if (ours.length && ours.every((b) => rail.contains(b.btn))) return;
        const tabs = [...rail.querySelectorAll('[data-testid$="-tab-button"]')].filter((b) => !b.dataset.rigshare);
        const template = tabs.at(-1);
        if (!template) return;
        this.removeFromRail();
        let after = template;
        for (const [id, view] of Object.entries(this.views)) {
            const btn = template.cloneNode(true);
            btn.removeAttribute("data-testid");
            btn.dataset.rigshare = id;
            btn.classList.remove("side-bar-button-selected");
            btn.setAttribute("aria-label", view.title);
            btn.title = view.title;
            const icon = btn.querySelector(".side-bar-button-icon");
            if (icon) {
                const mine = document.createElement("i");
                mine.className = `pi ${view.icon} side-bar-button-icon`;
                mine.style.fontSize = "18px";
                icon.replaceWith(mine);
            }
            btn.querySelector(".sidebar-icon-badge")?.remove();
            const label = [...btn.querySelectorAll("span")].find((s) => s.textContent.trim());
            if (label) label.textContent = view.title;
            const badge = document.createElement("span");
            badge.className = "sidebar-icon-badge rs-rail-badge";
            const holder = btn.querySelector(".side-bar-button-icon")?.parentElement ?? btn;
            holder.style.position = "relative"; // the badge sits on the icon's corner
            holder.append(badge);
            btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(id); });
            after.after(btn);
            after = btn;
            this.railButtons[id] = { btn, badge };
        }
        this.refreshButtons();
    }

    removeFromRail() {
        for (const b of Object.values(this.railButtons)) b.btn.remove();
        this.railButtons = {};
    }

    /** Beside the sidebar when there is one, above the floating dock otherwise. */
    place(rail) {
        const d = this.drawer.style;
        if (rail) {
            const r = rail.getBoundingClientRect();
            d.left = `${Math.round(r.right + 8)}px`;
            d.top = `${Math.round(r.top + 8)}px`;
            d.bottom = "8px";
        } else {
            d.left = "64px";
            d.top = "8px";
            d.bottom = "64px";
        }
    }

    show(id) {
        if (this.open) this.views[this.open].unmount?.();
        this.open = id;
        this.refreshButtons();
        this.drawer.style.display = id ? "" : "none";
        if (id) {
            this.place(document.querySelector(RAIL));
            this.views[id].mount(this.body);
        } else {
            this.body.replaceChildren();
        }
    }

    refreshButtons() {
        for (const [id, b] of Object.entries(this.railButtons)) {
            b.btn.classList.toggle("side-bar-button-selected", id === this.open);
            this.paintBadge(b.badge, this.badges[id]);
        }
        for (const [id, b] of Object.entries(this.dockButtons)) {
            b.btn.classList.toggle("active", id === this.open);
            this.paintBadge(b.badge, this.badges[id]);
        }
    }

    paintBadge(el, text) {
        el.textContent = text || "";
        el.style.display = text ? "block" : "none";
    }

    setBadge(id, text) {
        this.badges[id] = text || null;
        this.refreshButtons();
    }
}
