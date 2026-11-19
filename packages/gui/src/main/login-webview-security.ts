import { readFileSync } from "node:fs";
import type { App, session as electronSession, WebContents } from "electron";
import {
  createLoginWebviewGrants,
  isAllowedLoginRequest,
  matchesLoginCertificate,
  resolveLoginListenerTrust,
  type LoginWebviewAttachment,
} from "./login-webview-boundary.ts";
import { closeLoginProxy, openLoginProxy } from "./login-webview-proxy.ts";

/**
 * The Electron shell of the sign-in certificate boundary. A sign-in whose authorization URL is the
 * daemon-configured listener origin gets a one-off in-memory partition wired here; its trust lives
 * and dies with the sign-in's grant. The `app` certificate-error boundary decides with the event's
 * full URL (scheme + hostname + port), the guest WebContents identity, and the pinned fingerprint
 * together — no other session is ever touched, and Chromium's hostname-keyed certificate cache
 * cannot outlive the partition because the name is never reused.
 */
export function createLoginWebviewSecurity(session: Pick<typeof electronSession, "fromPartition">): {
  /** Sign-in port: mint the isolated partition for a listener-backed login, or null for none. */
  readonly openLoginWebview: (input: {
    readonly authorizationUrl: string;
    readonly callbackOrigin: string;
    readonly listenerReply: unknown;
  }) => Promise<{ readonly partitionToken: string; readonly release: () => Promise<void> } | null>;
  readonly installCertificateErrorHandler: (app: App) => void;
  readonly consumeWebviewAttachment: (params: {
    readonly partition?: string;
    readonly src?: string;
  }) => LoginWebviewAttachment | null;
  readonly attachGuest: (guest: WebContents) => boolean;
} {
  const grants = createLoginWebviewGrants();
  return {
    openLoginWebview: async ({ authorizationUrl, callbackOrigin, listenerReply }) => {
      const trust = resolveLoginListenerTrust({
        authorizationUrl,
        listenerReply,
        readCertificateFile: (file) => readFileSync(file, "utf8"),
      });
      if (!trust) return null;
      const allowedOrigins = [trust.origin, callbackOrigin],
        grant = grants.authorize({
          expectedSrc: authorizationUrl,
          allowedOrigins,
          trust,
          createSession: (partition) => session.fromPartition(partition),
        });
      // The login partition is at least as locked down as the in-app browser partition, plus the
      // request-layer origin allowlist that keeps a cached certificate acceptance from ever being
      // exercised outside the listener origin and the loopback callback.
      const loginSession = session.fromPartition(grant.partition);
      let active = true;
      let proxy: Awaited<ReturnType<typeof openLoginProxy>> | null = null;
      try {
        if (trust.proxyTarget !== undefined) {
          proxy = await openLoginProxy(trust.proxyTarget, trust.origin);
          const address = proxy.address();
          if (address === null || typeof address === "string") throw new Error("The login proxy did not bind a port.");
          // Chromium may already trust the upstream leaf. Pin it on every proxied TLS connection.
          // The request filter below scopes this hostname-only hook to the full browser origin.
          const hostname = new URL(trust.origin).hostname.replace(/^\[|\]$/gu, "");
          loginSession.setCertificateVerifyProc((request, callback) => {
            const matches = request.hostname.replace(/^\[|\]$/gu, "") === hostname;
            callback(
              active && matches && matchesLoginCertificate(request.certificate.data, trust.fingerprint256) ? 0 : -2,
            );
          });
          await loginSession.setProxy({
            proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`,
          });
        }
      } catch (error) {
        grants.release(grant.partitionToken);
        await closeLoginProxy(proxy);
        throw error;
      }
      loginSession.setPermissionCheckHandler(() => false);
      loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      loginSession.on("will-download", (event) => event.preventDefault());
      loginSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !active || !isAllowedLoginRequest(details.url, allowedOrigins) });
      });
      return {
        partitionToken: grant.partitionToken,
        release: async () => {
          active = false;
          grants.release(grant.partitionToken);
          try {
            await loginSession.setProxy({ mode: "direct" });
          } finally {
            await closeLoginProxy(proxy);
          }
        },
      };
    },
    installCertificateErrorHandler: (app) => {
      app.on("certificate-error", (event, webContents, url, _error, certificate, callback) => {
        // Non-login contexts (default session, in-app browser) resolve to false, which is exactly
        // the rejection they get without any listener at all.
        event.preventDefault();
        callback(
          !webContents.isDestroyed() &&
            grants.decideCertificateError({
              webContentsId: webContents.id,
              url,
              certificatePem: certificate.data,
            }),
        );
      });
    },
    consumeWebviewAttachment: (params) => grants.consumeWebviewAttachment(params),
    attachGuest: (guest) => {
      const guestId = guest.id;
      const attachment = grants.bindGuestWebContents(guestId, guest.session);
      if (!attachment) return false;
      guest.setWindowOpenHandler(() => ({ action: "deny" }));
      guest.on("will-navigate", (event, url) => {
        if (!isAllowedLoginRequest(url, attachment.allowedOrigins)) event.preventDefault();
      });
      guest.once("destroyed", () => grants.unbindGuestWebContents(guestId));
      return true;
    },
  };
}
