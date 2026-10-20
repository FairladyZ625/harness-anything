import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import { runProcessTextAsync } from "./process-port.ts";
import { validateCertificateNames } from "./tls-listener-admission.ts";
import type { CertificateMode, ManagedRbacListener, ManagedRbacRequest } from "./managed-rbac-service.ts";

export function firstReachableAddress(): string {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  return "127.0.0.1";
}

export async function ensureSelfSignedCertificate(
  root: string,
  hostname: string,
  address: string,
): Promise<{ readonly certificateFile: string; readonly certificateKeyFile: string }> {
  const directory = path.join(root, "listener"),
    certificateFile = path.join(directory, "self-signed.pem"),
    certificateKeyFile = path.join(directory, "self-signed.key");
  if (existsSync(certificateFile) && existsSync(certificateKeyFile)) {
    try {
      validateCertificateNames(readFileSync(certificateFile), [address, hostname]);
      chmodSync(certificateKeyFile, 0o600);
      return { certificateFile, certificateKeyFile };
    } catch (error) {
      consumeKnownError(error);
      rmSync(certificateFile, { force: true });
      rmSync(certificateKeyFile, { force: true });
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const san = isIP(hostname) !== 0 ? `IP:${hostname}` : `DNS:${hostname}`;
  const addressSan = address === hostname ? "" : isIP(address) !== 0 ? `,IP:${address}` : `,DNS:${address}`;
  try {
    await runProcessTextAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      certificateKeyFile,
      "-out",
      certificateFile,
      "-subj",
      `/CN=${hostname}`,
      "-days",
      "825",
      "-addext",
      `subjectAltName=${san}${addressSan}`,
    ]);
    chmodSync(certificateKeyFile, 0o600);
    chmodSync(certificateFile, 0o644);
    return { certificateFile, certificateKeyFile };
  } catch (error) {
    rmSync(certificateFile, { force: true });
    rmSync(certificateKeyFile, { force: true });
    throw Object.assign(
      new Error(
        `Could not create the self-signed login certificate: ${error instanceof Error ? error.message : String(error)}`,
      ),
      {
        code: "rbac_listener_certificate_failed",
      },
    );
  }
}

export function publicListener(listener: ManagedRbacListener): Omit<ManagedRbacListener, "certificateKeyFile"> {
  const { certificateKeyFile: _privateKey, ...safe } = listener;
  return safe;
}

export function listenerVersion(listener: ManagedRbacListener | undefined, certificateMode?: CertificateMode): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        listener: listener ?? null,
        certificateMode: certificateMode ?? (listener ? "domain" : "self-signed"),
      }),
    )
    .digest("hex");
}

export function requestedListener(request: ManagedRbacRequest): ManagedRbacListener | undefined {
  const { hostname, port, certificateFile, certificateKeyFile } = request;
  const supplied = [request.listenAddress, hostname, port, certificateFile, certificateKeyFile].every(
    (value) => value === undefined,
  );
  if (supplied) {
    if (request.certificateMode === "domain" || request.certificateMode === "internal-ca")
      throw listenerError("A domain or internal CA listener requires a hostname, port, certificate, and private key.");
    return undefined;
  }
  const address = request.listenAddress ?? (request.certificateMode ? "0.0.0.0" : firstReachableAddress());
  if (
    !address ||
    isIP(address) === 0 ||
    !hostname ||
    !Number.isInteger(port) ||
    port! < 1 ||
    port! > 65_535 ||
    !URL.canParse(`https://${hostname}:${port}`) ||
    new URL(`https://${hostname}:${port}`).hostname !== hostname ||
    !certificateFile ||
    !certificateKeyFile ||
    !path.isAbsolute(certificateFile) ||
    !path.isAbsolute(certificateKeyFile) ||
    !existsSync(certificateFile)
  )
    throw listenerError(
      "A listener takes --hostname (as the certificate names it), --port, and absolute --certificate-file and --certificate-key-file paths. Pass none of them to serve loopback only.",
    );
  return { address, hostname, port: port!, certificateFile, certificateKeyFile };
}

function listenerError(message: string): Error {
  return Object.assign(new Error(message), { code: "rbac_listener_invalid" });
}
