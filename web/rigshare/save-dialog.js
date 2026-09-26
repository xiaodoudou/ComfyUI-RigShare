// "Save" asks where: My files, a shared folder, or Common.
//
// ComfyUI's save flow asks the workflow for a file name (promptSave) and saves
// to "<workflow directory>/<name>.json". Returning "<folder>/<name>" makes it
// save straight into the chosen folder, with ComfyUI's own overwrite checks.

import { h, storage } from "./ui.js";

const LAST_FOLDER = "rigshare.lastSaveFolder";

function cleanName(name) {
    return (name || "").trim().replace(/\.json$/i, "").replace(/[\\/]+/g, "-").slice(0, 120);
}

export function installSaveDialog(app, api, client) {
    const patch = () => {
        const wf = app.extensionManager?.workflow?.activeWorkflow;
        if (!wf) return false;
        let proto = Object.getPrototypeOf(wf);
        while (proto && !Object.prototype.hasOwnProperty.call(proto, "promptSave")) proto = Object.getPrototypeOf(proto);
        if (!proto) return false;
        if (proto.__rigshare) return true;
        const original = proto.promptSave;
        proto.promptSave = async function (...args) {
            if (!client.online || !client.self || !this.path?.startsWith("workflows/")) return original.apply(this, args);
            try {
                return await chooseLocation(app, api, client, this);
            } catch (e) {
                console.error("[RigShare] save dialog", e);
                return original.apply(this, args);
            }
        };
        proto.__rigshare = true;
        return true;
    };
    const timer = setInterval(() => { if (patch()) clearInterval(timer); }, 1000);
}

export async function chooseLocation(app, api, client, wf) {
    let tree = await client.request("GET", "/rigshare/api/workspace");
    const directory = wf.directory || "workflows";

    const options = () => {
        const out = [];
        if (tree.private) out.push({ folder: tree.private.path, label: "My files", hint: "Only you", icon: "pi-user" });
        for (const f of tree.shared) {
            if (f.role === "edit") out.push({ folder: f.path, label: f.name, hint: f.restricted ? "Shared with chosen people" : "Shared with everyone", icon: f.restricted ? "pi-lock" : "pi-folder" });
        }
        if (tree.common?.role === "edit") out.push({ folder: "", label: "Common", hint: "Top level, visible to everyone", icon: "pi-globe" });
        return out;
    };

    const current = directory === "workflows" ? null : directory.slice("workflows/".length);
    const pick = (opts) => {
        const remembered = storage.get(LAST_FOLDER);
        return opts.find((o) => o.folder === current)?.folder
            ?? opts.find((o) => o.folder === remembered)?.folder
            ?? opts[0]?.folder;
    };

    const result = await new Promise((resolve) => {
        let opts = options();
        let selected = pick(opts);
        const name = h("input", { class: "rs-input", value: cleanName(wf.filename) || "Untitled", maxLength: 120 });
        const list = h("div", { class: "rs-save-list" });
        const newFolder = h("input", { class: "rs-input", placeholder: "New shared folder name", maxLength: 64 });
        const error = h("div", { class: "rs-error" });

        const renderList = () => {
            list.replaceChildren(...opts.map((o) => h("label", { class: `rs-save-option ${o.folder === selected ? "on" : ""}` },
                h("input", { type: "radio", name: "rs-save-folder", checked: o.folder === selected, onchange: () => { selected = o.folder; renderList(); } }),
                h("i", { class: `pi ${o.icon}` }),
                h("span", { class: "rs-grow rs-min0" },
                    h("div", { class: "rs-name rs-ellipsis" }, o.label),
                    h("div", { class: "rs-muted rs-small" }, o.hint)))));
        };

        const close = (value) => {
            backdrop.remove();
            document.removeEventListener("keydown", onKey, true);
            resolve(value);
        };
        const submit = () => {
            const n = cleanName(name.value);
            if (!n) { error.textContent = "Enter a name"; return; }
            if (selected === undefined) { error.textContent = "Choose where to save it"; return; }
            storage.set(LAST_FOLDER, selected);
            close({ name: n, folder: selected });
        };
        const onKey = (e) => {
            if (!backdrop.isConnected) return;
            if (e.key === "Escape") { e.stopPropagation(); close(null); }
            if (e.key === "Enter" && document.activeElement !== newFolder) { e.preventDefault(); e.stopPropagation(); submit(); }
        };

        const canCreate = tree.can_create;
        const createRow = canCreate ? h("div", { class: "rs-row" }, newFolder,
            h("button", {
                class: "rs-btn", onclick: async () => {
                    error.textContent = "";
                    try {
                        const res = await client.request("POST", "/rigshare/api/workspace/folders", { name: newFolder.value });
                        tree = await client.request("GET", "/rigshare/api/workspace");
                        opts = options();
                        selected = res.path;
                        newFolder.value = "";
                        renderList();
                    } catch (e) { error.textContent = e.message; }
                },
            }, h("i", { class: "pi pi-folder-plus" }), "Create")) : null;

        const backdrop = h("div", { class: "rs-modal-backdrop rs-panel-vars", onmousedown: (e) => { if (e.target === backdrop) close(null); } },
            h("div", { class: "rs-modal", role: "dialog", "aria-label": "Save workflow" },
                h("div", { class: "rs-modal-title" }, h("i", { class: "pi pi-save" }), "Save workflow"),
                h("label", { class: "rs-label" }, "Name"), name,
                h("label", { class: "rs-label" }, "Save in"), list,
                createRow, error,
                h("div", { class: "rs-actions rs-modal-actions" },
                    h("button", { class: "rs-btn rs-btn-ghost", onclick: () => close(null) }, "Cancel"),
                    h("button", { class: "rs-btn rs-btn-primary", onclick: submit }, "Save"))));
        backdrop.addEventListener("keydown", (e) => e.stopPropagation());
        renderList();
        document.body.append(backdrop);
        document.addEventListener("keydown", onKey, true);
        setTimeout(() => { name.focus(); name.select(); }, 30);
    });

    if (!result) return null;
    const targetDir = result.folder ? `workflows/${result.folder}` : "workflows";
    if (targetDir === directory) return result.name;
    if (directory === "workflows") return `${result.folder}/${result.name}`;
    // "Save As" from a file that lives in another folder: write the copy
    // ourselves, open it, and tell ComfyUI there is nothing left to do.
    return await saveCopyElsewhere(app, api, client, wf, `${targetDir}/${result.name}.json`);
}

async function saveCopyElsewhere(app, api, client, wf, path) {
    const store = app.extensionManager.workflow;
    await store.syncWorkflows?.();
    if (store.getWorkflowByPath?.(path)) {
        const dialog = app.extensionManager?.dialog;
        const ok = dialog?.confirm
            ? await dialog.confirm({ title: "Overwrite?", message: `${path.slice("workflows/".length)} already exists. Replace it?` })
            : window.confirm(`${path} already exists. Replace it?`);
        if (!ok) return null;
    }
    const state = wf.activeState ?? app.rootGraph?.serialize?.() ?? app.graph.serialize();
    await api.storeUserData(path, JSON.stringify(state), { overwrite: true, full_info: true, throwOnError: true });
    await store.syncWorkflows?.();
    const copy = store.getWorkflowByPath?.(path);
    if (copy) {
        if (!copy.isLoaded) await copy.load();
        await app.loadGraphData(copy.activeState, true, true, copy);
    }
    client.emit("toast", { severity: "success", summary: "RigShare", detail: `Saved as ${path.slice("workflows/".length)}` });
    return null;
}
