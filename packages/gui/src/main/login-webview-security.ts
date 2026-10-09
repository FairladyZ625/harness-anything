import { readFileSync } from "node:fs";
import { session, type App, type WebContents } from "electron";
import {
  createLoginWebviewGrants,
  isAllowedLoginRequest,
  resolveLoginListenerTrust,
  type LoginWebviewAttachment,
} from "./login-webview-boundary.ts";

/**
 * The Electron shell of the sign-in certificate boundary. A sign-in whose authorization URL is the
 * daemon-configured listener origin gets a one-off in-memory partition wired here; its trust lives
 * and dies with the sign-in's grant. The `app` certificate-error boundary decides with the event's
 * full URL (scheme + hostname + port), the guest WebContents identity, and the pinned fingerprint
 * together — no other session is ever touched, and Chromium's hostname-keyed certificate cache
 * cannot outlive the partition because the name is never reused.
 */
export function createLoginWebviewSecurity(): {
  /** Sign-in port: mint the isolated partition for a listener-backed login, or null for none. */
  readonly openLoginWebview: (input: {
    readonly authorizationUrl: string;
    readonly callbackOrigin: string;
    readonly listenerReply: unknown;
  }) => { readonly partitionToken: string; readonly release: () => void } | null;
  readonly installCertificateErrorHandler: (app: App) => void;
  readonly consumeWebviewAttachment: (params: {
    readonly partition?: string;
    readonly src?: string;
  }) => LoginWebviewAttachment | null;
  readonly attachGuest: (guest: WebContents) => boolean;
} {
  const grants = createLoginWebviewGrants();
  return {
    openLoginWebview: ({ authorizationUrl, callbackOrigin, listenerReply }) => {
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
      loginSession.setPermissionCheckHandler(() => false);
      loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      loginSession.on("will-download", (event) => event.preventDefault());
      loginSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !isAllowedLoginRequest(details.url, allowedOrigins) });
      });
      return { partitionToken: grant.partitionToken, release: () => grants.release(grant.partitionToken) };
    },
    installCertificateErrorHandler: (app) => {
      app.on("certificate-error", (event, webContents, url, _error, certificate, callback) => {
        // Non-login contexts (default session, in-app browser) resolve to false, which is exactly
        // the rejection they get without any listener at all.
        event.preventDefault();
        callback(
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
      const attachment = grants.bindGuestWebContents(guest.id, guest.session);
      if (!attachment) return false;
      guest.setWindowOpenHandler(() => ({ action: "deny" }));
      guest.on("will-navigate", (event, url) => {
        if (!isAllowedLoginRequest(url, attachment.allowedOrigins)) event.preventDefault();
      });
      guest.once("destroyed", () => grants.unbindGuestWebContents(guest.id));
      return true;
    },
  };
}
