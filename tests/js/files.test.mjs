// Files browser tabs: My files, Shared, and All for admins.
import { test } from "node:test";
import assert from "node:assert/strict";

// Just enough DOM for the browser to build its elements.
class FakeNode {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attrs = {}; this.className = ""; }
    append(...c) { this.children.push(...c); }
    replaceChildren(...c) { this.children = c; }
    addEventListener() {}
    setAttribute(k, v) { this.attrs[k] = v; }
    querySelector() { return new FakeNode("div"); }
    get isConnected() { return false; }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeNode(t), createTextNode: (t) => Object.assign(new FakeNode("#text"), { text: t }) };
const { FilesBrowser } = await import("../../web/rigshare/files.js");

const browser = (admin, start) => new FilesBrowser({
    app: {}, sync: {}, mode: "open", start,
    client: { self: { key: "bob" }, perms: { admin }, users: [], rooms: [], on() {}, emit() {} },
});

test("tabs: My files and Shared for everyone, All for admins", () => {
    assert.deepEqual(browser(false).tabs.map((t) => t.label), ["My files", "Shared"]);
    assert.deepEqual(browser(true).tabs.map((t) => t.label), ["My files", "Shared", "All"]);
});

test("starts in My files and picks the tab a folder belongs to", () => {
    const b = browser(false);
    assert.equal(b.tab, "mine");
    assert.equal(b.path, "users/bob");
    assert.equal(browser(false, "shared/Team").tab, "shared");
    assert.equal(browser(false, "renders").tab, "shared");
    assert.equal(browser(true, "users/alice").tab, "all");
    assert.equal(browser(true, "").tab, "all");
});

test("people without All never start outside their tabs", () => {
    for (const start of ["", "users", "users/alice/x"]) {
        const b = browser(false, start);
        assert.ok(["users/bob", "@shared"].includes(b.path), `${start} -> ${b.path}`);
    }
});

test("breadcrumbs start at the tab", () => {
    assert.deepEqual(browser(false, "users/bob/renders/old").trail().map((c) => c.label), ["My files", "renders", "old"]);
    assert.deepEqual(browser(false, "shared/Team/sub").trail().map((c) => c.label), ["Shared", "Team", "sub"]);
    assert.deepEqual(browser(true, "users/alice").trail().map((c) => c.label), ["All", "users", "alice"]);
    assert.equal(browser(false, "shared/Team").label, "Shared / Team");
});
