import { z } from "zod";

const coordinate = z.number().min(0).max(20000);
const point = { x: coordinate, y: coordinate };
export const mouseStepsSchema = z.array(z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ...point, button: z.enum(["left", "right", "middle"]).optional() }).strict(),
  z.object({ action: z.literal("double_click"), ...point }).strict(),
  z.object({ action: z.literal("right_click"), ...point }).strict(),
  z.object({ action: z.literal("drag"), ...point, toX: coordinate, toY: coordinate,
    button: z.enum(["left", "right", "middle"]).optional(), durationMs: z.number().int().min(50).max(5000).optional() }).strict(),
  z.object({ action: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(50).optional(), by: z.enum(["line", "page"]).optional(),
    x: coordinate.optional(), y: coordinate.optional() }).strict(),
])).min(1).max(8);

export function mouseSteps(value) {
  return mouseStepsSchema.parse(value).map(step => {
    const { action, x, y, ...rest } = step;
    if (action === "drag") return { tool: "drag", arguments: { from_x: x, from_y: y, to_x: rest.toX, to_y: rest.toY,
      duration_ms: rest.durationMs ?? 500, steps: 20, button: rest.button ?? "left" } };
    if ((x === undefined) !== (y === undefined)) throw new Error("Mouse coordinates require both x and y");
    return { tool: action, arguments: { ...(x === undefined ? {} : { x, y }), ...rest } };
  });
}
