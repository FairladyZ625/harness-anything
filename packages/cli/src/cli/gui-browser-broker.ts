import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { isDaemonGuiReadMethod } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { requestLocalDaemonJsonRpc } from "../../../daemon/src/client/local-json-rpc-client.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
type JsonObject = { readonly [key: string]: unknown };

export interface BrowserGuiBroker {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export async function startBrowserGuiBroker(workspaceRoot: string, rootDir: string): Promise<BrowserGuiBroker> {
  const token = randomBytes(32).toString("base64url"),
    buildRoot = path.join(workspaceRoot, "packages/gui/dist"),
    server = createServer((request, response) => void handleRequest(request, response, buildRoot, rootDir, token));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || !("port" in address) || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("Browser broker did not bind the exact IPv4 loopback address.");
  }
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}/#access_token=${token}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  buildRoot: string,
  rootDir: string,
  token: string,
) {
  const address = request.socket.address();
  if (!address || typeof address === "string" || !("port" in address)) return reject(response, 403);
  const expectedHost = `127.0.0.1:${address.port}`;
  if (request.headers.host !== expectedHost) return reject(response, 403);
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.url === "/rpc") return handleRpc(request, response, rootDir, token, expectedHost);
  if (request.method !== "GET" && request.method !== "HEAD") return reject(response, 405);
  const requested = request.url === "/" ? "index.html" : decodeURIComponent((request.url ?? "").slice(1));
  const file = path.resolve(buildRoot, requested);
  if (!file.startsWith(`${path.resolve(buildRoot)}${path.sep}`) || !existsSync(file) || !statSync(file).isFile())
    return reject(response, 404);
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(file));
  if (request.method === "HEAD") return response.end();
  createReadStream(file).pipe(response);
}

async function handleRpc(
  request: IncomingMessage,
  response: ServerResponse,
  rootDir: string,
  token: string,
  host: string,
) {
  if (request.method !== "POST") return reject(response, 405);
  if (request.headers.origin !== `http://${host}` || !authorized(request.headers.authorization, token))
    return reject(response, 403);
  try {
    const body = await readBody(request),
      value = JSON.parse(body) as JsonObject;
    if (typeof value.method !== "string" || !isDaemonGuiReadMethod(value.method) || !record(value.params))
      return reject(response, 400);
    const repo = record(value.params.repo) ? value.params.repo : undefined;
    return requestLocalDaemonJsonRpc(rootDir, value.method, value.params as never, 75, {
      ...(typeof repo?.repoId === "string" ? { repoIdOverride: repo.repoId } : {}),
    }).then(
      (result) => {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      },
      (error: unknown) => {
        const rawCode =
            error instanceof Error && typeof (error as { readonly code?: unknown }).code === "string"
              ? (error as Error & { readonly code: string }).code
              : null,
          code =
            (error instanceof Error && error.message === "daemon_unavailable") || isDaemonUnavailableCode(rawCode)
              ? "daemon_unavailable"
              : (rawCode ?? "browser_broker_failed");
        response.statusCode = 502;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ok: false,
            error: { code, hint: error instanceof Error ? error.message : String(error) },
          }),
        );
      },
    );
  } catch (error) {
    response.statusCode = 502;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        ok: false,
        error: { code: "browser_broker_failed", hint: error instanceof Error ? error.message : String(error) },
      }),
    );
  }
}
function isDaemonUnavailableCode(code: string | null): boolean {
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTSOCK" || code === "EACCES";
}
function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7)),
    expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) request.destroy(new Error("Browser RPC body exceeds 1 MiB."));
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectPromise);
  });
}
function reject(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.end();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
