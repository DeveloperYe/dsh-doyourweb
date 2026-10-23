import { clip } from "../output.js";

export const desktopTools = new Set(["get_window_state", "get_app_state", "screenshot", "click", "double_click", "right_click", "type_text", "press_key", "hotkey", "set_value", "scroll", "drag"]);
export const reads = new Set(["get_window_state", "get_app_state", "screenshot"]);
export const canonicalTool = name => ({ key: "press_key", type: "type_text" })[name] || name;

export function capabilities(transport) {
  return [...transport.tools.values()].filter(t => desktopTools.has(t.name)).map(t => ({
    tool: t.name, required: t.inputSchema.required || [],
    parameters: Object.keys(t.inputSchema.properties || {}).filter(k => !["pid", "window_id", "session", "scope", "target", "screenshot_out_file"].includes(k)),
  }));
}

export function driverData(raw) {
  if (raw.structuredContent && typeof raw.structuredContent === "object") return raw.structuredContent;
  for (const block of raw.content || []) if (block.type === "text") {
    try { const value = JSON.parse(block.text); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* Plain commentary. */ }
  }
  return {};
}

// Keep handles independently of the text budget. Pages reuse the same driver
// snapshot; retrieving another page must never trigger another UIA walk.
export function controlPage(data, offset = 0, limit = 2400) {
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const controls = []; let used = 0, next = offset;
  for (const element of elements.slice(offset)) {
    const row = Object.fromEntries(["element_index", "element_token", "role", "label", "value", "enabled", "actions"]
      .filter(k => element[k] !== undefined && element[k] !== null).map(k => [k, typeof element[k] === "string" ? clip(element[k], k === "element_token" ? 128 : 180) : element[k]]));
    const size = JSON.stringify(row).length;
    if (controls.length && used + size > limit) break;
    controls.push(row); used += size; next++;
  }
  return { snapshot_id: data.snapshot_id ?? null, controls, total: elements.length,
    next_offset: next < elements.length ? next : null, truncated: !!data.truncated || (data.total_element_count ?? elements.length) > elements.length };
}

export function resolveElement(args, data, properties) {
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  if (args.element) {
    const { role, name } = args.element;
    if (!role && !name) throw new Error("element needs role and/or name (exact label)");
    const matches = elements.filter(e => (!role || e.role === role) && (!name || e.label === name));
    if (matches.length !== 1) throw new Error(`Element lookup matched ${matches.length} controls; use a unique role/name or a returned element_token. Narrow the read with arguments.query if omitted.`);
    args.element_token = matches[0].element_token;
    if (!args.element_token) { args.element_index = matches[0].element_index; args.snapshot_id = data.snapshot_id; }
    delete args.element;
  }
  if (args.element_token && data?.snapshot_id && !elements.some(e => e.element_token === args.element_token)) throw new Error("element_token is not in this snapshot; use controls from the returned snapshot_id, or exact element:{role,name}");
  if (args.element_index !== undefined && properties.snapshot_id) {
    if (args.snapshot_id && args.snapshot_id !== data?.snapshot_id) throw new Error("snapshot_id must be the driver's returned snapshot_id; never derive it from the plugin snapshot UUID");
    args.snapshot_id ||= data?.snapshot_id;
    if (!args.snapshot_id) throw new Error("element_index requires the driver's snapshot_id; read this window first or pass element_token");
  }
  return args;
}

export function geometry(app, data = {}) {
  const b = data.window_bounds;
  const bounds = b ? { x: b.x, y: b.y, width: b.w ?? b.width, height: b.h ?? b.height }
    : { x: app.x, y: app.y, width: app.width, height: app.height };
  const minimized = !!app.minimized || [bounds.x, bounds.y, app.x, app.y, app.inputX, app.inputY].some(n => Number.isFinite(n) && n <= -30000);
  return { window_id: app.windowId, minimized, bounds, screenshot: { width: data.screenshot_width, height: data.screenshot_height } };
}

export function checkCoordinates(args, current, captured, inventoryCaptured = captured) {
  const pixel = ["x", "y", "from_x", "from_y", "to_x", "to_y"].some(k => args[k] !== undefined);
  if (!pixel) return undefined;
  if (current.minimized) throw new Error("Selected window is minimized or has sentinel coordinates; use app_desktop tool:focus_window, screenshot:true before pixel input. No input was sent.");
  const b = current.bounds, old = inventoryCaptured?.bounds;
  if (old && ["width", "height"].some(k => Number.isFinite(old[k]) && Number.isFinite(b[k]) && Math.abs(old[k] - b[k]) > 2)) throw new Error("Window resized since the screenshot; read a fresh visual snapshot before pixel input. No input was sent.");
  const w = captured?.screenshot?.width || captured?.bounds?.width, h = captured?.screenshot?.height || captured?.bounds?.height;
  const points = [];
  for (const [xKey, yKey] of [["x", "y"], ["from_x", "from_y"], ["to_x", "to_y"]]) {
    if (args[xKey] === undefined && args[yKey] === undefined) continue;
    const x = args[xKey], y = args[yKey];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || (w && x >= w) || (h && y >= h)) throw new Error("Pixel point is outside the captured window; use screenshot-local x,y pairs. No input was sent.");
    points.push({ x, y, screen_x: Number.isFinite(b.x) && w ? Math.round(b.x + x * b.width / w) : null,
      screen_y: Number.isFinite(b.y) && h ? Math.round(b.y + y * b.height / h) : null });
  }
  return { ...current, points, screen_coordinates: "estimated from captured frame; driver owns input conversion" };
}

export function refusedBeforeInput(raw) {
  const data = driverData(raw);
  if (data.effect === "refused" && !(data.delivery?.delivered_count > 0)) return true;
  // Exact driver validation/refusal messages, not generic errors after dispatch.
  const text = (raw.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  return !!raw.isError && /Background delivery is not available|element_token is stale|bare element_index is not accepted|snapshot_id is stale/.test(text);
}
