import { formatMention, remoteContribution } from "./protocol.js";

// This plugin both mounts the Host-for-Client contribution and consumes it, so it
// cannot declare `remote.browserTabs` as an injected dependency (that would wait
// for a namespace this same fiber creates). Cordis refuses property access to an
// uninjected nested key — `cannot get property "remote.browserTabs" without
// inject` — so the namespace is resolved through `ctx.get()` at call time.
export const inject = ["inputTriggers", "remote"];

export function apply(ctx, { browserIcon, tabIcon }) {
  ctx.effect(() => ctx.remote.$mount(remoteContribution));

  function setupCandidate(description) {
    return { name: "browser", label: "\u6d4f\u89c8\u5668", description,
      value: "setup", icon: browserIcon, section: "\u6d4f\u89c8\u5668" };
  }

  /** The mounted Host-for-Client Remote namespace, or a message the menu can show. */
  function namespace() {
    const service = ctx.get ? ctx.get("remote.browserTabs") : ctx.remote?.browserTabs;
    if (!service) throw new Error("browser service is not registered by the DSH host");
    return service;
  }

  async function candidates({ query = "", signal }, slash = false) {
    const browserQuery = query && ["browser", "\u6d4f\u89c8\u5668"].includes(query.toLowerCase());
    const matchesSetup = !query || "browser \u6d4f\u89c8\u5668".includes(query.toLowerCase());
    let result;
    try {
      result = await namespace().list({ query: browserQuery ? "" : query }, signal);
      if (!result.ok) throw new Error(result.error?.message || "Browser service is unavailable");
    } catch (error) {
      if (signal?.aborted) return [];
      return [setupCandidate(`\u670d\u52a1\u4e0d\u53ef\u7528: ${error.message}`)];
    }
    if (result.value.connected === false) return [setupCandidate("\u672a\u8fde\u63a5")];
    const tabs = result.value.tabs.map(tab => ({
      name: tab.title || tab.url,
      description: `${new URL(tab.url).hostname} - ${tab.browser}`,
      icon: tabIcon(tab), section: "\u6807\u7b7e\u9875",
      value: JSON.stringify({ ref: formatMention(tab), label: tab.title || tab.url }),
    }));
    if (slash && matchesSetup) tabs.unshift(setupCandidate("\u8fde\u63a5\u8bbe\u7f6e"));
    else if (!query && !tabs.length) tabs.push(setupCandidate("\u65e0\u53ef\u7528 HTTP/HTTPS \u6807\u7b7e\u9875"));
    return tabs;
  }

  function onPick({ candidate }) {
    if (candidate.value === "setup") {
      let service;
      try { service = namespace(); }
      catch (error) { console.error("dsh-browser-tabs", error); return { text: "" }; }
      void service.setup({}).then(result => {
        if (!result.ok) throw new Error(result.error?.message || "Browser setup is unavailable");
        window.open(result.value.url, "_blank", "noopener");
      }).catch(error => console.error("dsh-browser-tabs", error));
      return { text: "" };
    }
    const value = JSON.parse(candidate.value);
    return { insert: {
      source: "browser-tabs", ref: value.ref, label: value.label,
      appearance: "file", clipboardText: value.ref,
    } };
  }

  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: "@", name: "browser-tabs", showGroupTitle: false,
    async candidates(_session, request) {
      const { quoted, drilled } = request;
      if (quoted || drilled) return [];
      return candidates(request);
    },
    onPick,
    openReference(_session, { ref }) {
      const match = ref.match(/dsh-browser:\/\/[a-z0-9-]+\/\d+/i);
      let service;
      if (!match) return false;
      try { service = namespace(); } catch { return false; }
      void service.focus({ ref: match[0] }).catch(error => console.error("dsh-browser-tabs", error));
      return true;
    },
    codec: { clipboardText: ref => ref, serialize: async ref => ref },
  }));
  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: "/", name: "browser-setup", showGroupTitle: false,
    candidates: (_session, request) => candidates(request, true),
    onPick,
  }));
}
