// "Save" asks where, with the same folder browser as the Files tab.
//
// ComfyUI's save flow asks the workflow for a file name (promptSave) and saves
// to "<workflow directory>/<name>.json". Returning "<folder>/<name>" makes it
// save straight into the chosen folder, with ComfyUI's own overwrite checks.

import { h, storage } from "./ui.js";
import { FilesBrowser, modal } from "./files.js";

const LAST_FOLDER = "rigshare.lastSaveFolder";

// ComfyUI adds ".json", or ".app.json" for a workflow saved as an App: names go back without either.
function cleanName(name) {
    return (name || "").trim().replace(/(\.app)?\.json$/i, "").replace(/\.app$/i, "").replace(/[\\/]+/g, "-").slice(0, 120);
}

export function installSaveDialog(app, api, client, sync) {
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
                return await chooseLocation(app, api, client, sync, this);
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

export async function chooseLocation(app, api, client, sync, wf) {
    const directory = wf.directory || "workflows";
    const current = directory === "workflows" ? null : directory.slice("workflows/".length);
    const start = current ?? storage.get(LAST_FOLDER) ?? `users/${client.self?.key}`;

    const name = h("input", { class: "rs-input rs-save-name", value: cleanName(wf.filename) || "Untitled", maxLength: 120,
        onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); submit(); } } });
    const where = h("span", { class: "rs-muted rs-small rs-grow rs-ellipsis" });
    const save = h("button", { class: "rs-btn rs-btn-primary" }, h("i", { class: "pi pi-save" }), "Save here");
    const browser = new FilesBrowser({
        app, client, sync, mode: "save", start: start === "" ? "@shared" : start,
        onPickFile: (entry) => { name.value = entry.name; name.focus(); },
        onChange: () => {
            save.disabled = browser.saveFolder === null;
            where.textContent = browser.saveFolder === null
                ? "You cannot save in this folder"
                : `Save in ${browser.label}`;
        },
    });
    const body = h("div", { class: "rs-save-body" }, h("label", { class: "rs-label" }, "Name"), name, h("label", { class: "rs-label" }, "Location"), browser.el);
    const m = modal("Save workflow", "pi-save", body, [where, h("button", { class: "rs-btn rs-btn-ghost", onclick: () => m.close(null) }, "Cancel"), save]);
    function submit() {
        const n = cleanName(name.value);
        if (!n || browser.saveFolder === null) return;
        storage.set(LAST_FOLDER, browser.saveFolder);
        m.close({ name: n, folder: browser.saveFolder });
    }
    save.onclick = submit;
    await browser.reload();
    setTimeout(() => { name.focus(); name.select(); }, 30);

    const result = await m.closed;
    if (!result) return null;
    const targetDir = result.folder ? `workflows/${result.folder}` : "workflows";
    if (targetDir === directory) return result.name;
    if (directory === "workflows") return `${result.folder}/${result.name}`;
    // "Save As" from a file that lives in another folder: write the copy
    // ourselves, open it, and tell ComfyUI there is nothing left to do.
    const isApp = wf.initialMode === "app" || /\.app(\.json)?$/i.test(wf.filename || "");
    return await saveCopyElsewhere(app, api, client, wf, `${targetDir}/${result.name}${isApp ? ".app" : ""}.json`);
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
