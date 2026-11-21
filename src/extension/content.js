(() => {
  const api = globalThis.browser || globalThis.chrome;
  const pref = globalThis.GetANNYDownloadPreferences;
  let extensionEnabled = false;
  let captureDownloads = false;
  let preferenceRead = 0;
  let lastDownloadGestureAt = 0;
  const seen = new Set();
  const observedMedia = new Map();
  const socialLinks = new Set();

  const refreshCapture = async () => {
    const read = ++preferenceRead;
    captureDownloads = false;
    try {
      const settings = await pref.get(api, location.href);
      if (read === preferenceRead)
        captureDownloads = settings.automatic && !settings.keepInBrowser;
    } catch {
      /* Leave downloads in the browser when preferences are unavailable. */
    }
  };

  void api.storage.local.get([pref.enabledKey]).then((data) => {
    extensionEnabled = data[pref.enabledKey] !== false;
    if (extensionEnabled) scan();
  }).catch(() => { extensionEnabled = false; });
  void refreshCapture();

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[pref.enabledKey]) {
      extensionEnabled = changes[pref.enabledKey].newValue !== false;
      if (extensionEnabled) scan();
    }
    if (
      changes[pref.enabledKey] ||
      changes[pref.automaticKey] ||
      changes[pref.siteKey("keep", location.href)]
    )
      void refreshCapture();
  });

  function responseError(response, fallback) {
    const error = new Error(response?.error || fallback);
    if (response?.ambiguous) error.ambiguous = true;
    return error;
  }

  async function downloadInBrowser(url, filename) {
    const response = await api.runtime.sendMessage({
      type: "browser-download-fallback",
      url,
      filename,
    });
    if (!response || response.success === false)
      throw responseError(response, "The browser could not start this download.");
    return response;
  }

  function fallbackAnchor(url, filename, blob) {
    const native = document.createElement("a");
    const fallbackUrl = blob && URL.createObjectURL?.(blob);
    native.href = fallbackUrl || url;
    native.download = filename || "browser-file";
    native.rel = "noopener";
    document.body.append(native);
    native.click();
    native.remove();
    if (fallbackUrl) setTimeout(() => URL.revokeObjectURL(fallbackUrl), 30000);
  }

  async function captureDownloadLink(url, filename) {
    const settings = await pref.get(api, location.href, url);
    if (
      !settings.automatic ||
      settings.keepInBrowser ||
      globalThis.GetANNYSiteDownloads.prefersBrowser(
        location.href,
        url,
        settings.includeSiteCookies,
      )
    ) {
      await downloadInBrowser(url, filename);
      return;
    }
    const response = await api.runtime.sendMessage({
      type: "download",
      url,
      kind: "file",
      filename,
    });
    if (!response || response.success === false)
      throw responseError(response, "GetANNY did not accept this download.");
  }

  document.addEventListener(
    "click",
    (event) => {
      if (
        !captureDownloads ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const path = event.composedPath?.() || [];
      const selector = "a[href],button,[role='button']";
      const link =
        path.find((node) => node?.matches?.(selector)) ||
        event.target?.closest?.(selector);
      if (!link) return;
      const downloadAttribute = Boolean(link.hasAttribute?.("download"));
      const label = [
        link.textContent,
        link.getAttribute?.("aria-label"),
        link.getAttribute?.("title"),
        link.getAttribute?.("data-testid"),
        link.getAttribute?.("data-action"),
      ].filter(Boolean).join(" ").slice(0, 320);
      const downloadIntent =
        downloadAttribute ||
        /\b(?:download|export|save(?:\s+(?:file|image|video|audio|original))?)\b/i.test(label);
      if (!downloadIntent) return;
      const trusted = event.isTrusted === true;
      const recentGesture =
        !trusted && Date.now() - lastDownloadGestureAt <= 10000;
      if (!trusted && !recentGesture) return;
      const href =
        link.href ||
        link.getAttribute?.("data-download-url") ||
        link.getAttribute?.("data-url") ||
        link.getAttribute?.("data-href") ||
        link.getAttribute?.("href");
      if (!href) {
        // AI sites often create and click a temporary blob anchor after the
        // user activates a Download button. Keep a short-lived user-intent
        // marker so that synthetic anchor click can be captured as well.
        if (trusted) lastDownloadGestureAt = Date.now();
        return;
      }
      let target;
      try {
        target = new URL(href, location.href);
      } catch {
        return;
      }
      const isBlob = target.protocol === "blob:";
      if (
        (isBlob && target.origin !== location.origin) ||
        (!isBlob && !["http:", "https:"].includes(target.protocol))
      )
        return;
      const url = target.href;
      const filename = String(
        link.download ||
        link.getAttribute?.("download") ||
        link.getAttribute?.("data-filename") ||
        link.getAttribute?.("data-name") ||
        "",
      ).trim().slice(0, 220);
      event.preventDefault();
      if (recentGesture) lastDownloadGestureAt = 0;
      if (isBlob) {
        let browserBlob;
        void transferBlob(url, filename || "browser-file", (blob) => {
          browserBlob = blob;
        }).catch((error) => {
          if (error.ambiguous) return;
          try {
            fallbackAnchor(url, filename, browserBlob);
          } catch {
            /* The original page still owns the blob URL. */
          }
        });
      } else {
        void captureDownloadLink(url, filename).catch(async (error) => {
          if (error.ambiguous) return;
          try {
            await downloadInBrowser(url, filename);
          } catch {
            try {
              fallbackAnchor(url, filename);
            } catch {
              /* The site may have invalidated the original download link. */
            }
          }
        });
      }
    },
    true,
  );

  async function transferBlob(url, filename, onRead) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Browser file is no longer available.");
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const reported = Number(declared);
      if (
        !Number.isSafeInteger(reported) ||
        reported < 0 ||
        reported > 64 * 1024 * 1024
      )
        throw new Error("This file exceeds GetANNY’s browser handoff limit.");
    }
    const blob = await response.blob();
    if (blob instanceof Blob) onRead(blob);
    const length = blob.size;
    if (!Number.isSafeInteger(length) || length > 64 * 1024 * 1024)
      throw new Error("This file exceeds GetANNY’s browser handoff limit.");
    const send = async (message) => {
      const result = await api.runtime.sendMessage({
        type: "browser-payload",
        ...message,
      });
      if (!result || result.success === false)
        throw responseError(result, "Desktop unavailable.");
      return result;
    };
    const { uploadId } = await send({
      action: "begin",
      filename: filename.slice(0, 220),
      length,
    });
    try {
      for (let offset = 0; offset < length; offset += 48 * 1024) {
        const bytes = new Uint8Array(
          await blob.slice(offset, offset + 48 * 1024).arrayBuffer(),
        );
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await send({ action: "chunk", uploadId, offset, data: btoa(binary) });
      }
      await send({ action: "finish", uploadId });
    } catch (error) {
      await send({ action: "abort", uploadId }).catch(() => {});
      throw error;
    }
  }
  const isTikTok =
    globalThis.GetANNYSocialLinks.socialSite(location.href) === "tiktok";
  const social =
    window === window.top &&
    globalThis.GetANNYSocialLinks.socialSite(location.href);
  let socialPage = location.href;
  const cardLinks = globalThis.GetANNYSocialLinks;
  let contextTarget;
  if (["youtube", "tiktok", "dribbble"].includes(social)) {
    document.addEventListener("contextmenu", (event) => {
      contextTarget = { node: event.composedPath()[0], page: location.href, time: Date.now() };
    }, true);
  }

  function showCardVideos(urls, page, message) {
    const dialog = document.createElement("dialog");
    dialog.id = "getanny-card-videos";
    document.getElementById(dialog.id)?.remove();
    Object.assign(dialog.style, {
      color: "#f5f5f5", background: "#181818", border: "1px solid #666",
      borderRadius: "12px", padding: "20px", maxWidth: "min(400px, 90vw)",
      font: "15px system-ui", zIndex: "2147483647",
    });
    dialog.setAttribute("aria-label", "GetANNY video download");
    const status = document.createElement("p");
    status.textContent = message;
    status.setAttribute("role", "status");
    dialog.append(status);
    const button = (label, action) => {
      const element = document.createElement("button");
      Object.assign(element.style, { display: "block", marginTop: "10px", padding: "8px 12px", color: "#171717", background: "#fff", borderRadius: "6px", cursor: "pointer" });
      element.textContent = label;
      element.addEventListener("click", action);
      dialog.append(element);
    };
    for (const [index, url] of urls.entries()) {
      const extension = new URL(url).pathname.split(".").at(-1).toUpperCase();
      button(`Download video ${index + 1} (${extension})`, async () => {
        status.textContent = "Sending video to GetANNY…";
        try {
          await sendCardVideo(url, page);
          dialog.close();
        } catch (error) { status.textContent = error.message; }
      });
    }
    button("Close", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  async function sendCardVideo(url, page) {
    const result = await api.runtime.sendMessage({ type: "getanny:dribbble-video", url, page });
    if (!result?.success) throw new Error(result?.error || "GetANNY could not accept this video.");
  }

  async function downloadDribbbleCard(shot, target, mediaUrl) {
    const urls = new Set();
    const add = (value) => {
      const url = cardLinks.dribbbleAsset(value, shot);
      if (url && urls.size < 12) urls.add(url);
    };
    const scanVideo = (root) => {
      for (const video of root.querySelectorAll("video")) {
        add(video.currentSrc);
        add(video.getAttribute("src"));
        for (const source of video.querySelectorAll("source[src]")) add(source.getAttribute("src"));
      }
    };
    const shotId = new URL(shot).pathname.match(/^\/shots\/(\d+)/)[1];
    const card = target?.closest?.(`[data-shot-id="${shotId}"],a[href*="/shots/${shotId}-"]`);
    if (card) scanVideo(card);
    add(mediaUrl);
    try {
      const local = new URL(new URL(shot).pathname, location.origin);
      const response = await fetch(local.href, { mode: "same-origin", signal: AbortSignal.timeout(5000) });
      if (response.ok && cardLinks.postLink(response.url, location.href) === shot) {
        const document = new DOMParser().parseFromString(await response.text(), "text/html");
        for (const meta of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')) add(meta.content);
        const shotContent = document.querySelector(`[data-shot-id="${shotId}"]`);
        if (shotContent) scanVideo(shotContent);
        else for (const gallery of document.querySelectorAll(".shot-media, .shot-images, [data-testid='shot-media']")) scanVideo(gallery);
      }
    } catch { /* A loaded card can still offer a public source. */ }
    if (urls.size === 1) await sendCardVideo([...urls][0], shot);
    else showCardVideos([...urls], shot, urls.size ? "Choose a video from this Dribbble shot." : "GetANNY couldn’t find a downloadable video on this Dribbble shot.");
  }
  function rememberPosts(root) {
    if (!social) return;
    if (location.href !== socialPage) {
      socialPage = location.href;
      socialLinks.clear();
    }
    const anchors = root.matches?.("a[href]")
      ? [root]
      : root.querySelectorAll?.("a[href]") || [];
    for (const anchor of anchors) {
      try {
        const url = globalThis.GetANNYSocialLinks.postLink(
          anchor.href,
          location.href,
        );
        if (url) socialLinks.add(url);
      } catch {}
      if (socialLinks.size >= 500) break;
    }
  }
  if (social)
    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== api.runtime.id || message.type !== "social-links")
        return;
      rememberPosts(document);
      respond({ links: [...socialLinks] });
    });
  const send = (media) => {
    if (!media.url || seen.has(media.url)) return;
    try {
      const url = new URL(media.url, location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      observedMedia.set(url.href, {
        ...media,
        url: url.href,
        title: document.title,
      });
      if (observedMedia.size > 100)
        observedMedia.delete(observedMedia.keys().next().value);
      if (seen.has(url.href)) return;
      seen.add(url.href);
      // Media-heavy long-lived pages must not grow this cache indefinitely.
      if (seen.size > 100) seen.delete(seen.values().next().value);
      api.runtime
        .sendMessage({
          type: "media-detected",
          media: { ...media, url: url.href, title: document.title },
        })
        .catch(() => {});
    } catch {
      /* non-downloadable URL */
    }
  };
  function activeTikTokPost() {
    // Only trust TikTok's selected post permalink. Feed cards can contain
    // neighboring or preloaded videos, so a media-element guess can download
    // a different clip than the one the user opened.
    return globalThis.GetANNYSocialLinks.postLink(location.href, location.href);
  }
  let lastInteractedTikTokVideo = null;
  const visibleVideoArea = (video) => {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) <= 0
    )
      return 0;
    return (
      Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) *
      Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0))
    );
  };
  function rememberInteractedVideo(event) {
    const path = event.composedPath?.() || [event.target];
    for (const node of path) {
      if (node instanceof HTMLVideoElement) {
        lastInteractedTikTokVideo = node;
        return;
      }
      if (node instanceof Element) {
        const player = node.matches?.('[data-e2e*="video-player"]')
          ? node
          : node.closest?.('[data-e2e*="video-player"]');
        const video = player?.querySelector("video");
        if (video) {
          lastInteractedTikTokVideo = video;
          return;
        }
      }
    }
  }
  if (isTikTok) {
    document.addEventListener("pointerdown", rememberInteractedVideo, true);
    document.addEventListener("play", rememberInteractedVideo, true);
    document.addEventListener("playing", rememberInteractedVideo, true);
  }
  function activeTikTokPlayback() {
    const visible = [...document.querySelectorAll("video")]
      .map((video) => {
        return {
          video,
          area: visibleVideoArea(video),
        };
      })
      // TikTok keeps offscreen/preloaded feed elements in the DOM. Only a
      // visible, actively playing element can identify the video the user
      // means. Do not require an arbitrary minimum player size.
      .filter(
        ({ video, area }) =>
          area > 0 && !video.paused && !video.ended && video.readyState >= 2,
      )
      .sort((a, b) => b.area - a.area);
    const interacted = visible.find(
      ({ video }) => video === lastInteractedTikTokVideo,
    );
    const main = interacted || (visible.length === 1 ? visible[0] : null);
    // If multiple feed players are active, use the one the user interacted
    // with. Without that signal, refusing a guess prevents a neighboring
    // preloaded clip from being labeled as the selected one.
    if (!main) return null;
    const postUrl =
      activeTikTokPost() ||
      globalThis.GetANNYSocialLinks.postForMediaElement(
        main.video,
        location.href,
      );
    const streamUrl = main.video.currentSrc || main.video.src || "";
    if (!postUrl || !/^https:\/\//i.test(streamUrl)) return null;
    return { postUrl, streamUrl };
  }
  function element(root) {
    if (!(root instanceof Element)) return;
    if (root.matches("video,audio")) {
      if (isTikTok && root.matches("video")) {
        const playback = activeTikTokPlayback();
        if (
          !playback ||
          playback.streamUrl !== (root.currentSrc || root.src || "")
        )
          return;
        const post = playback.postUrl;
        // Never advertise /en/ (or another TikTok feed URL) as a video.
        if (post) {
          send({ url: post, kind: "media" });
          const streamUrl = playback.streamUrl;
          // Only a known direct file URL is ready for instant playback
          // capture. blob:, manifest and fragment URLs still use yt-dlp.
          const match = /\.(mp4|webm)(?:$|[?#])/i.exec(streamUrl);
          if (/^https:\/\//i.test(streamUrl) && match)
            api.runtime
              .sendMessage({
                type: "getanny:playback-captured",
                postUrl: post,
                streamUrl,
                mimeType:
                  match[1].toLowerCase() === "webm"
                    ? "video/webm"
                    : "video/mp4",
                title: document.title,
              })
              .catch(() => {});
        }
        return;
      }
      const url = root.currentSrc || root.src;
      if (url && !url.startsWith("blob:")) send({ url, kind: "file" });
      else send({ url: location.href, kind: "media" });
    }
    if (root.matches("source") && root.parentElement?.matches("video,audio")) {
      // Some TikTok players expose low-quality transient CDN sources. Prefer
      // the post permalink, which allows Media Studio to inspect all formats.
      if (isTikTok && root.parentElement.matches("video")) return;
      send({
        url: root.src,
        mimeType: root.type,
        kind: /mpegurl|dash/.test(root.type) ? "media" : "file",
      });
    }
  }
  function scan(root = document) {
    if (!extensionEnabled) return;
    element(root);
    rememberPosts(root);
    if (root.querySelectorAll)
      for (const node of root.querySelectorAll("video,audio,source"))
        element(node);
  }
  // The extension popup may ask the page for another scan if the initial
  // media report was dropped. Do not service messages from other extensions.
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== api.runtime.id) return;
    if (message?.type === "getanny:card-context") {
      const target = contextTarget?.page === location.href && Date.now() - contextTarget.time < 60000 ? contextTarget.node : null;
      let post = null;
      try { if (target) post = cardLinks.postForCard(target, location.href); } catch {}
      respond({ post });
      return;
    }
    if (message?.type === "getanny:card-dribbble" && social === "dribbble" && cardLinks.postLink(message.url, location.href) === message.url) {
      const target = contextTarget?.page === location.href && Date.now() - contextTarget.time < 60000 ? contextTarget.node : null;
      respond({ accepted: true });
      void downloadDribbbleCard(message.url, target, message.mediaUrl).catch((error) => showCardVideos([], message.url, error.message));
      return;
    }
    if (message?.type === "getanny:card-error") {
      showCardVideos([], null, "GetANNY couldn’t identify the video on this card.");
      respond({ accepted: true });
      return;
    }
    if (message?.type === "getanny:active-post") {
      respond({ url: isTikTok ? activeTikTokPost() : null });
      return;
    }
    if (message?.type === "getanny:active-playback") {
      respond({ playback: isTikTok ? activeTikTokPlayback() : null });
      return;
    }
    if (message?.type !== "getanny:scan-media") return;
    scan();
    respond({ items: [...observedMedia.values()] });
  });
  const pending = new Set();
  let timer;
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // Only newly inserted subtrees are scanned, never the whole document on
        // every mutation. Coalesce framework bursts into one inexpensive pass.
        if (pending.size < 100) pending.add(node);
      }
    if (!pending.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const node of pending) scan(node);
      pending.clear();
    }, 300);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("play", (event) => scan(event.target), true);
  scan();
})();
