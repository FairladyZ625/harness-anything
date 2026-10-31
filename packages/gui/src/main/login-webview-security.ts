import { readFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
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
      const proxy = trust.proxyTarget === undefined ? null : await openLoginProxy(trust.proxyTarget);
      try {
        if (proxy) {
          const address = proxy.address();
          if (address === null || typeof address === "string") throw new Error("The login proxy did not bind a port.");
          await loginSession.setProxy({
            proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`,
          });
        }
      } catch (error) {
        await closeLoginProxy(proxy);
        grants.release(grant.partitionToken);
        throw error;
      }
      loginSession.setPermissionCheckHandler(() => false);
      loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      loginSession.on("will-download", (event) => event.preventDefault());
      loginSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !isAllowedLoginRequest(details.url, allowedOrigins) });
      });
      return {
        partitionToken: grant.partitionToken,
        release: async () => {
          grants.release(grant.partitionToken);
          await loginSession.setProxy({ mode: "direct" });
          await closeLoginProxy(proxy);
        },
      };
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
/**
 * Keeps the browser origin on the center hostname while the TCP connection uses the edge's
 * loopback SSH reverse-forward. CONNECT is the only supported proxy operation and the target is
 * fixed from the signed edge configuration, so a login page cannot turn this into an open proxy.
 */
async function openLoginProxy(targetUrl: string): Promise<Server> {
  const target = new URL(targetUrl),
    targetPort = Number(target.port || 443),
    targetHost = target.hostname;
  const proxy = createServer((client) => {
    let header = Buffer.alloc(0);
    const reject = () => {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        if (header.length > 16 * 1024) reject();
        return;
      }
      client.off("data", onData);
      const first = header.subarray(0, end).toString("latin1").split("\r\n", 1)[0] ?? "",
        match = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]$/u.exec(first),
        expected = `${targetHost}:${targetPort}`;
      if (!match || match[1] !== expected) {
        reject();
        return;
      }
      const upstream = connect(targetPort, targetHost);
      upstream.once("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  return proxy;
}

async function closeLoginProxy(proxy: Server | null): Promise<void> {
  if (!proxy) return;
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
