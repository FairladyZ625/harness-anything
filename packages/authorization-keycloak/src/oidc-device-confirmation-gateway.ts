import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { OidcLoginAuthority } from "@harness-anything/kernel";
import type { KeycloakSessionHost } from "./session-host.ts";
import { fetchWithTlsCa, systemCaCertificates } from "./tls-ca-certificate.ts";

const maxBodyBytes = 2 * 1024 * 1024;

export interface DeviceConfirmationGateway {
  readonly verificationUri: string;
  readonly close: () => Promise<void>;
}

/**
 * Exposes the edge device page on a daemon-owned loopback HTTP origin. Requests still go through
 * the pinned HTTPS SSH endpoint, while redirects, cookies, and HTML links stay on this origin so a
 * normal CLI browser needs no port forward, proxy rule, or trust-store change.
 */
export async function openDeviceConfirmationGateway(
  authority: OidcLoginAuthority,
  verificationUri: string,
  expiresInMs: number,
  fetcher: typeof fetch,
  host: Pick<KeycloakSessionHost, "fetchWithTlsCa" | "systemCaCertificates">,
): Promise<DeviceConfirmationGateway> {
  const browserUrl = authority.browserUrl;
  if (!browserUrl || !authority.url.startsWith("https://"))
    throw new Error("A managed confirmation gateway requires an HTTPS browser authority.");
  const browserOrigin = new URL(browserUrl).origin,
    upstreamOrigin = new URL(authority.url).origin,
    gatewayOriginRef = { value: "" },
    capability = randomBytes(24).toString("base64url"),
    server = createServer((request, response) => {
      void proxyRequest(
        request,
        response,
        authority,
        browserOrigin,
        upstreamOrigin,
        gatewayOriginRef.value,
        capability,
        fetcher,
      ).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
    });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The managed confirmation gateway did not bind a loopback port.");
  }
  const gatewayOrigin = `http://127.0.0.1:${address.port}`;
  gatewayOriginRef.value = gatewayOrigin;
  const page = new URL(verificationUri);
  page.protocol = "http:";
  page.host = new URL(gatewayOrigin).host;
  page.searchParams.set("harness_gateway", capability);
  const expiry = setTimeout(() => void closeServer(server), Math.max(0, expiresInMs));
  expiry.unref();
  return {
    verificationUri: page.toString(),
    close: () => {
      clearTimeout(expiry);
      return closeServer(server);
    },
  };
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authority: OidcLoginAuthority,
  browserOrigin: string,
  upstreamOrigin: string,
  gatewayOrigin: string,
  capability: string,
  fetcher: typeof fetch,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1"),
    parameters = requestUrl.searchParams,
    suppliedCapability = parameters.get("harness_gateway"),
    cookieCapability = readCookie(request.headers.cookie, "harness-gateway");
  if (suppliedCapability !== capability && cookieCapability !== capability) {
    response.writeHead(403).end();
    return;
  }
  parameters.delete("harness_gateway");
  const browserBase = new URL(authority.browserUrl!),
    authorityBase = new URL(authority.url),
    browserPrefix = browserBase.pathname.replace(/\/$/u, ""),
    targetPrefix = authorityBase.pathname.replace(/\/$/u, ""),
    browserPath = requestUrl.pathname.startsWith(browserPrefix)
      ? requestUrl.pathname.slice(browserPrefix.length)
      : undefined,
    upstreamPath =
      browserPath === undefined
        ? requestUrl.pathname
        : `${targetPrefix}${browserPath.startsWith("/") ? browserPath : `/${browserPath}`}`,
    upstream = new URL(
      `${upstreamPath}${parameters.size ? `?${parameters}` : ""}`,
      `${authority.url.replace(/\/$/u, "")}/`,
    ),
    headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ["connection", "content-length", "host"].includes(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("host", new URL(authority.browserUrl!).host);
  headers.set("accept-encoding", "identity");
  for (const name of ["origin", "referer"]) {
    const value = headers.get(name);
    if (value) headers.set(name, value.replaceAll(gatewayOrigin, browserOrigin));
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  const upstreamResponse = await host.fetchWithTlsCa(
    fetcher,
    authority.certificate ?? host.systemCaCertificates(),
    upstream,
    {
      method: request.method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
    },
    authority.servername ?? browserBase.hostname,
  );
  const raw = Buffer.from(await upstreamResponse.arrayBuffer()),
    contentType = upstreamResponse.headers.get("content-type") ?? "",
    text = /^(?:text\/|application\/(?:javascript|json))/iu.test(contentType)
      ? rewriteText(raw.toString("utf8"), [browserOrigin, upstreamOrigin], gatewayOrigin)
      : undefined,
    output = text === undefined ? raw : Buffer.from(text, "utf8"),
    responseHeaders = new Headers(upstreamResponse.headers);
  for (const name of ["content-length", "content-encoding", "connection", "transfer-encoding", "etag"])
    responseHeaders.delete(name);
  for (const [name, value] of [...responseHeaders]) {
    if (name !== "set-cookie")
      responseHeaders.set(name, rewriteText(value, [browserOrigin, upstreamOrigin], gatewayOrigin));
  }
  const cookies = responseHeaders.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    responseHeaders.delete("set-cookie");
    for (const cookie of cookies)
      responseHeaders.append("set-cookie", cookie.replace(/;\s*(?:Domain=[^;]*|Secure)(?=;|$)/giu, ""));
  }
  if (suppliedCapability === capability)
    responseHeaders.append("set-cookie", `harness-gateway=${capability}; Path=/; HttpOnly; SameSite=Lax`);
  const responseHeadersObject: Record<string, string | string[]> = Object.fromEntries(
    [...responseHeaders].filter(([name]) => name !== "set-cookie"),
  );
  const outputCookies = responseHeaders.getSetCookie?.() ?? [];
  if (outputCookies.length > 0) responseHeadersObject["set-cookie"] = outputCookies;
  response.writeHead(upstreamResponse.status, responseHeadersObject);
  response.end(output);
}

function rewriteText(value: string, origins: readonly string[], gatewayOrigin: string): string {
  return origins.reduce((text, origin) => text.replaceAll(origin, gatewayOrigin), value);
}

function readCookie(value: string | undefined, name: string): string | undefined {
  return value
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("The device confirmation request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
