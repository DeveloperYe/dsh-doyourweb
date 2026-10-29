// Defaults for a freshly loaded extension. The DSH pairing token is never stored
// here: pairing writes it into chrome.storage.local (or the user pastes it for a
// remote DSH machine), and this file stays a template so the repository folder can
// be loaded as-is.
//
// host/scheme describe where DSH listens. Keep the loopback default for a browser
// on the same machine as DSH; for a remote browser use the LAN address or the
// tunnel hostname (scheme "wss"), or keep 127.0.0.1 while an SSH tunnel forwards
// this port to the DSH machine.
export const config = { scheme: "ws", host: "127.0.0.1", port: 43187, token: "" };
