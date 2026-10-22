import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Protocol fixture only: it never invokes an OS input or screen-capture API.
const scope = { pid: { type: "integer" }, window_id: { type: "integer" } };
const delivery = { ...scope, scope: { const: "window" }, delivery_mode: { enum: ["background", "foreground"] } };
const number = { type: "number" };
const definitions = [
  { name: "get_window_state", inputSchema: { type: "object", required: ["pid", "window_id"], additionalProperties: false, properties: {
    ...scope, include_screenshot: { type: "boolean" }, include_accessibility_tree: { type: "boolean" },
    max_elements: { type: "integer" }, max_depth: { type: "integer" }, max_dimension: { type: "integer" },
  } } },
  { name: "click", inputSchema: { type: "object", required: ["pid", "window_id", "x", "y"], additionalProperties: false,
    properties: { ...delivery, x: number, y: number, button: { enum: ["left", "right", "middle"] } } } },
  { name: "drag", inputSchema: { type: "object", required: ["pid", "window_id", "from_x", "from_y", "to_x", "to_y"], additionalProperties: false,
    properties: { ...delivery, from_x: number, from_y: number, to_x: number, to_y: number,
      duration_ms: { type: "integer" }, steps: { type: "integer" }, button: { enum: ["left", "right", "middle"] } } } },
];
const server = new Server({ name: "doyourweb-test-desktop", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [
  { type: "text", text: JSON.stringify(params.arguments) },
  ...(params.name === "get_window_state" && params.arguments.include_screenshot ? [{ type: "image", mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=" }] : []),
] }));
await server.connect(new StdioServerTransport());
