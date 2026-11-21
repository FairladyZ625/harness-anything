import { hash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  PROMETHEUS_TEXT_CONTENT_TYPE,
  formatPrometheusMetrics,
  type DaemonMetricsSnapshot,
} from "@harness-anything/kernel";

export interface DaemonMetricsHttpConfig {
  readonly bind: string;
  readonly port: number;
  readonly path: string;
  readonly bearerToken: string | null;
}

export interface DaemonReadinessResult {
  readonly ready: boolean;
  readonly reasons?: readonly string[];
}

export interface DaemonMetricsServer {
  readonly bind: string;
  readonly port: number;
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

const RESERVED_PROBE_PATHS = new Set(["/healthz", "/readyz"]);

function parseDaemonMetricsPath(rawPath: string): string {
  const metricsPath = rawPath.trim();
  if (!metricsPath.startsWith("/") || /[\s\r\n?#]/u.test(metricsPath)) {
    throw new Error(`Invalid daemon metrics path: ${JSON.stringify(metricsPath)} (must start with '/').`);
  }
  if (metricsPath.includes("//") || /(?:^|\/)\.\.?(?:\/|$)/u.test(metricsPath)) {
    throw new Error(
      `Invalid daemon metrics path: ${JSON.stringify(metricsPath)} (must be a canonical path without dot segments or empty segments).`,
    );
  }
  const normalized = path.posix.normalize(metricsPath).replace(/\/+$/u, "") || "/";
  if (RESERVED_PROBE_PATHS.has(normalized)) {
    throw new Error(
      `Invalid daemon metrics path: ${JSON.stringify(metricsPath)} (conflicts with reserved probe path ${normalized}).`,
    );
  }
  return metricsPath;
}

export function resolveDaemonMetricsConfig(
  env: Readonly<Record<string, string | undefined>>,
  overrides?: { readonly bind?: string; readonly port?: string | number; readonly path?: string },
): DaemonMetricsHttpConfig | null {
  const rawPort = overrides?.port ?? env.HARNESS_DAEMON_METRICS_PORT;
  if (rawPort === undefined || String(rawPort).trim() === "") return null;

  const portText = String(rawPort).trim();
  if (!/^\d+$/u.test(portText)) {
    throw new Error(`Invalid daemon metrics port: ${portText} (expected integer 0..65535).`);
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid daemon metrics port: ${portText} (expected integer 0..65535).`);
  }

  const bind = (overrides?.bind ?? env.HARNESS_DAEMON_METRICS_BIND ?? "127.0.0.1").trim();
  if (!bind || /[\s\r\n]/u.test(bind)) {
    throw new Error(`Invalid daemon metrics bind address: ${JSON.stringify(bind)}.`);
  }

  const metricsPath = parseDaemonMetricsPath(overrides?.path ?? env.HARNESS_DAEMON_METRICS_PATH ?? "/metrics");

  const rawToken = env.HARNESS_DAEMON_METRICS_BEARER_TOKEN;
  const bearerToken = rawToken !== undefined && rawToken.length > 0 ? rawToken : null;

  return {
    bind,
    port,
    path: metricsPath,
    bearerToken,
  };
}

export async function startDaemonMetricsServer(options: {
  readonly config: DaemonMetricsHttpConfig;
  readonly daemonId: string;
  readonly collectSnapshot: () => DaemonMetricsSnapshot;
  readonly isLive: () => boolean;
  readonly isReady: () => boolean | DaemonReadinessResult;
  readonly onError?: (error: unknown, context: { readonly pathname: string }) => void;
}): Promise<DaemonMetricsServer> {
  const validatedPath = parseDaemonMetricsPath(options.config.path);
  const config: DaemonMetricsHttpConfig = { ...options.config, path: validatedPath };
  const serverOptions = { ...options, config };
  const expectedTokenHash = config.bearerToken === null ? null : sha256Digest(config.bearerToken);

  const server: Server = createServer((request, response) => {
    const handled = invokeSafely(() => {
      handleRequest(request, response, serverOptions, expectedTokenHash);
    });
    if (!handled.ok) {
      const pathname = parsePathname(request.url ?? "/");
      reportMetricsError(options.onError, handled.error, pathname);
      if (!response.headersSent && !response.writableEnded) {
        writeResponse(
          response,
          500,
          "text/plain; charset=utf-8",
          (request.method ?? "GET") === "HEAD" ? "" : "Internal Server Error\n",
        );
      } else if (!response.writableEnded) {
        response.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.config.port, options.config.bind);
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("Metrics HTTP server did not bind a TCP address.");
  }

  const hostForUrl = address.address.includes(":") ? `[${address.address}]` : address.address;
  const endpoint = `http://${hostForUrl}:${address.port}${options.config.path}`;

  return {
    bind: address.address,
    port: address.port,
    endpoint,
    close: () => closeHttpServer(server),
  };
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly config: DaemonMetricsHttpConfig;
    readonly daemonId: string;
    readonly collectSnapshot: () => DaemonMetricsSnapshot;
    readonly isLive: () => boolean;
    readonly isReady: () => boolean | DaemonReadinessResult;
    readonly onError?: (error: unknown, context: { readonly pathname: string }) => void;
  },
  expectedTokenHash: Buffer | null,
): void {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    writeResponse(response, 405, "text/plain; charset=utf-8", "Method Not Allowed\n");
    return;
  }

  const pathname = parsePathname(request.url ?? "/");
  if (pathname === "/healthz") {
    const liveResult = invokeSafely(() => options.isLive());
    if (!liveResult.ok) reportMetricsError(options.onError, liveResult.error, pathname);
    const live = liveResult.ok && liveResult.value;
    const payload = JSON.stringify({
      ok: live,
      status: !liveResult.ok ? "error" : live ? "live" : "stopping",
      daemonId: options.daemonId,
      pid: process.pid,
    });
    writeResponse(
      response,
      live ? 200 : 503,
      "application/json; charset=utf-8",
      method === "HEAD" ? "" : `${payload}\n`,
    );
    return;
  }

  if (pathname === "/readyz") {
    const readyResult = invokeSafely<DaemonReadinessResult>(() => {
      if (!options.isLive()) return { ready: false, reasons: ["stopping"] };
      const raw = options.isReady();
      return typeof raw === "boolean" ? { ready: raw } : raw;
    });
    if (!readyResult.ok) reportMetricsError(options.onError, readyResult.error, pathname);
    const ready = readyResult.ok && readyResult.value.ready;
    const reasons = readyResult.ok && !ready ? readyResult.value.reasons : undefined;
    const payload = JSON.stringify({
      ok: ready,
      status: !readyResult.ok ? "error" : ready ? "ready" : "not_ready",
      ...(reasons && reasons.length > 0 ? { reasons } : {}),
      daemonId: options.daemonId,
      pid: process.pid,
    });
    writeResponse(
      response,
      ready ? 200 : 503,
      "application/json; charset=utf-8",
      method === "HEAD" ? "" : `${payload}\n`,
    );
    return;
  }

  if (pathname === options.config.path) {
    if (expectedTokenHash !== null && !bearerTokenMatches(request.headers.authorization, expectedTokenHash)) {
      writeResponse(response, 401, "text/plain; charset=utf-8", "Unauthorized\n", {
        "www-authenticate": "Bearer",
      });
      return;
    }
    const bodyResult = invokeSafely(() => formatPrometheusMetrics(options.collectSnapshot()));
    if (!bodyResult.ok) {
      reportMetricsError(options.onError, bodyResult.error, pathname);
      writeResponse(response, 500, "text/plain; charset=utf-8", method === "HEAD" ? "" : "Internal Server Error\n");
      return;
    }
    const body = bodyResult.value;
    writeResponse(response, 200, PROMETHEUS_TEXT_CONTENT_TYPE, method === "HEAD" ? "" : body, {
      "content-length": String(Buffer.byteLength(body, "utf8")),
    });
    return;
  }

  writeResponse(response, 404, "text/plain; charset=utf-8", "Not Found\n");
}

type MetricsCallResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function invokeSafely<T>(operation: () => T): MetricsCallResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function reportMetricsError(
  onError: ((error: unknown, context: { readonly pathname: string }) => void) | undefined,
  error: unknown,
  pathname: string,
): void {
  if (!onError) return;
  const reported = invokeSafely(() => {
    onError(error, { pathname });
  });
  void reported;
}

function parsePathname(rawUrl: string): string {
  const queryStart = rawUrl.indexOf("?");
  return queryStart >= 0 ? rawUrl.slice(0, queryStart) : rawUrl;
}

function bearerTokenMatches(header: string | undefined, expectedHash: Buffer): boolean {
  return (
    typeof header === "string" &&
    header.startsWith("Bearer ") &&
    header.length > "Bearer ".length &&
    timingSafeEqual(sha256Digest(header.slice("Bearer ".length)), expectedHash)
  );
}

function sha256Digest(value: string): Buffer {
  return hash("sha256", value, "buffer");
}

function writeResponse(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}
