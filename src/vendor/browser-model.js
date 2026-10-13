/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 * See extension/APACHE-2.0.txt.
 * Adapted from Playwright browserModel.ts: types removed, errors propagated,
 * and browser-created tabs disabled (the host controls explicitly cited tabs).
 */
export class BrowserModel {
  constructor(sendToExtension) {
    this.sendToExtension = sendToExtension;
    this.sessions = new Map();
    this.knownTabs = new Map();
    this.nextSessionId = 1;
    this.autoAttach = false;
    this.emit = () => {};
  }

  connectOverCDP(emit) { this.emit = emit; }

  onTabCreated(tab) {
    this.knownTabs.set(tab.id, tab);
    if (this.autoAttach) return this.attachTab(tab.id);
  }

  onTabRemoved(tabId) {
    this.knownTabs.delete(tabId);
    this.detachTab(tabId);
  }

  onDebuggerEvent(source, method, params) {
    const tab = this.sessions.get(source.tabId);
    if (!tab) return;
    if (method === "Target.attachedToTarget" && params?.sessionId) tab.children.add(params.sessionId);
    if (method === "Target.detachedFromTarget" && params?.sessionId) tab.children.delete(params.sessionId);
    this.emit({ sessionId: source.sessionId || tab.sessionId, method, params });
  }

  onDebuggerDetach(source) { this.detachTab(source.tabId); }

  async enableAutoAttach() {
    this.autoAttach = true;
    for (const tabId of this.knownTabs.keys()) await this.attachTab(tabId);
  }

  async attachTab(tabId) {
    if (this.sessions.has(tabId)) return this.sessions.get(tabId);
    await this.sendToExtension("chrome.debugger.attach", [{ tabId }, "1.3"]);
    const { targetInfo } = await this.sendToExtension("chrome.debugger.sendCommand", [{ tabId }, "Target.getTargetInfo"]);
    const tab = { tabId, sessionId: `pw-tab-${this.nextSessionId++}`, targetInfo, children: new Set() };
    this.sessions.set(tabId, tab);
    this.emit({ method: "Target.attachedToTarget", params: {
      sessionId: tab.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false,
    } });
    return tab;
  }

  detachTab(tabId) {
    const tab = this.sessions.get(tabId);
    if (!tab) return;
    this.sessions.delete(tabId);
    this.emit({ method: "Target.detachedFromTarget", params: {
      sessionId: tab.sessionId, targetId: tab.targetInfo?.targetId,
    } });
  }

  async command(method, params, sessionId) {
    if (method === "Browser.getVersion") return {
      protocolVersion: "1.3", product: "Chrome/Extension-Bridge", userAgent: "DSH/Browser-Bridge",
    };
    if (method === "Browser.setDownloadBehavior") return {};
    if (method === "Target.setAutoAttach" && !sessionId) { await this.enableAutoAttach(); return {}; }
    if (method === "Target.createTarget" || method === "Target.closeTarget") {
      throw new Error("Only explicitly referenced existing tabs can be controlled");
    }
    const top = [...this.sessions.values()].find(tab => tab.sessionId === sessionId);
    if (method === "Target.getTargetInfo" && top) return { targetInfo: top.targetInfo };
    const tab = top || [...this.sessions.values()].find(tab => tab.children.has(sessionId))
      || (!sessionId && this.sessions.values().next().value);
    if (!tab) throw new Error("Browser tab is detached; read the tab again");
    return this.sendToExtension("chrome.debugger.sendCommand", [
      { tabId: tab.tabId, ...(sessionId && !top ? { sessionId } : {}) }, method, params,
    ]);
  }
}
