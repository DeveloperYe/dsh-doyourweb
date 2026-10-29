import { randomUUID, randomInt, createHash } from "node:crypto";

/** Chrome extension ids are the first 16 bytes of SHA-256(key), hex folded to a-p. */
export function extensionId(key) {
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")
    .slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}

/**
 * The committed manifest key pins the extension id for every installation: the
 * unpacked folder can be loaded as-is (no generated copy), and the bridge can
 * restrict the WebSocket origin to exactly that id.
 */
export function manifestKey(manifest) {
  if (typeof manifest?.key !== "string" || manifest.key.length === 0) {
    throw new Error("The companion extension manifest must pin a key so its id is stable");
  }
  return manifest.key;
}

export function pinnedExtensionId(manifest) {
  return extensionId(manifestKey(manifest));
}

/**
 * One-time pairing of a freshly loaded browser extension.
 *
 * A secret cannot be shipped to the browser, and an unpacked extension can only
 * be recognised by its (forgeable) `Origin`, so pairing must be confirmed by the
 * person at the keyboard. The code is a PIN: it appears only in the extension's
 * toolbar badge, and the setup page deliberately does not list it — the user types
 * what the badge shows. A local impostor can open its own request, but its code is
 * never rendered anywhere the impostor could read it back, so a wrong PIN is all
 * it can submit and the token is never handed over.
 */
export class Pairings {
  constructor({ ttlMs = 120000, maxPending = 4, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.now = now;
    this.pending = new Map();
  }

  /** Register a request for one connecting socket; returns undefined when saturated. */
  request(socket) {
    this.prune();
    if (this.pending.size >= this.maxPending) return undefined;
    const entry = { id: randomUUID().slice(0, 8), code: String(randomInt(0, 10000)).padStart(4, "0"),
      socket, created: this.now(), expires: this.now() + this.ttlMs };
    this.pending.set(entry.id, entry);
    return entry;
  }

  /**
   * Live requests, newest last, for the setup page. The code is omitted on
   * purpose: it is a PIN only the extension badge may reveal, so a local process
   * reading this page cannot learn the code of a request it opened itself.
   */
  list() {
    this.prune();
    return [...this.pending.values()].map(({ id, created, expires }) => ({ id, created, expires }));
  }

  /** The pending request whose PIN the human typed, or undefined when none matches. */
  match(pin) {
    this.prune();
    const typed = String(pin ?? "").trim();
    if (!/^\d{4}$/.test(typed)) return undefined;
    for (const entry of this.pending.values()) if (entry.code === typed) return entry;
    return undefined;
  }

  /** Drop every pending request, closing its socket so the extension can retry. */
  clear(reason = "Pairing restarted") {
    for (const entry of this.pending.values()) entry.socket.close?.(1000, reason);
    this.pending.clear();
  }

  /** Consume one request; approval and denial are both single use. */
  take(id) {
    this.prune();
    const entry = this.pending.get(id);
    if (entry === undefined) return undefined;
    this.pending.delete(id);
    return entry;
  }

  /** Forget the request a socket opened when it disconnects. */
  drop(socket) {
    for (const [id, entry] of this.pending) if (entry.socket === socket) this.pending.delete(id);
  }

  prune() {
    const now = this.now();
    for (const [id, entry] of this.pending) if (entry.expires <= now) {
      this.pending.delete(id);
      entry.socket.close?.(1000, "Pairing expired");
    }
  }
}
