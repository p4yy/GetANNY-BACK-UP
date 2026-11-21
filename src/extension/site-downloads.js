(() => {
  const providers = [
    ["ChatGPT", ["chatgpt.com", "chat.openai.com"]],
    ["Claude", ["claude.ai"]],
    ["Perplexity", ["perplexity.ai"]],
    ["Suno", ["suno.com", "suno.ai"]],
    ["Gemini", ["gemini.google.com"]],
    ["Google AI Studio", ["aistudio.google.com"]],
    ["Copilot", ["copilot.microsoft.com", "designer.microsoft.com"]],
    ["DeepSeek", ["deepseek.com"]],
    ["Grok", ["grok.com"]],
    ["Mistral", ["mistral.ai"]],
    ["Meta AI", ["meta.ai"]],
    ["Midjourney", ["midjourney.com"]],
    ["Adobe Firefly", ["firefly.adobe.com"]],
    ["Runway", ["runwayml.com"]],
    ["Kling AI", ["klingai.com"]],
    ["Pika", ["pika.art"]],
    ["Luma", ["lumalabs.ai"]],
    ["Ideogram", ["ideogram.ai"]],
    ["Leonardo", ["leonardo.ai"]],
    ["ElevenLabs", ["elevenlabs.io"]],
    ["Higgsfield", ["higgsfield.ai"]],
    ["Krea", ["krea.ai"]],
    ["PixVerse", ["pixverse.ai"]],
    ["Hailuo", ["hailuoai.video"]],
    ["OpenArt", ["openart.ai"]],
    ["Canva", ["canva.com"]],
    ["Freepik", ["freepik.com"]],
  ];

  function matchesHost(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }

  function providerFor(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return null;
      for (const [provider, domains] of providers)
        if (domains.some((domain) => matchesHost(url.hostname, domain)))
          return provider;
    } catch {}
    return null;
  }

  function classifyOutput(page, target, mime = "", disposition = "") {
    let url;
    try {
      url = new URL(target);
      if (url.protocol !== "https:") return null;
    } catch {
      return null;
    }
    const provider = providerFor(page);
    if (
      provider === "Suno" &&
      /^cdn[0-9]*\.(?:suno\.ai|suno\.com)$/.test(url.hostname) &&
      (/^audio\//i.test(mime) || /\.(?:mp3|wav|m4a)$/i.test(url.pathname))
    )
      return { kind: "file", title: "Suno audio" };
    if (/\battachment\b/i.test(disposition)) {
      const source = provider || url.hostname.replace(/^www\./i, "");
      return { kind: "file", title: source + " file" };
    }
    if (
      provider === "ChatGPT" &&
      /^(?:files\.oaiusercontent\.com|persistent\.oaistatic\.com)$/.test(
        url.hostname,
      ) &&
      /^image\//i.test(mime)
    )
      return { kind: "file", title: "ChatGPT image" };
    return null;
  }

  function prefersBrowser(page, target, includeSiteCookies) {
    if (includeSiteCookies) return false;
    return ["ChatGPT", "Claude"].some((provider) =>
      [providerFor(page), providerFor(target)].includes(provider),
    );
  }

  const adapters = { providerFor, classifyOutput, prefersBrowser };
  globalThis.GetANNYSiteDownloads = adapters;
  if (typeof module === "object" && module.exports) module.exports = adapters;
})();
