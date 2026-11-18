// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";

function writeEdgeConfig(
  edgeRoot: string,
  overrides: { readonly loginUrl: string; readonly loginBrowserUrl?: string; readonly loginCertificate: string },
): void {
  writeFileSync(
    path.join(edgeRoot, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: "edge-repo",
      host: "10.211.55.2",
      port: 7545,
      caPath: path.join(edgeRoot, "ca.pem"),
      nodeId: "edge-node-1",
      credential: "fixture-machine-secret",
      viewRoot: edgeRoot,
      quotaBytes: 1024,
      ...overrides,
    }),
  );
}

test("edge rbac-listener omits targetUrl when loginUrl matches browser origin and includes it for ssh-reverse", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-login-listener-")),
    userRoot = path.join(root, "user"),
    edgeRoot = path.join(root, "edge"),
    certificate = "-----BEGIN CERTIFICATE-----\nMIIFixture\n-----END CERTIFICATE-----\n";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(edgeRoot, { recursive: true });

  const host = await openDaemonHost({ daemonId: "edge-login-listener", userRoot });
  t.after(() => host.close());

  writeEdgeConfig(edgeRoot, {
    loginUrl: "https://10.211.55.2:18544",
    loginBrowserUrl: "https://10.211.55.2:18544",
    loginCertificate: certificate,
  });
  const directSameOrigin = await host.manageRbac({ operation: "listener", rootDir: edgeRoot }, auth);
  assert.deepEqual(directSameOrigin, {
    ok: true,
    command: "rbac-listener",
    listener: {
      address: "10.211.55.2",
      hostname: "10.211.55.2",
      port: 18544,
      certificate,
    },
    version: "fleet-edge-login",
  });
  assert.equal("targetUrl" in (directSameOrigin.listener as Record<string, unknown>), false);

  writeEdgeConfig(edgeRoot, {
    loginUrl: "https://10.211.55.2:18544",
    loginCertificate: certificate,
  });
  const directOmittedBrowserUrl = await host.manageRbac({ operation: "listener", rootDir: edgeRoot }, auth);
  assert.deepEqual(directOmittedBrowserUrl, {
    ok: true,
    command: "rbac-listener",
    listener: {
      address: "10.211.55.2",
      hostname: "10.211.55.2",
      port: 18544,
      certificate,
    },
    version: "fleet-edge-login",
  });
  assert.equal("targetUrl" in (directOmittedBrowserUrl.listener as Record<string, unknown>), false);

  writeEdgeConfig(edgeRoot, {
    loginUrl: "https://127.0.0.1:56506",
    loginBrowserUrl: "https://10.211.55.2:18544",
    loginCertificate: certificate,
  });
  const sshReverse = await host.manageRbac({ operation: "listener", rootDir: edgeRoot }, auth);
  assert.deepEqual(sshReverse, {
    ok: true,
    command: "rbac-listener",
    listener: {
      address: "127.0.0.1",
      hostname: "10.211.55.2",
      port: 18544,
      certificate,
      targetUrl: "https://127.0.0.1:56506/",
    },
    version: "fleet-edge-login",
  });
});
