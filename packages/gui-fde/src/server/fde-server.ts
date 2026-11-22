import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { requestLocalDaemonJsonRpc } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import type { ScaffoldPresetInput, SimulationSamplePair } from "@harness-anything/preset";
import { compileStudioDraft } from "../studio/compiler.ts";
import { createDefaultFdeDraft, type FdeDomainDraft, type FdeLocale } from "../studio/domain-draft.ts";
import { consumeKnownError } from "../studio/error-consumption.ts";
import {
  applyPresetScaffold,
  persistStudioDraft,
  previewPresetScaffold,
  simulateStudioDraft,
} from "../studio/simulator.ts";
import type { FdeBootstrapPayload } from "../studio/studio-api.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOST = "127.0.0.1";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export interface FdeStudioServer {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface StartFdeStudioServerOptions {
  readonly rootDir: string;
  readonly distDir?: string;
  readonly port?: number;
  readonly queryDaemonVerticals?: (rootDir: string) => Promise<{
    readonly connected: boolean;
    readonly verticals: readonly { readonly id: string; readonly title: string }[];
  }>;
}

async function defaultQueryDaemonVerticals(rootDir: string): Promise<{
  readonly connected: boolean;
  readonly verticals: readonly { readonly id: string; readonly title: string }[];
  readonly reason?: string;
}> {
  try {
    const response = (await requestLocalDaemonJsonRpc(
      rootDir,
      "repo.task.run",
      { payload: { action: { kind: "vertical-list" } } } as never,
      5,
    )) as { readonly ok?: boolean; readonly evidence?: string };
    if (response?.ok !== true || typeof response.evidence !== "string") {
      return { connected: true, verticals: [] };
    }
    const parsed = JSON.parse(response.evidence) as {
      readonly verticals?: readonly { readonly id?: string; readonly title?: string }[];
    };
    const verticals = (parsed.verticals ?? [])
      .filter((item): item is { readonly id: string; readonly title: string } => typeof item.id === "string")
      .map((item) => ({ id: item.id, title: item.title ?? item.id }));
    return { connected: true, verticals };
  } catch (error) {
    return { connected: false, verticals: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function startFdeStudioServer(options: StartFdeStudioServerOptions): Promise<FdeStudioServer> {
  const rootDir = path.resolve(options.rootDir);
  const distDir = path.resolve(options.distDir ?? path.resolve(import.meta.dirname, "../../dist"));
  const token = randomBytes(32).toString("base64url");
  const queryDaemonVerticals = options.queryDaemonVerticals ?? defaultQueryDaemonVerticals;
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, { rootDir, distDir, token, queryDaemonVerticals });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    server.close();
    throw new Error("FDE Studio server failed to bind IPv4 loopback 127.0.0.1.");
  }
  const origin = `http://${LOOPBACK_HOST}:${address.port}`;
  return {
    url: `${origin}/#access_token=${token}`,
    origin,
    token,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    readonly rootDir: string;
    readonly distDir: string;
    readonly token: string;
    readonly queryDaemonVerticals: NonNullable<StartFdeStudioServerOptions["queryDaemonVerticals"]>;
  },
): Promise<void> {
  const address = request.socket.address();
  if (!address || typeof address === "string" || !("port" in address)) return sendStatus(response, 403);
  const expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  if (request.headers.host !== expectedHost) return sendStatus(response, 403);
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");

  const pathname = (request.url ?? "/").split("?")[0] ?? "/";
  if (pathname.startsWith("/api/")) {
    return handleApiRequest(request, response, pathname, expectedHost, context);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return sendStatus(response, 405);
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(context.distDir, requested);
  if (!resolved.startsWith(`${context.distDir}${path.sep}`) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    return sendStatus(response, 404);
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypeFor(resolved));
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(resolved).pipe(response);
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  expectedHost: string,
  context: {
    readonly rootDir: string;
    readonly token: string;
    readonly queryDaemonVerticals: NonNullable<StartFdeStudioServerOptions["queryDaemonVerticals"]>;
  },
): Promise<void> {
  if (!bearerTokenMatches(request.headers.authorization, context.token)) return sendStatus(response, 403);
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${expectedHost}`) {
    return sendStatus(response, 403);
  }
  try {
    if (pathname === "/api/bootstrap" && request.method === "GET") {
      const daemonState = await context.queryDaemonVerticals(context.rootDir);
      const payload: FdeBootstrapPayload = {
        rootDir: context.rootDir,
        draft: createDefaultFdeDraft(),
        daemonConnected: daemonState.connected,
        installedVerticals: daemonState.verticals,
      };
      return sendJson(response, 200, payload);
    }
    if (request.method !== "POST") return sendStatus(response, 405);
    const body = await readJsonBody(request);
    if (pathname === "/api/compile") {
      const draft = body.draft as FdeDomainDraft;
      return sendJson(response, 200, compileStudioDraft(draft, context.rootDir));
    }
    if (pathname === "/api/simulate") {
      const draft = body.draft as FdeDomainDraft;
      const result = await simulateStudioDraft({
        draft,
        rootDir: context.rootDir,
        ...(typeof body.locale === "string" ? { locale: body.locale as FdeLocale } : {}),
        ...(typeof body.presetId === "string" ? { presetId: body.presetId } : {}),
        ...(typeof body.profileId === "string" ? { profileId: body.profileId } : {}),
        ...(body.sampleOverrides && typeof body.sampleOverrides === "object"
          ? { sampleOverrides: body.sampleOverrides as Readonly<Record<string, SimulationSamplePair>> }
          : {}),
      });
      return sendJson(response, 200, result);
    }
    if (pathname === "/api/persist") {
      const draft = body.draft as FdeDomainDraft;
      const result = persistStudioDraft({
        draft,
        rootDir: context.rootDir,
        overwrite: body.overwrite === true,
        dryRun: body.dryRun === true,
      });
      return sendJson(response, 200, result);
    }
    if (pathname === "/api/preset/scaffold") {
      const presetInput: ScaffoldPresetInput = {
        rootDir: context.rootDir,
        presetId: String(body.presetId ?? ""),
        verticalId: String(body.verticalId ?? ""),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        overwrite: body.overwrite === true,
        dryRun: body.dryRun === true,
      };
      const result = body.previewOnly === true ? previewPresetScaffold(presetInput) : applyPresetScaffold(presetInput);
      return sendJson(response, 200, result);
    }
    return sendStatus(response, 404);
  } catch (error) {
    consumeKnownError(error);
    sendJson(response, 400, {
      ok: false,
      error: {
        code:
          typeof (error as { readonly code?: unknown })?.code === "string"
            ? String((error as { readonly code: string }).code)
            : "fde_studio_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
}

function bearerTokenMatches(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request payload exceeds 2 MiB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("Request payload must be a JSON object."));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        consumeKnownError(error);
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendStatus(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
