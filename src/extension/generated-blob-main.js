// This script intentionally has no extension API access. It runs in the page
// world only to observe detached, programmatically clicked Blob links. The
// isolated content script makes all handoff and privacy decisions.
(() => {
  const host = location.hostname.toLowerCase();
  const domains = [
    "chatgpt.com", "chat.openai.com", "claude.ai", "perplexity.ai",
    "suno.com", "suno.ai", "gemini.google.com", "aistudio.google.com",
    "copilot.microsoft.com", "designer.microsoft.com", "deepseek.com",
    "grok.com", "mistral.ai", "meta.ai", "midjourney.com",
    "firefly.adobe.com", "runwayml.com", "klingai.com", "pika.art",
    "lumalabs.ai", "ideogram.ai", "leonardo.ai", "elevenlabs.io",
    "higgsfield.ai", "krea.ai", "pixverse.ai", "hailuoai.video",
    "openart.ai", "canva.com", "freepik.com"
  ];
  if (!domains.some((domain) => host === domain || host.endsWith("." + domain)))
    return;
  const type = "getanny:generated-blob";
  const pending = new Map();
  const originalClick = HTMLAnchorElement.prototype.click;
  let enabled = false;
  let lastGesture = 0;
  const labelMatches = (node) => {
    const actionable = node?.closest?.("button,a,[role='button']");
    if (!actionable) return false;
    const label = [
      actionable.textContent,
      actionable.getAttribute?.("aria-label"),
      actionable.getAttribute?.("title"),
      actionable.getAttribute?.("data-testid"),
    ].filter(Boolean).join(" ").slice(0, 320);
    return /\\b(?:download|export|save(?:\\s+(?:file|image|video|audio|original))?)\\b/i.test(label);
  };
  document.addEventListener("click", (event) => {
    if (enabled && event.isTrusted === true && labelMatches(event.target))
      lastGesture = Date.now();
  }, true);
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === type + ":enable") {
      enabled = data.enabled === true;
      if (!enabled) lastGesture = 0;
      return;
    }
    if (data.type !== type + ":ack" || typeof data.id !== "string") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    if (data.state === "received") {
      clearTimeout(entry.timer);
      entry.timer = null;
      return;
    }
    if (data.state !== "complete") return;
    clearTimeout(entry.timer);
    pending.delete(data.id);
    if (data.accepted !== true && data.ambiguous !== true)
      originalClick.call(entry.anchor);
  });
  HTMLAnchorElement.prototype.click = function (...args) {
    if (
      !enabled || !this || this.isConnected ||
      Date.now() - lastGesture > 30000 ||
      typeof this.href !== "string" ||
      typeof this.download !== "string" ||
      !this.href.startsWith("blob:")
    ) return originalClick.apply(this, args);
    let parsed;
    try { parsed = new URL(this.href); } catch { return originalClick.apply(this, args); }
    if (parsed.origin !== location.origin)
      return originalClick.apply(this, args);
    lastGesture = 0; // A gesture authorizes at most one generated file.
    const id = crypto.randomUUID();
    const entry = { anchor: this, timer: null };
    // If the isolated script is missing, restore the native page behavior.
    entry.timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      originalClick.call(this);
    }, 750);
    pending.set(id, entry);
    window.postMessage({
      type, id, url: parsed.href, filename: this.download.slice(0, 220)
    }, location.origin);
  };
})();
