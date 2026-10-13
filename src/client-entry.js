import { createElement, useState } from "react";
import { IconGlobeOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { apply as registerSources } from "./client.js";

export { inject } from "./client.js";

function TabIcon({ favicon, size = 14 }) {
  const [failed, setFailed] = useState(false);
  if (!favicon || failed) return createElement(IconGlobeOutlineRegular, { size });
  return createElement("img", { src: favicon, width: size, height: size, alt: "",
    style: { display: "block", objectFit: "contain" }, onError: () => setFailed(true) });
}

export function apply(ctx) {
  registerSources(ctx, { browserIcon: IconGlobeOutlineRegular,
    tabIcon: tab => props => createElement(TabIcon, { ...props, favicon: tab.favicon }),
  });
}
