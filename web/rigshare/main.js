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
import { FilesBrowser, openFromWorkspace } from "./files.js";
import { h } from "./ui.js";
import { AppDock } from "./app-dock.js";

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

// ComfyUI's Workflows and Apps sidebar tabs browse the same files as RigShare's
// Files tab, without its folders. The server enforces permissions either way;
// hiding them avoids two file browsers and buttons the server would refuse.
const COMFY_FILE_TABS = ["workflows", "apps"];
function installFileTabsGuard(client) {
    const removed = new Map();
    const manager = () => app.extensionManager;
    const tabs = () => manager()?.getSidebarTabs?.() ?? manager()?.sidebarTab?.sidebarTabs ?? [];
    const hidden = () => client.server?.hide_comfy_file_tabs !== false;
    const openFiles = () => manager()?.command?.execute("Workspace.ToggleSidebarTab.rigshare-files");
    const apply = () => {
        if (!client.server) return; // wait for the server's settings
        const hide = hidden();
        for (const id of COMFY_FILE_TABS) {
            const tab = tabs().find((t) => t.id === id);
            // Open workflow tabs can be shown in the Workflows sidebar tab: keep it then.
            const needed = id === "workflows" && setting("Comfy.Workflow.WorkflowTabsPosition", "Topbar") === "Sidebar";
            if (hide && tab && !needed) {
                removed.set(id, tab);
                (manager().unregisterSidebarTab ?? manager().sidebarTab.unregisterSidebarTab)(id);
            } else if ((!hide || needed) && !tab && removed.has(id)) {
                manager().registerSidebarTab(removed.get(id));
                removed.delete(id);
            }
            // Their keyboard shortcuts open Files instead.
            const cmd = (manager()?.command?.commands ?? []).find((c) => c.id === `Workspace.ToggleSidebarTab.${id}`);
            if (cmd && !cmd.__rigshare) {
                const original = cmd.function;
                cmd.function = (...args) => (removed.has(id) ? openFiles() : original(...args));
                cmd.__rigshare = true;
            }
        }
    };
    client.on("server", apply);
    // ComfyUI registers its own tabs around the time extensions load.
    let tries = 0;
    const timer = setInterval(() => { apply(); if (++tries > 15) clearInterval(timer); }, 1000);
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

    menuCommands: [
        { path: ["Workflow"], commands: ["RigShare.OpenFromWorkspace"] },
    ],

    keybindings: [
        { combo: { key: "o", ctrl: true, alt: true }, commandId: "RigShare.OpenFromWorkspace" },
    ],

    commands: [
        {
            id: "RigShare.OpenFromWorkspace",
            label: "Open from RigShare…",
            menubarLabel: "Open from RigShare…",
            icon: "pi pi-folder-open",
            function: () => rig && openFromWorkspace(rig),
        },
        {
            id: "RigShare.OpenChat",
            label: "RigShare: Open chat",
            icon: "pi pi-comments",
            function: async () => {
                if (!rig?.panel.visible) await app.extensionManager.command.execute(`Workspace.ToggleSidebarTab.${TAB_ID}`);
                rig?.panel.focusChat();
            },
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

        presence.showCursors = setting("RigShare.ShowCursors", true);
        presence.showNames = setting("RigShare.ShowCursorNames", true);
        panel.chatToasts = setting("RigShare.ChatToasts", false);

        client.on("toast", (t) => app.extensionManager?.toast?.add({ life: 4000, ...t }));
        installAuthHeaders(client);
        installQueueGuard(client);
        installManagerGuard(client);
        installComfyAccountGuard(client);
        installFileTabsGuard(client);
        installSaveDialog(app, api, client, sync);
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

        // Files: its own sidebar tab, Drive-style.
        const filesBrowser = new FilesBrowser({
            app, client, sync, mode: "browse",
            onOpenFile: (path) => sync.openPath(path).catch((e) => client.emit("toast", { severity: "error", summary: "RigShare", detail: e.message })),
            accessEditor: (folder, close) => panel.accessEditorFor({
                load: () => client.request("GET", `/rigshare/api/workspace/folder?path=${encodeURIComponent(folder)}`),
                save: (restricted, members) => client.request("PATCH", "/rigshare/api/workspace/folders", { path: folder, restricted, members }),
                everyoneHint: "Anyone with an account can open its workflows, with their usual permissions",
                close, draftKey: "folderDraft",
            }),
        });
        const filesPanel = h("div", { class: "rs-panel rs-files-panel" },
            h("div", { class: "rs-header" },
                h("div", { class: "rs-title" }, h("i", { class: "pi pi-folder-open rs-files-logo" }),
                    h("div", { class: "rs-title-text" }, h("div", { class: "rs-title-name" }, "Files"),
                        h("div", { class: "rs-status" }, "Your folders and shared ones"))),
                h("button", {
                    class: "rs-btn", title: "Open a workflow file from this computer",
                    onclick: () => app.extensionManager.command.execute("Comfy.OpenWorkflow"),
                }, h("i", { class: "pi pi-upload" }), "From computer")),
            h("div", { class: "rs-body" }, filesBrowser.el));
        let filesLoaded = false;
        app.extensionManager.registerSidebarTab({
            id: "rigshare-files",
            icon: "pi pi-folder-open",
            title: "Files",
            tooltip: "RigShare files: My files and Shared",
            label: "Files",
            type: "custom",
            render: (el) => {
                el.classList.add("rs-host");
                // Same slot element as the RigShare tab when switching between them
                // (ComfyUI only calls destroy on unmount): take it over cleanly.
                if (el.contains(panel.root)) panel.unmount();
                el.replaceChildren(filesPanel);
                if (!filesLoaded || client.online) { filesLoaded = true; filesBrowser.reload(); }
            },
        });
        client.on("self", () => { if (filesPanel.isConnected) filesBrowser.reload(); });

        // ComfyUI's App view draws buttons only for its own tabs: add ours to its sidebar.
        const dock = new AppDock({
            app, sync,
            views: {
                [TAB_ID]: { icon: "pi-users", title: "RigShare", tabId: TAB_ID },
                files: { icon: "pi-folder-open", title: "Files", tabId: "rigshare-files" },
            },
        });

        // The registered tab object is wrapped by Vue; mutating it through the
        // store keeps the unread badge reactive.
        panel.onBadge = (badge) => {
            const tab = app.extensionManager.getSidebarTabs?.().find((t) => t.id === TAB_ID);
            if (tab) tab.iconBadge = badge;
            dock.setBadge(TAB_ID, badge);
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
