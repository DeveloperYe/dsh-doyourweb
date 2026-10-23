export function serialize(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// DSH accepts JSON values, not objects containing undefined, BigInt or cycles.
export function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  const result = Array.isArray(value) ? value.map(item => jsonValue(item, ancestors))
    : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
      .map(([key, item]) => [key, jsonValue(item, ancestors)]));
  ancestors.delete(value);
  return result;
}

export function clip(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  if (limit < 3) return ".".repeat(Math.max(0, limit));
  return `${text.slice(0, limit - 3)}...`;
}
