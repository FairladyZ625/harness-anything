// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactManifest, ManagedRbacService, managedRbacVersions } from "../src/managed-rbac-service.ts";

test("managed RBAC pins supported platform artifacts and published checksums", () => {
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64"] as const) {
    const artifacts = artifactManifest(platform);
    assert.deepEqual(
      artifacts.map(({ name }) => name),
      ["keycloak", "java", "postgres"],
    );
    assert.equal(
      artifacts.every(({ url, checksumUrl }) => url.startsWith("https://") && checksumUrl.startsWith("https://")),
      true,
    );
    assert.match(artifacts[0]?.url ?? "", new RegExp(managedRbacVersions.keycloak.replaceAll(".", "\\."), "u"));
    assert.match(artifacts[2]?.url ?? "", new RegExp(managedRbacVersions.postgres.replaceAll(".", "\\."), "u"));
  }
});

test("external Keycloak writes the connection contract only after probing the realm", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-external-"));
  let fetches = 0;
  try {
    const service = new ManagedRbacService(root, {
      fetch: (() => {
        fetches += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const result = await service.run({
      mode: "external",
      url: "https://identity.example.test/",
      realm: "fleet",
      clientId: "center",
    });
    assert.equal(result.mode, "external");
    assert.equal(fetches, 1);
    const config = JSON.parse(readFileSync(path.join(root, "rbac", "config.json"), "utf8"));
    assert.deepEqual(
      { mode: config.mode, url: config.url, realm: config.realm, clientId: config.clientId },
      { mode: "external", url: "https://identity.example.test", realm: "fleet", clientId: "center" },
    );
    assert.deepEqual(config.versions, managedRbacVersions);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed external Keycloak probe does not replace the active configuration", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-external-probe-"));
  try {
    const service = new ManagedRbacService(root, {
      fetch: (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch,
    });
    await assert.rejects(
      service.run({ mode: "external", url: "https://identity.example.test", realm: "fleet", clientId: "center" }),
      (error: unknown) => (error as { code?: string }).code === "rbac_external_probe_failed",
    );
    assert.equal(existsSync(path.join(root, "rbac", "config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external Keycloak rejects a non-loopback cleartext authority", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-external-invalid-"));
  try {
    const service = new ManagedRbacService(root);
    await assert.rejects(
      service.run({ mode: "external", url: "http://identity.example.test", realm: "fleet", clientId: "center" }),
      (error: unknown) => (error as { code?: string }).code === "rbac_external_url_insecure",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed bootstrap rejects a changed archive before extraction", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-checksum-"));
  try {
    const service = new ManagedRbacService(root, {
      platform: "darwin",
      arch: "arm64",
      fetch: ((url: string | URL | Request) =>
        Promise.resolve(
          new Response(
            String(url).includes("api.github.com")
              ? JSON.stringify({
                  assets: [
                    { name: `keycloak-${managedRbacVersions.keycloak}.tar.gz`, digest: `sha256:${"0".repeat(64)}` },
                  ],
                })
              : "changed",
            {
              status: 200,
            },
          ),
        )) as typeof fetch,
    });
    await assert.rejects(
      service.run({ operation: "bootstrap" }),
      (error: unknown) => (error as { code?: string }).code === "rbac_checksum_mismatch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a daemon start resumes the managed services unless an operator stopped them", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-resume-")),
    configFile = path.join(root, "rbac", "config.json"),
    config = () => JSON.parse(readFileSync(configFile, "utf8")),
    spawned: string[] = [],
    // Each start reaches PostgreSQL's launch, which is where this fixture ends it.
    service = () =>
      new ManagedRbacService(root, {
        spawn: ((command: string) => {
          spawned.push(path.basename(command));
          const child = new EventEmitter();
          setImmediate(() => child.emit("exit", 1));
          return child;
        }) as unknown as typeof import("node:child_process").spawn,
      }),
    launchEnded = { code: "rbac_process_failed" };
  // Nothing was ever bootstrapped: there is nothing to resume.
  await service().resume();
  mkdirSync(path.join(root, "rbac", "runtime", "postgres", "bin"), { recursive: true });
  writeFileSync(path.join(root, "rbac", "runtime", "postgres", "bin", "postgres"), "");
  writeFileSync(
    configFile,
    JSON.stringify({
      schema: "harness-managed-rbac/v1",
      mode: "managed",
      url: "http://127.0.0.1:1",
      realm: "harness",
      clientId: "harness-center",
      versions: managedRbacVersions,
      postgresPort: 2,
      managementPort: 3,
    }),
  );
  await assert.rejects(service().resume(), launchEnded);
  assert.deepEqual(spawned, ["postgres"]);

  // An operator's stop is recorded, so the next daemon leaves the services down.
  await service().run({ operation: "stop" });
  assert.equal(config().stopped, true);
  await service().resume();
  assert.deepEqual(spawned, ["postgres"]);

  // Starting them again is what lifts it.
  await assert.rejects(service().run({ operation: "start" }), launchEnded);
  assert.equal(config().stopped, false);
  await assert.rejects(service().resume(), launchEnded);
  assert.deepEqual(spawned, ["postgres", "postgres", "postgres"]);
});
