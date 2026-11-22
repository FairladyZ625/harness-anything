import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { parentPort, workerData } from "node:worker_threads";
import { fakeKeycloak } from "../../packages/daemon/test/keycloak.fixtures.ts";

// A disposable external-provider fixture, not a real Keycloak acceptance test. Keep the
// existing realm's resource/scope evaluator; add only the interactive bootstrap/login endpoints.
let realm = fakeKeycloak();
realm.profile.attributes.push({ name: "harness_person_id" });
let challenge;
const issuedTokens = new Set();
const handler = async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const scheme = workerData.tls ? "https" : "http";
    const hostHeader = request.headers.host || (workerData.tls ? "localhost" : "127.0.0.1");
    const url = new URL(request.url, `${scheme}://${hostHeader}`);
    const form = new URLSearchParams(raw);
    const json = (value, status = 200) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const owner = [...realm.users.values()].find((user) => user.username === "owner");
    const bearer = request.headers.authorization?.replace(/^Bearer /u, "");
    if (url.pathname === "/realms/harness") return json({ realm: "harness" });
    if (url.pathname === "/realms/harness/.well-known/openid-configuration")
      return json({ issuer: `${url.origin}/realms/harness` });
    if (url.pathname.endsWith("/auth/device")) {
      if (!owner) return json({}, 403);
      challenge = form.get("code_challenge");
      return json({
        device_code: "smoke-device",
        user_code: "SMOKE",
        verification_uri: `${url.origin}/device`,
        expires_in: 30,
        interval: 0.01,
      });
    }
    if (url.pathname.endsWith("/token/introspect")) {
      const answer = await realm.fetch(url, {
        method: "POST",
        headers: request.headers,
        body: form,
      });
      return json(await answer.json(), answer.status);
    }
    if (url.pathname.endsWith("/token")) {
      if (form.get("grant_type") === "client_credentials") {
        if (form.get("client_id") === "harness-center")
          return form.get("client_secret") === workerData.secret
            ? json({ access_token: "center-token" })
            : json({}, 401);
        const answer = await realm.fetch(url, {
          method: "POST",
          headers: request.headers,
          body: form,
        });
        return json(await answer.json(), answer.status);
      }
      if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        if (
          !owner ||
          form.get("device_code") !== "smoke-device" ||
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") !== challenge
        )
          return json({}, 401);
        const clientId = form.get("client_id") || "harness-gui";
        const nodeId = clientId.startsWith("harness-node-") ? clientId.slice("harness-node-".length) : "smoke-device";
        const token = `fixture.${Buffer.from(
          JSON.stringify({ iss: `${url.origin}/realms/harness`, jti: `${issuedTokens.size + 1}` }),
        ).toString("base64url")}.fixture`;
        issuedTokens.add(token);
        realm.interactiveSession("owner", nodeId, url.origin, token, clientId);
        return json({
          access_token: token,
          refresh_token: "smoke-refresh",
          expires_in: 3600,
          refresh_expires_in: 3600,
        });
      }
      if (!bearer || !issuedTokens.has(bearer) || !owner) return json({}, 401);
      const decision = await realm.fetch(url, {
        method: "POST",
        headers: request.headers,
        body: form,
      });
      return json(await decision.json(), decision.status);
    }
    if (url.pathname.endsWith("/userinfo"))
      return bearer && issuedTokens.has(bearer) && owner
        ? json({ sub: owner.id, harness_person_id: "owner" })
        : json({}, 401);
    if (request.headers.authorization !== "Bearer center-token") return json({}, 403);
    if (
      url.pathname.endsWith("/users") &&
      request.method === "POST" &&
      JSON.parse(raw).credentials?.[0]?.value !== workerData.password
    )
      return json({}, 400);
    const answer = await realm.fetch(url, {
      method: request.method,
      headers: request.headers,
      ...(raw ? { body: raw } : {}),
    });
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(await answer.text());
  } catch (error) {
    return response.writeHead(500).end(JSON.stringify({ error: String(error) }));
  }
};
const server = workerData.tls
  ? createHttpsServer({ key: workerData.tls.key, cert: workerData.tls.cert }, handler)
  : createHttpServer(handler);
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const origin = workerData.tls ? `https://localhost:${port}` : `http://127.0.0.1:${port}`;
  realm = fakeKeycloak(`${origin}/realms/harness`);
  realm.profile.attributes.push({ name: "harness_person_id" });
  parentPort.postMessage(origin);
});
