export function serialize(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function clip(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}
