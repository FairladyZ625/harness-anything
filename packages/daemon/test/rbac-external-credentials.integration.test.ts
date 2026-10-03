// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";

// Real CLI, local socket and HTTP; the authority implements only this test's OIDC/Admin REST calls.
test("external credentials enter through CLI stdin, failed replacement preserves them and first-admin closes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-external-cli-")),
    userRoot = path.join(root, "user"),
    daemonId = "external-credentials",
    secret = randomBytes(24).toString("hex"),
    password = randomBytes(24).toString("hex");
  let hasAdmin = false,
    rejectedCandidate = false;
  const authority = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    let body = "";
    for await (const chunk of request) body += chunk;
    const json = (value: unknown, status = 200) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname.includes("/wrong/")) return json({}, 404);
    if (url.pathname.endsWith("/token")) {
      const params = new URLSearchParams(body);
      const valid = params.get("client_secret") === secret && params.get("client_id") === "harness-center";
      if (!valid) rejectedCandidate = true;
      return json(valid ? { access_token: "fixture-service-token" } : {}, valid ? 200 : 401);
    }
    if (url.pathname === "/realms/fleet") return json({ realm: "fleet" });
    if (request.headers.authorization !== "Bearer fixture-service-token") return json({}, 403);
    if (url.pathname.endsWith("/roles/access-admin/users")) return json(hasAdmin ? [{ id: "owner" }] : []);
    if (url.pathname.endsWith("/roles/access-admin")) return json({ id: "admin-role", name: "access-admin" });
    if (url.pathname.endsWith("/users") && request.method === "POST") {
      assert.equal(JSON.parse(body).credentials[0].value === password, true);
      return response.writeHead(201, { location: "/users/owner" }).end();
    }
    if (url.pathname.endsWith("/role-mappings/realm")) {
      hasAdmin = true;
      return response.writeHead(204).end();
    }
    if (url.pathname.endsWith("/users")) return json([]);
    return json({}, 404);
  });
  await new Promise<void>((resolve) => authority.listen(0, "127.0.0.1", resolve));
  const address = authority.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`,
    host = await openDaemonHost({ daemonId, userRoot }),
    transport = createUnixSocketTransportServer({
      daemonId,
      socketPath: localUserDaemonEndpoint(userRoot, daemonId),
      createProtocolServer: (authContext, emit) =>
        createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
    });
  await transport.start();
  const cli = async (args: string[], input = "") => {
    const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "bootstrap", ...args, "--json"],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            HARNESS_DAEMON_USER_ROOT: userRoot,
            HARNESS_DAEMON_ID: daemonId,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      child.stderr.on("data", (chunk) => {
        text += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, text }));
      child.stdin.end(input);
    });
    assert.equal(output.text.includes(secret) || output.text.includes(password), false, "CLI never echoes credentials");
    return { ...output, receipt: JSON.parse(output.text) };
  };
  const configArgs = [
    "--mode",
    "external",
    "--url",
    url,
    "--realm",
    "fleet",
    "--client-id",
    "harness-center",
    "--client-secret-stdin",
  ];
  try {
    const configured = await cli(configArgs, secret);
    assert.equal(configured.code, 0, configured.text);
    const configFile = path.join(userRoot, "rbac", "config.json"),
      secretFile = path.join(userRoot, "rbac", "center-client-secret"),
      before = readFileSync(configFile, "utf8");
    assert.equal(before.includes(secret), false);
    if (process.platform !== "win32") assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    const badSecret = await cli(configArgs, "invalid-candidate");
    assert.equal(badSecret.code, 1, badSecret.text);
    assert.equal(badSecret.receipt.code, "rbac_external_credentials_rejected");
    assert.equal(rejectedCandidate, true);
    assert.equal(
      (
        await cli(
          configArgs.map((value) => (value === "fleet" ? "wrong" : value)),
          secret,
        )
      ).receipt.code,
      "rbac_external_probe_failed",
    );
    assert.equal(
      (
        await cli(
          configArgs.map((value) => (value === "harness-center" ? "other-client" : value)),
          secret,
        )
      ).receipt.code,
      "rbac_external_client_invalid",
    );
    assert.equal(readFileSync(configFile, "utf8"), before);
    assert.equal(readFileSync(secretFile, "utf8") === secret, true);
    assert.equal((await cli(["--operation", "bootstrap-status"])).receipt.required, true);
    const passwordFile = path.join(root, "administrator-password");
    writeFileSync(passwordFile, password, { mode: 0o600 });
    const administrator = [
      "--operation",
      "bootstrap-admin",
      "--username",
      "owner",
      "--email",
      "owner@example.invalid",
      "--display-name",
      "Owner",
      "--person-id",
      "person-owner",
      "--password-file",
      passwordFile,
    ];
    assert.equal((await cli(administrator)).code, 0);
    assert.equal((await cli(administrator)).receipt.code, "bootstrap_admin_closed");
    assert.equal((await cli(configArgs, secret)).receipt.code, "authentication_required");
    assert.equal((await cli(["--operation", "bootstrap-status"])).receipt.required, false);
    assert.equal((await cli(["--operation", "health"])).text.includes(secret), false);
  } finally {
    await transport.stop();
    await host.close();
    await new Promise<void>((resolve, reject) => authority.close((error) => (error ? reject(error) : resolve())));
    rmSync(root, { recursive: true, force: true });
  }
});
