import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";
import { fakeKeycloak } from "../../packages/daemon/test/keycloak.fixtures.ts";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";

// A disposable external-provider fixture, not a real Keycloak acceptance test. Keep the
// existing realm's resource/scope evaluator; add only the interactive bootstrap/login endpoints.
const realm = fakeKeycloak();
realm.profile.attributes.push({ name: "harness_person_id" });
let challenge, token;
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const url = new URL(request.url, "http://127.0.0.1");
    const form = new URLSearchParams(raw);
    const json = (value, status = 200) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const owner = [...realm.users.values()].find((user) => user.username === "owner");
    if (url.pathname === "/realms/harness") return json({ realm: "harness" });
    if (url.pathname.endsWith("/auth/device")) {
      if (!owner || !realm.realmRoles.get("access-admin")?.members.has(owner.id)) return json({}, 403);
      challenge = form.get("code_challenge");
      return json({
        device_code: "smoke-device",
        user_code: "SMOKE",
        verification_uri: "http://127.0.0.1/device",
        expires_in: 30,
        interval: 0.01,
      });
    }
    if (url.pathname.endsWith("/token")) {
      if (form.get("grant_type") === "client_credentials")
        return form.get("client_secret") === workerData.secret && form.get("client_id") === "harness-center"
          ? json({ access_token: "center-token" })
          : json({}, 401);
      if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        if (
          !owner ||
          form.get("device_code") !== "smoke-device" ||
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") !== challenge
        )
          return json({}, 401);
        token = `fixture.${Buffer.from(JSON.stringify({ realm_access: { roles: ["access-admin"] } })).toString("base64url")}.fixture`;
        return json({
          access_token: token,
          refresh_token: "smoke-refresh",
          expires_in: 3600,
          refresh_expires_in: 3600,
        });
      }
      if (request.headers.authorization !== `Bearer ${token}` || !owner) return json({}, 401);
      const [resourceName, scope] = (form.get("permission") ?? "").split("#");
      const resource = [...realm.resources.values()].find((item) => item.name === resourceName);
      if (!resource) return json({ error: "invalid_resource" }, 400);
      const decision = await realm.fetch(
        "http://127.0.0.1/admin/realms/harness/clients/client-1/authz/resource-server/policy/evaluate",
        {
          method: "POST",
          body: JSON.stringify({ userId: owner.id, resources: [{ _id: resource._id, scopes: [{ name: scope }] }] }),
        },
      );
      return (await decision.json()).status === "PERMIT"
        ? json({ result: true })
        : json({ error: "access_denied" }, 403);
    }
    if (url.pathname.endsWith("/userinfo"))
      return request.headers.authorization === `Bearer ${token}` && owner
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
    if (url.pathname.endsWith("/role-mappings/realm") && answer.ok) {
      // External administrator provisions an explicit repository scope, never an all-resource grant.
      realm.permit("owner", workerData.repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    }
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(await answer.text());
  } catch (error) {
    return response.writeHead(500).end(JSON.stringify({ error: String(error) }));
  }
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(`http://127.0.0.1:${server.address().port}`));
