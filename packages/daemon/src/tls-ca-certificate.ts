import { X509Certificate } from "node:crypto";
import { getCACertificates } from "node:tls";
import { Agent } from "undici";

const pemCertificate = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

function certificatesIn(value: string): X509Certificate[] {
  const blocks = [...value.matchAll(pemCertificate)].map(([block]) => new X509Certificate(block!)),
    remainder = value.replace(pemCertificate, "").trim();
  if (blocks.length === 0 || remainder !== "") throw new TypeError("Expected PEM certificate material.");
  return blocks;
}

function isSelfSignedRoot(certificate: X509Certificate): boolean {
  return certificate.ca && certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey);
}

/** Invite trust material is a CA root, never a listener leaf certificate. */
export function normalizeRootCaCertificate(value: string): string {
  const certificates = certificatesIn(value);
  if (certificates.length !== 1 || !isSelfSignedRoot(certificates[0]!))
    throw new TypeError("Expected one self-signed CA root certificate.");
  return certificates[0]!.toString();
}

/** Extract the root that signs the first (listener leaf) certificate in a configured PEM chain. */
export function rootCaFromCertificateChain(value: string, hostname: string, now = Date.now()): string | undefined {
  if (value.trim() === "") return undefined;
  const certificates = certificatesIn(value),
    root = certificates.find(isSelfSignedRoot);
  if (!root || certificates[0]!.checkHost(hostname) === undefined) return undefined;
  let current = certificates[0]!;
  const visited = new Set<X509Certificate>();
  const validAtCurrentTime = (certificate: X509Certificate): boolean =>
    Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo);
  if (!validAtCurrentTime(current)) return undefined;
  while (current.raw.compare(root.raw) !== 0) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const issuer = certificates.find(
      (candidate) => !visited.has(candidate) && current.checkIssued(candidate) && current.verify(candidate.publicKey),
    );
    if (!issuer?.ca || !validAtCurrentTime(issuer)) return undefined;
    current = issuer;
  }
  return root.toString();
}

const untrustedIssuerCodes = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export function isUntrustedIssuer(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && typeof current.code === "string" && untrustedIssuerCodes.has(current.code)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Node's "default" bundle includes NODE_EXTRA_CA_CERTS; keep edge login on bundled and OS roots only. */
export function systemCaCertificates(): readonly string[] {
  return [...new Set([...getCACertificates("bundled"), ...getCACertificates("system")])];
}

export async function fetchWithTlsCa(
  fetcher: typeof fetch,
  ca: string | readonly string[],
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  if (new URL(input).protocol !== "https:") return fetcher(input, init);
  const dispatcher = new Agent({ connect: { ca: typeof ca === "string" ? ca : [...ca] } });
  try {
    const response = await fetcher(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent }),
      body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await dispatcher.close();
  }
}

export async function probeSystemCaTrust(fetcher: typeof fetch, ca: readonly string[], url: string): Promise<void> {
  const response = await fetchWithTlsCa(fetcher, ca, url, { method: "HEAD", redirect: "manual" });
  await response.body?.cancel();
}
