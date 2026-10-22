import { createElement, useEffect, useState } from "react";
import { IconGlobeOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { apply as registerSources } from "./client.js";

export { inject } from "./client.js";

function TabIcon({ favicon, size = 14 }) {
  const [failed, setFailed] = useState(false);
  if (!favicon || failed) return createElement(IconGlobeOutlineRegular, { size });
  return createElement("img", { src: favicon, width: size, height: size, alt: "",
    style: { display: "block", objectFit: "contain" }, onError: () => setFailed(true) });
}

function AppIcon({ icon, size = 14 }) {
  const [failed, setFailed] = useState(false);
  if (icon && !failed) return createElement("img", { src: icon, width: size, height: size, alt: "",
    style: { display: "block", objectFit: "contain" }, onError: () => setFailed(true) });
  return createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true },
    createElement("rect", { x: 3, y: 4, width: 18, height: 13, rx: 2 }),
    createElement("path", { d: "M8 21h8m-4-4v4" }));
}

function AnnotationSession({ sessionId, publish }) {
  useEffect(() => {
    const update = () => publish(sessionId, true);
    update(); const timer = setInterval(update, 15000);
    window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); publish(sessionId, false); };
  }, [sessionId, publish]);
  return null;
}

export function apply(ctx) {
  registerSources(ctx, { browserIcon: IconGlobeOutlineRegular,
    tabIcon: tab => props => createElement(TabIcon, { ...props, favicon: tab.favicon }),
    appIcon: AppIcon, applicationIcon: app => props => createElement(AppIcon, { ...props, icon: app.icon }),
  });
  const client = crypto.randomUUID(); let revision = 0;
  ctx.inject?.(["slots", "sessions"], scope => {
    const publish = (sessionId, active) => {
      const summary = scope.sessions.list.getSnapshot().byId[sessionId];
      const service = ctx.get("remote.browserTabs");
      if (!service?.annotationSession) return;
      void service.annotationSession({ client, revision: ++revision, sessionId, active,
        title: summary?.displayTitle || summary?.title || "当前会话" }).catch(error => console.warn("dsh-doyourweb annotation session", error));
    };
    scope.slots.inject("conversation.input.overlay", () => scope.slots.register({ name: "conversation.input.overlay", id: "doyourweb-annotation-session",
      inject: sessionId => ({ sessionId, publish }) }, AnnotationSession));
  });
}
