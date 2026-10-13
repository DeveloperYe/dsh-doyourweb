// Defaults for a freshly loaded extension. The DSH pairing token is never stored
// here: pairing writes it into chrome.storage.local, and this file stays a
// template so the repository folder can be loaded as-is.
export const config = { port: 43187, token: "" };
