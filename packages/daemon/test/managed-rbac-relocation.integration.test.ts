// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KeycloakPolicyAdapter,
  ManagedRbacService,
  managedRbacVersions,
} from "@harness-anything/authorization-keycloak";
import { effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { createIdentityManagement } from "../src/daemon-host/authorization-provider.ts";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback port allocation failed");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function managedRoot(userRoot: string): Promise<void> {
  const rbacRoot = path.join(userRoot, "rbac");
  mkdirSync(rbacRoot, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(rbacRoot, "config.json"),
    JSON.stringify({
      schema: "harness-managed-rbac/v1",
      mode: "managed",
      url: `http://127.0.0.1:${await freeLoopbackPort()}`,
      realm: "harness",
      clientId: "harness-center",
      versions: managedRbacVersions,
      postgresPort: await freeLoopbackPort(),
      managementPort: await freeLoopbackPort(),
    }),
    { mode: 0o600 },
  );
}

async function centerAccessToken(url: string, secret: string): Promise<string> {
  const response = await fetch(`${url}/realms/harness/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "harness-center", client_secret: secret }),
  });
  assert.equal(response.ok, true, "the center service account authenticates");
  return ((await response.json()) as { readonly access_token: string }).access_token;
}

async function passwordLogin(url: string, username: string, password: string): Promise<Response> {
  return fetch(`${url}/realms/harness/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "relocation-login-test",
      username,
      password,
      scope: "openid",
    }),
  });
}

async function tlsPasswordLogin(
  port: number,
  certificateFile: string,
  username: string,
  password: string,
): Promise<{ readonly statusCode: number; readonly accessToken: string }> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "relocation-login-test",
    username,
    password,
    scope: "openid",
  }).toString();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/realms/harness/protocol/openid-connect/token",
        method: "POST",
        servername: "relocated.example.test",
        ca: readFileSync(certificateFile),
        headers: {
          host: `relocated.example.test:${port}`,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          let payload: { readonly access_token?: unknown };
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { readonly access_token?: unknown };
          } catch (error) {
            reject(error);
            return;
          }
          if (typeof payload.access_token !== "string") {
            reject(new Error(`TLS login returned HTTP ${String(response.statusCode)} without an access token.`));
            return;
          }
          resolve({ statusCode: response.statusCode ?? 0, accessToken: payload.access_token });
        });
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("TLS login timed out.")));
    request.once("error", reject);
    request.end(body);
  });
}

