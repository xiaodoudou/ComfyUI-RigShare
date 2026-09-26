// RigShare — multi-user collaboration for the modern ComfyUI frontend.
// Continued from ComfyUI-Nexus by daxcay (MIT).

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { RigClient } from "./client.js";
import { RoomSync } from "./sync.js";
import { Presence } from "./presence.js";
import { RigSharePanel } from "./panel.js";
import { STYLES } from "./styles.js";
import { installSaveDialog } from "./save-dialog.js";

const TAB_ID = "rigshare";
const ICON_CLASS = "rigshare-tab-icon";

function setting(id, fallback) {
    try {
        const v = app.extensionManager?.setting?.get(id);
        return v === undefined ? fallback : v;
    } catch {
        return fallback;
    }
}

function installAuthHeaders(client) {
    const original = api.fetchApi.bind(api);
    api.fetchApi = (route, options = {}) => {
        let headers = options.headers || {};
        if (headers instanceof Headers) headers = Object.fromEntries(headers.entries());
        return original(route, { ...options, headers: { ...headers, ...client.authHeaders() } });
    };
}

// ComfyUI Manager: hide its button and refuse its commands without the
// "manager" permission (the server blocks its API too).
const MANAGER_COMMANDS = ["Comfy.Manager.Menu.ToggleVisibility", "Comfy.Manager.CustomNodesManager.ToggleVisibility"];
function installManagerGuard(client) {
    const apply = () => {
        const allowed = !client.online || !!client.perms.manager;
        document.body.classList.toggle("rs-no-manager", !allowed);
        for (const cmd of app.extensionManager?.command?.commands ?? []) {
            if (!MANAGER_COMMANDS.includes(cmd.id) || cmd.__rigshare) continue;
            const original = cmd.function;
            cmd.function = (...args) => {
                if (client.online && !client.perms.manager) {
                    client.emit("toast", { severity: "warn", summary: "RigShare", detail: "You need the Manager permission to open ComfyUI Manager. Ask an admin." });
                    return;
                }
                return original(...args);
            };
            cmd.__rigshare = true;
        }
    };
    client.on("self", apply);
    client.on("status", apply);
    setTimeout(apply, 2000); // Manager registers its commands during setup
}

// Comfy.org account: hide the top-bar sign-in button and refuse the sign-in
// dialogs when the admin turned it off.
const SIGNIN_DIALOGS = ["global-signin", "api-nodes-signin"];
function installComfyAccountGuard(client) {
    const hidden = () => !!client.server?.hide_comfy_account;
    const patchStores = () => {
        const cmd = (app.extensionManager?.command?.commands ?? []).find((c) => c.id === "Comfy.User.OpenSignInDialog");
        if (cmd && !cmd.__rigshare) {
            const original = cmd.function;
            cmd.function = (...args) => (hidden() ? undefined : original(...args));
            cmd.__rigshare = true;
        }
        try {
            const vueApp = document.querySelector("[data-v-app]")?.__vue_app__;
            const dialogs = vueApp?.config?.globalProperties?.$pinia?._s?.get("dialog");
            if (dialogs && !dialogs.__rigshare) {
                const show = dialogs.showDialog;
                dialogs.showDialog = (options, ...rest) => {
                    if (hidden() && SIGNIN_DIALOGS.includes(options?.key)) return undefined;
                    return show.call(dialogs, options, ...rest);
                };
                dialogs.__rigshare = true;
            }
        } catch (e) {
            console.warn("[RigShare] could not hook dialogs", e);
        }
    };
    const apply = () => {
        document.body.classList.toggle("rs-hide-comfy-account", hidden());
        patchStores();
    };
    client.on("server", apply);
    setTimeout(apply, 2000);
}

function installQueueGuard(client) {
    const original = api.queuePrompt.bind(api);
    api.queuePrompt = async (...args) => {
        if (client.online && !client.perms.queue) {
            throw new Error("RigShare: you do not have permission to queue prompts. Ask an admin, or log in with an account that can queue.");
        }
        return original(...args);
    };
}

// Short two-tone "ping" synthesized with WebAudio (no asset to ship).
let audio = null;
function ping() {
    try {
        audio ??= new AudioContext();
        if (audio.state === "suspended") audio.resume();
        const now = audio.currentTime;
        for (const [i, freq] of [880, 1320].entries()) {
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;
            const t = now + i * 0.11;
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
            osc.connect(gain).connect(audio.destination);
            osc.start(t);
            osc.stop(t + 0.25);
        }
    } catch { /* audio unavailable */ }
}

function tabButton() {
    return document.querySelector(`.${ICON_CLASS}`)?.closest("button");
}

function setBlink(on) {
    tabButton()?.classList.toggle("rigshare-blink", on);
}

// Remember the active palette so the login page (served before ComfyUI
// loads) can use the same colors.
const THEME_VARS = ["--bg-color", "--comfy-menu-bg", "--comfy-input-bg", "--fg-color", "--descrip-text",
    "--border-color", "--p-primary-color", "--p-primary-contrast-color"];
