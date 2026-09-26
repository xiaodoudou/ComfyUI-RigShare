// RigShare in ComfyUI's App mode.
//
// The App view's sidebar only draws buttons for a fixed set of tabs (assets
// and apps), but its docked side panel shows whichever sidebar tab is active.
// So RigShare adds its own buttons to that sidebar, copied from ComfyUI's so
// they look the same, and they open the regular RigShare and Files tabs in the
// docked panel, exactly like ComfyUI's own tabs. If the sidebar can't be
// found, a small floating dock offers the same buttons.

import { h } from "./ui.js";

const RAIL = 'nav[data-testid="side-toolbar"]';

export class AppDock {
    /**
     * views: { id: { icon, title, tabId } }, tabId being a registered sidebar tab.
     */
    constructor({ app, sync, views }) {
        this.app = app;
        this.sync = sync;
        this.views = views;
        this.badges = {};
        this.railButtons = {};
        this.dockButtons = {};
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
        document.body.append(this.dock);
        this.wasApp = false;
        this.graphTab = null;   // our tab open in the graph view, if any
        this.restore = null;    // { tabId, until }: reopen it after entering the App view
        setInterval(() => this.update(), 300);
    }

    get activeTabId() {
        return this.app.extensionManager?.sidebarTab?.activeSidebarTabId ?? null;
    }

    /** Open (or close) the tab in ComfyUI's docked side panel, like its own buttons do. */
    toggle(id) {
        this.app.extensionManager?.command?.execute(`Workspace.ToggleSidebarTab.${this.views[id].tabId}`);
        setTimeout(() => this.refreshButtons(), 30);
    }

    update() {
        const active = this.sync.inAppMode;
        this.keepOpenIntoApp(active);
        const rail = active ? document.querySelector(RAIL) : null;
        if (rail) this.addToRail(rail);
        else this.removeFromRail();
        this.dock.style.display = active && !rail ? "" : "none";
        this.refreshButtons();
    }

    /**
     * ComfyUI closes the side panel when a tab enters the App view (not when it
     * goes back to the graph). If a RigShare tab was open, open it again.
     */
    keepOpenIntoApp(inApp) {
        const open = this.activeTabId;
        const ours = Object.values(this.views).map((v) => v.tabId);
        if (!inApp) {
            this.graphTab = ours.includes(open) ? open : null;
            this.restore = null;
        } else if (!this.wasApp && this.graphTab) {
            this.restore = { tabId: this.graphTab, until: Date.now() + 1500 };
        }
        this.wasApp = inApp;
        if (!this.restore) return;
        if (open === this.restore.tabId || Date.now() > this.restore.until) {
            this.restore = null;
        } else if (open === null) {
            this.app.extensionManager?.command?.execute(`Workspace.ToggleSidebarTab.${this.restore.tabId}`);
        }
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

    refreshButtons() {
        const open = this.activeTabId;
        for (const [id, b] of Object.entries(this.railButtons)) {
            b.btn.classList.toggle("side-bar-button-selected", this.views[id].tabId === open);
            this.paintBadge(b.badge, this.badges[id]);
        }
        for (const [id, b] of Object.entries(this.dockButtons)) {
            b.btn.classList.toggle("active", this.views[id].tabId === open);
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
