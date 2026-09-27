// Floating cards over the canvas (the server monitor, performance): draggable,
// and with a magnet that docks them in the bottom-right corner. Docked cards
// stack upwards in the order they were created: beside the minimap and zoom
// toolbar in the graph, in the corner of the App view. Dragging undocks a card.

import { h, storage } from "./ui.js";

const GAP = 10;

// Lucide "magnet" (ISC), inline: neither PrimeIcons nor ComfyUI ships one.
const MAGNET_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round"><path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/>
  <path d="m5 8 4 4"/><path d="m12 15 4 4"/></svg>`;

/** Visible element's box, or null. */
function box(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
}

/** ComfyUI's zoom toolbar: the minimap toggle's first ancestor shaped like the bar. */
function toolbarBox() {
    let el = document.querySelector('[data-testid="toggle-minimap-button"]');
    while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height > 0 && r.height < 120) return r;
        el = el.parentElement;
    }
    return null;
}

const cards = []; // every card, bottom of the stack first

export class FloatCard {
    /**
     * key: storage prefix; title/icon: the header; inAppMode(): App view on screen.
     * Subclasses fill this.body (and this.actions) in render().
     */
    constructor({ key, title, icon, inAppMode, onChange }) {
        this.key = key;
        this.title = title;
        this.icon = icon;
        this.inAppMode = inAppMode ?? (() => false);
        this.onChange = onChange;
        this.enabled = storage.get(`${key}`) === "1";
        this.magnet = storage.get(`${key}Magnet`) !== "0"; // docked unless the user moved it
        this.el = null;
        cards.push(this);
        window.addEventListener("resize", () => this.dock());
        setInterval(() => this.dock(), 500); // panels open and close, the minimap toggles...
    }

    start() {
        if (this.enabled) this.show();
    }

    toggle() {
        this.enabled = !this.enabled;
        storage.set(this.key, this.enabled ? "1" : null);
        this.enabled ? this.show() : this.hide();
        this.onChange?.();
        for (const c of cards) c.dock(); // the stack closes up or opens
    }

    show() {
        if (this.el) return;
        this.body = h("div", { class: "rs-float-body" });
        this.actions = h("div", { class: "rs-float-actions" });
        this.actions.style.display = "none";
        this.magnetBtn = h("button", { class: "rs-float-close rs-float-magnet", onclick: () => this.setMagnet(!this.magnet) });
        this.magnetBtn.innerHTML = MAGNET_SVG;
        const head = h("div", { class: "rs-float-head" },
            h("i", { class: `pi ${this.icon}` }), h("span", { class: "rs-grow" }, this.title),
            this.magnetBtn,
            h("button", { class: "rs-float-close", title: "Close", onclick: () => this.toggle() }, h("i", { class: "pi pi-times" })));
        this.el = h("div", { class: "rs-float rs-panel-vars" }, head, this.body, this.actions);
        let pos = null;
        try { pos = JSON.parse(storage.get(`${this.key}Pos`)); } catch { /* default */ }
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

    render() { /* subclasses */ }

    setMagnet(on) {
        this.magnet = on;
        storage.set(`${this.key}Magnet`, on ? null : "0");
        this.paintMagnet();
        for (const c of cards) c.dock();
    }

    paintMagnet() {
        if (!this.magnetBtn) return;
        this.magnetBtn.classList.toggle("active", this.magnet);
        this.magnetBtn.title = this.magnet ? "Docked: drag to undock" : "Dock in the bottom-right corner";
    }

    /** Right edge and bottom of the docking corner. */
    static anchor(inApp) {
        if (inApp) {
            const area = box("#linearCenterPanel") ?? { right: window.innerWidth, bottom: window.innerHeight };
            return { right: area.right - GAP, bottom: area.bottom - GAP };
        }
        const minimap = box('[data-testid="minimap-container"]');
        const toolbar = toolbarBox();
        if (minimap || toolbar) {
            // Beside the minimap and zoom toolbar, bottom-aligned with the toolbar, with ComfyUI's gap.
            const gap = minimap && toolbar ? Math.max(4, Math.round(toolbar.top - minimap.bottom)) : GAP;
            const left = Math.min(minimap?.left ?? Infinity, toolbar?.left ?? Infinity);
            return { right: left - gap, bottom: toolbar?.bottom ?? minimap.bottom, gap };
        }
        const canvas = box("#graph-canvas-container") ?? box("#graph-canvas") ?? { right: window.innerWidth, bottom: window.innerHeight };
        return { right: canvas.right - GAP, bottom: canvas.bottom - GAP };
    }

    dock() {
        if (!this.el || !this.magnet) return;
        const a = FloatCard.anchor(this.inAppMode());
        const gap = a.gap ?? GAP;
        // Stack above the docked cards created before this one.
        let bottom = a.bottom;
        for (const c of cards) {
            if (c === this) break;
            if (c.el && c.magnet) bottom -= c.el.offsetHeight + gap;
        }
        this.place(a.right - this.el.offsetWidth, bottom - this.el.offsetHeight);
    }

    place(x, y) {
        const w = this.el.offsetWidth || 260;
        const hgt = this.el.offsetHeight || 120;
        x = Math.max(4, Math.min(window.innerWidth - w - 4, x));
        y = Math.max(4, Math.min(window.innerHeight - hgt - 4, y));
        this.el.style.left = `${Math.round(x)}px`;
        this.el.style.top = `${Math.round(y)}px`;
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
                if (moved) storage.set(`${this.key}Pos`, JSON.stringify({ x: this.el.offsetLeft, y: this.el.offsetTop }));
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        });
    }
}
