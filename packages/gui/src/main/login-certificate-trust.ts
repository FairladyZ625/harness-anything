import { X509Certificate } from "node:crypto";
import { consumeKnownError } from "@harness-anything/kernel";

/**
 * The one certificate an embedded sign-in may trust: the listener the daemon is configured to
 * serve, identified by hostname and the SHA-256 fingerprint of the certificate file that
 * configuration names. Anything else — another origin, another certificate, the same certificate
 * on another host — stays under Chromium's own verification and fails closed.
 */
export interface LoginCertificateTrust {
  readonly hostname: string;
  readonly fingerprint256: string;
}

/** What Electron's certificate verify proc is consulted with; the port number is not part of it. */
export interface CertificateVerifyRequest {
  readonly hostname: string;
  readonly certificate: { readonly data: string };
  /** Chromium's own verdict: "OK" for a certificate it already trusts. */
  readonly verificationResult: string;
}

export type CertificateVerifyProc = (
  request: CertificateVerifyRequest,
  callback: (verificationResult: number) => void,
) => void;

/**
 * Resolve the trust anchor for one sign-in from the daemon's `listener` reply. Only an
 * authorization URL whose origin is exactly the configured listener (`https://hostname:port`)
 * earns trust: the daemon serves no other HTTPS origin, so a URL anywhere else is not this
 * listener and must not be trusted on its say-so. The certificate file is read at sign-in time,
 * so an operator replacing it takes effect on the next sign-in without a restart.
 */
export function resolveLoginCertificateTrust(input: {
  readonly listenerReply: unknown;
  readonly authorizationUrl: string;
  readonly readCertificateFile: (file: string) => string;
}): LoginCertificateTrust | null {
  const listener = (input.listenerReply as { readonly listener?: unknown } | null)?.listener;
  if (listener === null || typeof listener !== "object") return null;
  const { hostname, port, certificateFile } = listener as Record<string, unknown>;
  if (typeof hostname !== "string" || typeof certificateFile !== "string") return null;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) return null;
  try {
    if (new URL(input.authorizationUrl).origin !== `https://${hostname.toLowerCase()}:${port}`) return null;
    return {
      hostname: hostname.toLowerCase(),
      fingerprint256: certificateFingerprint256(input.readCertificateFile(certificateFile)),
    };
  } catch (error) {
    // A certificate that cannot be read or parsed is not a trust anchor; the sign-in page
    // then loads (or fails) under normal verification and the failure is shown in the panel.
    consumeKnownError(error);
    return null;
  }
}

export function loginCertificateAccepted(request: CertificateVerifyRequest, trust: LoginCertificateTrust): boolean {
  try {
    return (
      request.hostname.toLowerCase() === trust.hostname &&
      certificateFingerprint256(request.certificate.data) === trust.fingerprint256
    );
  } catch {
    return false;
  }
}

/**
 * One sign-in holds one scope; scopes install and release themselves so a cancelled or superseded
 * login cannot leave the browser session relaxed, and two concurrent sign-ins each keep their own
 * anchor. The session this guards also carries the general in-app browser, so the proc defers to
 * Chromium's own verdict (`verificationResult`) for everything no anchor pins: normal sites stay
 * loadable, and only the daemon-configured certificate is accepted above Chromium's judgment.
 */
export function createLoginCertificateTrustScopes(
  setCertificateVerifyProc: (proc: CertificateVerifyProc | null) => void,
): () => { readonly install: (trust: LoginCertificateTrust) => void; readonly release: () => void } {
  const active = new Map<object, LoginCertificateTrust>();
  const synchronize = (): void => {
    const anchors = [...active.values()];
    setCertificateVerifyProc(
      anchors.length === 0
        ? null
        : (request, callback) => {
            if (anchors.some((anchor) => loginCertificateAccepted(request, anchor))) {
              callback(0);
              return;
            }
            callback(request.verificationResult === "OK" ? 0 : -2);
          },
    );
  };
  return () => {
    const scope = {};
    return {
      install: (trust) => {
        active.set(scope, trust);
        synchronize();
      },
      release: () => {
        active.delete(scope);
        synchronize();
      },
    };
  };
}

/** The leaf is the first certificate in the file, which is the certificate Keycloak serves. */
function certificateFingerprint256(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}