let lastTheme = "";
function saveTheme() {
    const css = getComputedStyle(document.documentElement);
    const theme = Object.fromEntries(THEME_VARS.map((v) => [v, css.getPropertyValue(v).trim()]).filter(([, v]) => v));
    const json = JSON.stringify(theme);
    if (json === lastTheme) return;
    lastTheme = json;
    try { localStorage.setItem("rigshare.theme", json); } catch { /* ignore */ }
}

let rig = null;

app.registerExtension({
    name: "Comfy.RigShare",

    settings: [
        {
            id: "RigShare.ShareSaved",
            category: ["RigShare", "Sharing", "ShareSaved"],
            name: "Share saved workflows automatically (everyone opening the same file edits it together)",
            type: "boolean",
            defaultValue: false,
            onChange: (v) => { if (rig) rig.sync.autoShareFiles = v; },
        },
        {
            id: "RigShare.ShareUnsaved",
            category: ["RigShare", "Sharing", "ShareUnsaved"],
            name: "Share unsaved tabs automatically once they contain nodes",
            type: "boolean",
            defaultValue: false,
            onChange: (v) => { if (rig) rig.sync.autoShareUnsaved = v; },
        },
        {
            id: "RigShare.ShowCursors",
            category: ["RigShare", "Presence", "ShowCursors"],
            name: "Show other people's cursors and selections",
            type: "boolean",
            defaultValue: true,
            onChange: (v) => { if (rig) { rig.presence.showCursors = v; rig.presence.redraw(); } },
        },
        {
            id: "RigShare.ShowCursorNames",
            category: ["RigShare", "Presence", "ShowCursorNames"],
            name: "Show names next to cursors",
            type: "boolean",
            defaultValue: true,
            onChange: (v) => { if (rig) { rig.presence.showNames = v; rig.presence.redraw(); } },
        },
        {
            id: "RigShare.ChatSound",
            category: ["RigShare", "Chat", "ChatSound"],
            name: "Play a sound for new chat messages when the panel is closed",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: "RigShare.ChatToasts",
            category: ["RigShare", "Chat", "ChatToasts"],
            name: "Show a notification for new chat messages when the panel is closed",
            type: "boolean",
            defaultValue: false,
            onChange: (v) => { if (rig) rig.panel.chatToasts = v; },
        },
    ],

    commands: [
        {
            id: "RigShare.OpenChat",
            label: "RigShare: Open chat",
            icon: "pi pi-comments",
            function: async () => {
                if (!rig?.panel.visible) await app.extensionManager.command.execute(`Workspace.ToggleSidebarTab.${TAB_ID}`);
                rig?.panel.focusChat();
            },
        },
        {
            id: "RigShare.ShareTab",
            label: "RigShare: Share this tab",
            icon: "pi pi-share-alt",
            function: () => rig?.sync.shareCurrent(),
        },
    ],

    async setup() {
        const style = document.createElement("style");
        style.textContent = STYLES;
        document.head.append(style);

        const client = new RigClient();
        const sync = new RoomSync(app, api, client);
        const presence = new Presence(app, client, sync);
        const panel = new RigSharePanel(app, client, sync, presence);
        rig = { client, sync, presence, panel };
        window.rigshare = rig; // handy for debugging from the console

        sync.autoShareFiles = setting("RigShare.ShareSaved", false);
        sync.autoShareUnsaved = setting("RigShare.ShareUnsaved", false);
        presence.showCursors = setting("RigShare.ShowCursors", true);
        presence.showNames = setting("RigShare.ShowCursorNames", true);
        panel.chatToasts = setting("RigShare.ChatToasts", false);

        client.on("toast", (t) => app.extensionManager?.toast?.add({ life: 4000, ...t }));
        installAuthHeaders(client);
        installQueueGuard(client);
        installManagerGuard(client);
        installComfyAccountGuard(client);
        installSaveDialog(app, api, client);
        presence.install();

        app.extensionManager.registerSidebarTab({
            id: TAB_ID,
            icon: `pi pi-users ${ICON_CLASS}`,
            title: "RigShare",
            tooltip: "RigShare — collaboration",
            label: "RigShare",
            type: "custom",
            iconBadge: null,
            render: (el) => panel.mount(el),
            destroy: () => panel.unmount(),
        });

        // The registered tab object is wrapped by Vue; mutating it through the
        // store keeps the unread badge reactive.
        panel.onBadge = (badge) => {
            const tab = app.extensionManager.getSidebarTabs?.().find((t) => t.id === TAB_ID);
            if (tab) tab.iconBadge = badge;
            setBlink(!!badge);
        };
        panel.onNotify = () => {
            if (setting("RigShare.ChatSound", true)) ping();
        };

        client.connect();
        saveTheme();
        setInterval(saveTheme, 5000);
    },
});
