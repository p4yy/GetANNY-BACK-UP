"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture({ sendMessage, automatic = true } = {}) {
  const source = fs.readFileSync("src/extension/content.js", "utf8");
  const listeners = {};
  const messages = [];
  const timers = [];
  const appended = [];
  const fallback = {
    href: "",
    download: "",
    clicked: 0,
    removed: false,
    click() { this.clicked++; },
    remove() { this.removed = true; },
  };
  const api = {
    storage: {
      local: {
        get: async () => ({ getannyExtensionEnabled: true }),
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: "getanny-browser-test",
      sendMessage(message) {
        messages.push(message);
        return sendMessage
          ? sendMessage(message)
          : Promise.resolve({ success: true, action: "queued" });
      },
      onMessage: { addListener() {} },
    },
  };
  const document = {
    title: "Download interception fixture",
    documentElement: {},
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    createElement(tag) {
      assert.equal(tag, "a");
      return fallback;
    },
    body: { append(node) { appended.push(node); } },
    querySelectorAll() { return []; },
  };
  const window = {};
  window.top = window;
  vm.runInNewContext(source, {
    globalThis: {
      browser: api,
      GetANNYSiteDownloads: {
        providerFor: () => false,
        prefersBrowser: () => false,
      },
      GetANNYSocialLinks: { socialSite: () => false },
      GetANNYDownloadPreferences: {
        enabledKey: "getannyExtensionEnabled",
        automaticKey: "getannyAutomaticHandoff",
        siteKey: () => "keep-site",
        get: async () => ({
          automatic,
          keepInBrowser: false,
          includeSiteCookies: true,
        }),
      },
    },
    window,
    document,
    location: {
      href: "https://unlisted-site.example/downloads",
      origin: "https://unlisted-site.example",
    },
    Element: class Element {},
    MutationObserver: class { observe() {} },
    Node: { ELEMENT_NODE: 1 },
    URL,
    Blob,
    fetch: async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => new Blob(["payload"]),
    }),
    setTimeout(callback, milliseconds) {
      timers.push({ callback, milliseconds });
      return 7;
    },
    clearTimeout() {},
  });
  return { listeners, messages, timers, appended, fallback };
}

function click(link, isTrusted = true) {
  return {
    isTrusted,
    defaultPrevented: false,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: {
      closest: (selector) =>
        selector === "a[href],button,[role='button']" ? link : null,
    },
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("same-origin blob download on an unlisted website falls back safely when desktop is unavailable", async () => {
  const anchor = {
    href: "blob:https://unlisted-site.example/file-id",
    download: "clip.bin",
    textContent: "Download",
    hasAttribute: (name) => name === "download",
    getAttribute: () => "clip.bin",
  };
  const f = fixture({
    sendMessage: () => Promise.reject(new Error("desktop unavailable")),
  });
  await new Promise(setImmediate);
  const event = click(anchor);
  f.listeners.click(event);
  await new Promise(setImmediate);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.appended, [f.fallback]);
  assert.match(f.fallback.href, /^blob:/);
  assert.equal(f.fallback.download, "clip.bin");
  assert.equal(f.fallback.clicked, 1);
  assert.equal(f.fallback.removed, true);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].milliseconds, 30000);
  f.timers[0].callback();
});

test("direct download links are handed to GetANNY before the browser starts", async () => {
  const anchor = {
    href: "https://cdn.example.test/files/archive.zip?token=abc",
    download: "archive.zip",
    textContent: "",
    hasAttribute: (name) => name === "download",
    getAttribute: (name) => name === "download" ? "archive.zip" : null,
  };
  const f = fixture();
  await new Promise(setImmediate);
  const event = click(anchor);
  f.listeners.click(event);
  await new Promise(setImmediate);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.messages.map((message) => message.type), ["download"]);
  assert.equal(f.messages[0].url, anchor.href);
  assert.equal(f.messages[0].filename, "archive.zip");
  assert.equal(f.messages[0].kind, "file");
});

test("download-labelled links without a download attribute are captured", async () => {
  const anchor = {
    href: "https://files.example.test/export?id=42",
    download: "",
    textContent: "Download generated file",
    hasAttribute: () => false,
    getAttribute: (name) => name === "aria-label" ? "Download generated file" : null,
  };
  const f = fixture();
  await new Promise(setImmediate);
  const event = click(anchor);
  f.listeners.click(event);
  await new Promise(setImmediate);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.messages[0].type, "download");
  assert.equal(f.messages[0].url, anchor.href);
});

test("download buttons with an exposed data URL are captured before their page handler", async () => {
  const button = {
    href: "",
    download: "",
    textContent: "Download generated image",
    hasAttribute: () => false,
    getAttribute: (name) => ({
      "data-download-url": "https://cdn.example.test/generated/image.png",
      "data-filename": "generated.png",
    })[name] || null,
  };
  const f = fixture();
  await new Promise(setImmediate);
  const event = click(button);
  f.listeners.click(event);
  await new Promise(setImmediate);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.messages[0].type, "download");
  assert.equal(f.messages[0].url, "https://cdn.example.test/generated/image.png");
  assert.equal(f.messages[0].filename, "generated.png");
});

test("a trusted AI download button authorizes its generated synthetic blob link", async () => {
  const f = fixture({
    sendMessage: (message) => Promise.resolve(
      message.action === "begin"
        ? { success: true, uploadId: "upload-1" }
        : { success: true },
    ),
  });
  await new Promise(setImmediate);
  const button = {
    href: "",
    textContent: "Download generated video",
    hasAttribute: () => false,
    getAttribute: () => null,
  };
  const intent = click(button, true);
  f.listeners.click(intent);
  assert.equal(intent.defaultPrevented, false);

  const anchor = {
    href: "blob:https://unlisted-site.example/generated-id",
    download: "generated.mp4",
    textContent: "",
    hasAttribute: (name) => name === "download",
    getAttribute: (name) => name === "download" ? "generated.mp4" : null,
  };
  const generated = click(anchor, false);
  f.listeners.click(generated);
  await new Promise(setImmediate);

  assert.equal(generated.defaultPrevented, true);
  assert.deepEqual(
    f.messages.map((message) => message.action),
    ["begin", "chunk", "finish"],
  );
  assert.equal(f.messages[0].filename, "generated.mp4");
});

test("definitive desktop rejection falls back through the browser download API", async () => {
  const anchor = {
    href: "https://cdn.example.test/files/archive.zip",
    download: "archive.zip",
    textContent: "",
    hasAttribute: (name) => name === "download",
    getAttribute: (name) => name === "download" ? "archive.zip" : null,
  };
  const f = fixture({
    sendMessage: (message) => Promise.resolve(
      message.type === "download"
        ? { success: false, error: "server refused" }
        : { success: true, browserManaged: true },
    ),
  });
  await new Promise(setImmediate);
  const event = click(anchor);
  f.listeners.click(event);
  await new Promise(setImmediate);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(
    f.messages.map((message) => message.type),
    ["download", "browser-download-fallback"],
  );
  assert.equal(f.messages[1].url, anchor.href);
  assert.equal(f.messages[1].filename, "archive.zip");
});

test("manual capture mode leaves explicit download links untouched", async () => {
  const anchor = {
    href: "https://cdn.example.test/files/archive.zip",
    download: "archive.zip",
    textContent: "",
    hasAttribute: (name) => name === "download",
    getAttribute: (name) => name === "download" ? "archive.zip" : null,
  };
  const f = fixture({ automatic: false });
  await new Promise(setImmediate);
  const event = click(anchor);
  f.listeners.click(event);
  await new Promise(setImmediate);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(f.messages, []);
});
