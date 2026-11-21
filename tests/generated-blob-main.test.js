"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/extension/generated-blob-main.js"), "utf8",
);
function fixture() {
  let nativeClicks = 0;
  const listeners = new Map();
  const dispatch = (kind, event) => {
    for (const listener of listeners.get(kind) || []) listener(event);
  };
  const url = "blob:https://chatgpt.com/550e8400-e29b-41d4-a716-446655440000";
  const window = {
    addEventListener(kind, handler) {
      if (!listeners.has(kind)) listeners.set(kind, []);
      listeners.get(kind).push(handler);
    },
    postMessage(data) {
      dispatch("message", { source: window, origin: "https://chatgpt.com", data });
    },
  };
  const document = {
    addEventListener: window.addEventListener.bind(window),
  };
  class Anchor {
    constructor() {
      this.isConnected = false;
      this.href = url;
      this.download = "generated-image.png";
    }
    click() { nativeClicks++; }
  }
  const context = {
    window, document, location: { hostname: "chatgpt.com", origin: "https://chatgpt.com" },
    HTMLAnchorElement: Anchor, URL, Date, crypto: { randomUUID: () => "blob-1" },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: "generated-blob-main.js" });
  const gesture = () => dispatch("click", {
    isTrusted: true,
    target: { closest: () => ({ textContent: "Download image" }) },
  });
  return { window, Anchor, gesture, getNativeClicks: () => nativeClicks };
}
test("detached AI generated Blob waits for desktop and never duplicates native copy", () => {
  const f = fixture();
  f.window.postMessage({ type: "getanny:generated-blob:enable", enabled: true });
  f.gesture();
  let request;
  f.window.addEventListener("message", (event) => {
    if (event.data.type === "getanny:generated-blob") {
      request = event.data;
      f.window.postMessage({ type: "getanny:generated-blob:ack", id: request.id, state: "received" });
      f.window.postMessage({ type: "getanny:generated-blob:ack", id: request.id, state: "complete", accepted: true });
    }
  });
  new f.Anchor().click();
  assert.equal(request.filename, "generated-image.png");
  assert.equal(f.getNativeClicks(), 0);
  new f.Anchor().click();
  assert.equal(f.getNativeClicks(), 1, "gesture cannot silently authorize multiple generated files");
});
test("rejected desktop upload returns exactly one download to browser", () => {
  const f = fixture();
  f.window.postMessage({ type: "getanny:generated-blob:enable", enabled: true });
  f.gesture();
  f.window.addEventListener("message", (event) => {
    if (event.data.type === "getanny:generated-blob") {
      f.window.postMessage({ type: "getanny:generated-blob:ack", id: event.data.id, state: "received" });
      f.window.postMessage({ type: "getanny:generated-blob:ack", id: event.data.id, state: "complete", accepted: false });
    }
  });
  new f.Anchor().click();
  assert.equal(f.getNativeClicks(), 1);
});
test("disabled bridge leaves page downloads unchanged", () => {
  const f = fixture();
  f.gesture();
  new f.Anchor().click();
  assert.equal(f.getNativeClicks(), 1);
});
test("both browser packages include a main-world bridge only on AI hosts", () => {
  for (const name of ["manifest.json","manifest-firefox.json"]) {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "../src/extension", name), "utf8",
    ));
    const bridge = manifest.content_scripts.find(
      (item) => item.world === "MAIN",
    );
    assert.deepEqual(bridge.js, ["generated-blob-main.js"]);
    assert.equal(bridge.run_at, "document_start");
    assert.equal(bridge.matches.some((match) => match.includes("chatgpt.com")), true);
    assert.equal(bridge.matches.some((match) => match.includes("example.com")), false);
  }
});