test(
  "managed Keycloak relocation preserves human login, policy decisions, and node credentials on a new TLS endpoint",
  { timeout: 600_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-relocation-integration-")),
      sourceRoot = path.join(root, "source"),
      targetRoot = path.join(root, "target"),
      bundleDir = path.join(root, "relocation-bundle"),
      user = { id: "person-relocation", username: "relocation-human", password: "Relocation-test-password-2026" },
      node = { id: "edge-relocation", credential: "Relocation-edge-credential-2026" },
      journal = { entries: [{ nodeId: node.id, admission: "accepted" }] };
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRoot, { recursive: true });
    await managedRoot(sourceRoot);
    const source = createIdentityManagement(sourceRoot) as ManagedRbacService;
    let targetForCleanup: ManagedRbacService | undefined;
    t.after(async () => {
      await Promise.all([source.stop(), targetForCleanup?.stop()]);
      rmSync(root, { recursive: true, force: true });
    });

    await source.run({ operation: "bootstrap", mode: "managed" });
    mkdirSync(path.join(targetRoot, "rbac"), { recursive: true, mode: 0o700 });
    cpSync(path.join(sourceRoot, "rbac", "runtime"), path.join(targetRoot, "rbac", "runtime"), { recursive: true });
    await managedRoot(targetRoot);
    const target = (targetForCleanup = createIdentityManagement(targetRoot) as ManagedRbacService);
    await target.run({ operation: "bootstrap", mode: "managed" });

    const sourceConfig = JSON.parse(readFileSync(path.join(sourceRoot, "rbac", "config.json"), "utf8")) as {
        readonly url: string;
      },
      targetConfig = JSON.parse(readFileSync(path.join(targetRoot, "rbac", "config.json"), "utf8")) as {
        readonly url: string;
      },
      sourceSecret = readFileSync(path.join(sourceRoot, "rbac", "center-client-secret"), "utf8").trim(),
      sourceToken = await centerAccessToken(sourceConfig.url, sourceSecret),
      sourcePolicy = new KeycloakPolicyAdapter({
        url: sourceConfig.url,
        realm: "harness",
        resourceServerClientId: "harness-center",
      }),
      createUser = await fetch(`${sourceConfig.url}/admin/realms/harness/users`, {
        method: "POST",
        headers: { authorization: `Bearer ${sourceToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          username: user.username,
          email: "relocation-human@example.invalid",
          emailVerified: true,
          enabled: true,
          attributes: { harness_person_id: [user.id] },
        }),
      });
    assert.equal(createUser.status, 201, "the source realm contains the original human account");
    const userId = await sourcePolicy.findUserId(sourceToken, user.id);
    assert.ok(userId);
    await sourcePolicy.writePasswordCredential(sourceToken, user.id, user.password);
    const loginClient = await fetch(`${sourceConfig.url}/admin/realms/harness/clients`, {
      method: "POST",
      headers: { authorization: `Bearer ${sourceToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "relocation-login-test",
        enabled: true,
        publicClient: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true,
      }),
    });
    assert.equal(loginClient.status, 201, "the isolated test login client was created");
    await sourcePolicy.createNode(sourceToken, { nodeId: node.id, personId: user.id }, node.credential);
    const groups = await sourcePolicy.readPolicyGroups(sourceToken),
      admin = groups.find((group) => group.id === "admin");
    assert.ok(admin);
    await sourcePolicy.writeGrant(
      sourceToken,
      { groupId: "admin", resource: "relocation-repo", userIds: [userId] },
      effectivePolicyGroupScopes(groups, admin.id),
    );
    const sourceLogin = await passwordLogin(sourceConfig.url, user.username, user.password);
    assert.equal(sourceLogin.ok, true, "the original human password authenticates before export");
    const sourceDecision = await sourcePolicy.authorizePerson({
      adminAccessToken: sourceToken,
      personId: user.id,
      action: "daemon-fleet-center-start",
      resource: { kind: "repository", repoId: "relocation-repo" },
    });
    assert.equal(sourceDecision.outcome, "allowed");
    assert.equal(await sourcePolicy.authenticateNode(node.id, node.credential), true);

    await source.exportRelocationBundle({ bundleDir, edgeJoinJournal: journal });
    const realmBytes = readFileSync(path.join(bundleDir, "realm.json")),
      targetSecretBeforeImport = readFileSync(path.join(targetRoot, "rbac", "center-client-secret"), "utf8"),
      targetConfigBeforeImport = readFileSync(path.join(targetRoot, "rbac", "config.json"), "utf8"),
      targetUrl = targetConfig.url,
      certificateFile = path.join(root, "relocated.crt"),
      certificateKeyFile = path.join(root, "relocated.key"),
      loginPort = await freeLoopbackPort();
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        certificateKeyFile,
        "-out",
        certificateFile,
        "-subj",
        "/CN=relocated.example.test",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:relocated.example.test,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );

    writeFileSync(path.join(bundleDir, "realm.json"), Buffer.concat([realmBytes, Buffer.from("\n")]));
    await assert.rejects(
      target.importRelocationBundle({
        bundleDir,
        loginUrl: `https://relocated.example.test:${loginPort}`,
        listenAddress: "127.0.0.1",
        certificateFile,
        certificateKeyFile,
      }),
      { code: "rbac_relocation_integrity_failed" },
    );
    assert.equal(
      readFileSync(path.join(targetRoot, "rbac", "center-client-secret"), "utf8"),
      targetSecretBeforeImport,
      "integrity refusal leaves target credentials untouched",
    );
    assert.equal(readFileSync(path.join(targetRoot, "rbac", "config.json"), "utf8"), targetConfigBeforeImport);
    assert.equal((await centerAccessToken(targetUrl, targetSecretBeforeImport.trim())).length > 0, true);
    writeFileSync(path.join(bundleDir, "realm.json"), realmBytes);

    const imported = await target.importRelocationBundle({
      bundleDir,
      loginUrl: `https://relocated.example.test:${loginPort}`,
      listenAddress: "127.0.0.1",
      certificateFile,
      certificateKeyFile,
    });
    assert.deepEqual(imported.edgeJoinJournal, journal);
    assert.equal(imported.loginUrl, `https://relocated.example.test:${loginPort}`);
    const finalConfig = JSON.parse(readFileSync(path.join(targetRoot, "rbac", "config.json"), "utf8")) as {
        readonly url: string;
        readonly listener: {
          readonly address: string;
          readonly hostname: string;
          readonly port: number;
          readonly certificateFile: string;
          readonly certificateKeyFile: string;
        };
      },
      targetSecret = readFileSync(path.join(targetRoot, "rbac", "center-client-secret"), "utf8").trim(),
      targetToken = await centerAccessToken(finalConfig.url, targetSecret),
      targetPolicy = new KeycloakPolicyAdapter({
        url: finalConfig.url,
        realm: "harness",
        resourceServerClientId: "harness-center",
      }),
      targetLogin = await tlsPasswordLogin(
        loginPort,
        finalConfig.listener.certificateFile,
        user.username,
        user.password,
      );
    assert.equal(finalConfig.url, targetUrl, "the target uses its own local PostgreSQL and Keycloak ports");
    assert.equal(finalConfig.listener.address, "127.0.0.1");
    assert.equal(finalConfig.listener.hostname, "relocated.example.test");
    assert.equal(finalConfig.listener.port, loginPort);
    assert.notEqual(finalConfig.listener.certificateFile, certificateFile);
    assert.notEqual(finalConfig.listener.certificateKeyFile, certificateKeyFile);
    assert.equal(existsSync(finalConfig.listener.certificateFile), true);
    assert.equal(existsSync(finalConfig.listener.certificateKeyFile), true);
    assert.equal(targetLogin.statusCode, 200, "the original human password still logs in over the new TLS listener");
    const loginClaims = JSON.parse(
      Buffer.from(targetLogin.accessToken.split(".")[1]!, "base64url").toString("utf8"),
    ) as {
      readonly iss: string;
    };
    assert.equal(loginClaims.iss, `https://relocated.example.test:${loginPort}/realms/harness`);
    const targetDecision = await targetPolicy.authorizePerson({
      adminAccessToken: targetToken,
      personId: user.id,
      action: "daemon-fleet-center-start",
      resource: { kind: "repository", repoId: "relocation-repo" },
    });
    assert.deepEqual(targetDecision, sourceDecision);
    assert.equal(await targetPolicy.authenticateNode(node.id, node.credential), true);
  },
);
