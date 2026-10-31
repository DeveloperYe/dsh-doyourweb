import forge from "node-forge";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * TLS for the bridge itself, so publishing the browser control channel needs no
 * reverse proxy, no certificate tooling and no extra service on this machine.
 *
 * A browser refuses `wss://` with an untrusted certificate outright (there is no
 * "continue anyway" for WebSockets), so this mints a local CA plus a leaf for the
 * names and addresses the extensions will dial. The user installs the CA once on
 * the browser machine; because the CA is stable, renewals keep working.
 */

const CA_YEARS = 10;
const LEAF_DAYS = 397; // the maximum a browser accepts for a server certificate
const RENEW_BEFORE_DAYS = 30;

function ipToSAN(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) ? { type: 7, ip: value } : undefined;
}

/** SAN entries for the given names and addresses, loopback always included. */
export function sanEntries(hostnames = [], ips = []) {
  // Configured names come first so the certificate's subject reads like the address
  // people actually use; localhost is added last and only as a convenience entry.
  const names = new Set();
  for (const value of hostnames) if (value && !ipToSAN(String(value))) names.add(String(value).toLowerCase());
  names.add("localhost"); // last, so the configured address owns the subject name
  const addresses = new Set(["127.0.0.1"]);
  for (const value of ips) if (ipToSAN(String(value))) addresses.add(String(value));
  for (const value of [...hostnames, ...ips]) { const parsed = ipToSAN(String(value ?? "")); if (parsed) addresses.add(parsed.ip); }
  return { names: [...names], ips: [...addresses] };
}

function createCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  certificate.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  certificate.validity.notAfter = new Date(Date.now() + CA_YEARS * 365 * 24 * 60 * 60 * 1000);
  const attributes = [{ name: "commonName", value: "DSH DoYourWeb Local CA" }, { name: "organizationName", value: "dsh-doyourweb" }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true, pathLenConstraint: 1 },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return { certificate, keys };
}

function createLeaf({ ca, caKey, names, ips }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = `02${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  certificate.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  certificate.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 24 * 60 * 60 * 1000);
  const subject = names[0] || ips[0] || "localhost";
  certificate.setSubject([{ name: "commonName", value: subject }]);
  certificate.setIssuer(ca.subject.attributes);
  // No authorityKeyIdentifier on purpose: forge's encoder produces an extension that
  // OpenSSL reads as a foreign issuer and refuses to link (verified by bisecting the
  // chain). Issuer DN plus signature is enough for Chrome, Edge and Windows.
  certificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [...names.map(value => ({ type: 2, value })), ...ips.map(ip => ({ type: 7, ip }))] },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(caKey, forge.md.sha256.create());
  return { certificate, keys };
}

/**
 * Load the local CA and leaf from `dir`, creating or renewing them when needed.
 * Returns PEM material plus the CA in DER for a one-click trust import.
 */
export async function ensureLocalCertificate({ dir, hostnames = [], ips = [], now = () => Date.now() }) {
  const files = { ca: path.join(dir, "ca.pem"), caKey: path.join(dir, "ca-key.pem"), cert: path.join(dir, "cert.pem"), key: path.join(dir, "key.pem") };
  await mkdir(dir, { recursive: true });
  const { names, ips: addresses } = sanEntries(hostnames, ips);

  let ca, caKey;
  try {
    ca = forge.pki.certificateFromPem(await readFile(files.ca, "utf8"));
    caKey = forge.pki.privateKeyFromPem(await readFile(files.caKey, "utf8"));
  } catch {
    const created = createCa();
    ca = created.certificate; caKey = created.keys.privateKey;
    await writeFile(files.ca, forge.pki.certificateToPem(ca));
    await writeFile(files.caKey, forge.pki.privateKeyToPem(caKey), { mode: 0o600 });
  }

  let leaf, leafKey, authority;
  try {
    leaf = forge.pki.certificateFromPem(await readFile(files.cert, "utf8"));
    leafKey = forge.pki.privateKeyFromPem(await readFile(files.key, "utf8"));
    const remaining = leaf.validity.notAfter.getTime() - now();
    const covered = [...names, ...addresses].every(value => {
      const asIp = ipToSAN(value);
      const altName = (leaf.getExtension("subjectAltName")?.altNames || []).find(entry => asIp ? entry.ip === asIp.ip : entry.value === value);
      return !!altName;
    });
    if (remaining < RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000 || !covered) throw new Error("renew");
    authority = { renewed: false };
  } catch {
    const created = createLeaf({ ca, caKey, names: names.filter(value => !ipToSAN(value)), ips: addresses });
    leaf = created.certificate; leafKey = created.keys.privateKey;
    await writeFile(files.cert, forge.pki.certificateToPem(leaf));
    await writeFile(files.key, forge.pki.privateKeyToPem(leafKey), { mode: 0o600 });
    authority = { renewed: true };
  }

  const caDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca)).getBytes(), "binary");
  return {
    certPem: forge.pki.certificateToPem(leaf),
    keyPem: forge.pki.privateKeyToPem(leafKey),
    caPem: forge.pki.certificateToPem(ca),
    caDer,
    names,
    ips: addresses,
    notAfter: leaf.validity.notAfter,
    caNotAfter: ca.validity.notAfter,
    renewed: authority.renewed,
    dir,
  };
}
