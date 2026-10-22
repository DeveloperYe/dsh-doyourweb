export function serialize(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function clip(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  if (limit < 3) return ".".repeat(Math.max(0, limit));
  return `${text.slice(0, limit - 3)}...`;
}
