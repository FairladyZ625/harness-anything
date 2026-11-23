// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  artifactManifest,
  ManagedRbacService,
  managedRbacVersions,
} from "@harness-anything/authorization/keycloak/managed-rbac-service";
import type { ManagedRbacHost } from "../../authorization/src/keycloak/managed-host.ts";
import { createIdentityManagement } from "../src/daemon-host/authorization-provider.ts";
import { validateCertificateNames } from "../src/daemon-host/tls-listener-admission.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function selectIdentityMode(root: string, mode: "external" | "managed"): void {
  const rbacRoot = path.join(root, "rbac");
  mkdirSync(rbacRoot, { recursive: true });
  writeFileSync(
    path.join(rbacRoot, "config.json"),
    JSON.stringify(
      mode === "managed"
        ? {
            schema: "harness-managed-rbac/v1",
            mode,
            url: "http://127.0.0.1:1",
            realm: "harness",
            clientId: "harness-center",
            versions: managedRbacVersions,
            postgresPort: 2,
            managementPort: 3,
          }
        : { schema: "harness-managed-rbac/v1", mode },
    ),
  );
}

test("managed RBAC pins supported platform artifacts and published checksums", () => {
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "win32-arm64"] as const) {
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
    if (platform.startsWith("win32-")) {
      assert.match(artifacts[0]?.url ?? "", /keycloak-26\.7\.3\.zip$/u);
      assert.match(artifacts[1]?.url ?? "", /\/windows\/x64\//u);
      assert.match(artifacts[2]?.url ?? "", /embedded-postgres-binaries-windows-amd64/u);
    }
  }
});

test("external Keycloak writes the connection contract only after probing the realm", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-external-"));
  selectIdentityMode(root, "external");
  let fetches = 0;
  try {
    const service = createIdentityManagement(root, {
      fetch: (() => {
        fetches += 1;
        return Promise.resolve(Response.json({ access_token: "test-token" }));
      }) as typeof fetch,
    });
    const result = await service.run({
      mode: "external",
      url: "https://identity.example.test/",
      realm: "fleet",
      clientId: "harness-center",
      clientSecret: "test-center-secret",
    });
    assert.equal(result.mode, "external");
    assert.equal(fetches, 3);
    const config = JSON.parse(readFileSync(path.join(root, "rbac", "config.json"), "utf8"));
    assert.deepEqual(
      { mode: config.mode, url: config.url, realm: config.realm, clientId: config.clientId },
      { mode: "external", url: "https://identity.example.test", realm: "fleet", clientId: "harness-center" },
    );
    assert.deepEqual(config.versions, managedRbacVersions);
  } finally {
    removeTempRepository(root);
  }
});

for (const failure of ["token", "malformed", "missing", "admin"] as const) {
  test(`external ${failure} refusal preserves the configured credentials without response disclosure`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-external-refusal-"));
    selectIdentityMode(root, "external");
    let reject = false;
    const service = createIdentityManagement(root, {
      fetch: async (url) => {
        if (String(url).endsWith("/token")) {
          if (reject && failure === "token") return new Response(null, { status: 401 });
          if (reject && failure === "malformed") return new Response("candidate-secret");
          return Response.json(reject && failure === "missing" ? null : { access_token: "test-token" });
        }
        return Response.json([], {
          status: reject && failure === "admin" && String(url).includes("/admin/") ? 403 : 200,
        });
      },
    });
    const config = {
      mode: "external",
      url: "https://identity.example.test",
      realm: "fleet",
      clientId: "harness-center",
    } as const;
    try {
      await service.run({ ...config, clientSecret: "original-secret" });
      const configFile = path.join(root, "rbac", "config.json"),
        before = readFileSync(configFile, "utf8");
      reject = true;
      await assert.rejects(service.run({ ...config, clientSecret: "candidate-secret" }), (error: unknown) => {
        assert.equal(String(error).includes("candidate-secret"), false);
        return (error as { code: string }).code === "rbac_external_credentials_rejected";
      });
      assert.equal(readFileSync(configFile, "utf8"), before);
      assert.equal(readFileSync(path.join(root, "rbac", "center-client-secret"), "utf8") === "original-secret", true);
    } finally {
      removeTempRepository(root);
    }
  });
}

test("health propagates a realm transport failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-health-"));
  try {
    mkdirSync(path.join(root, "rbac"));
    writeFileSync(
      path.join(root, "rbac", "config.json"),
      JSON.stringify({
        mode: "external",
        url: "https://identity.example.test",
        realm: "fleet",
        clientId: "center",
      }),
    );
    const failure = new Error("fixture realm transport failure");
    const service = createIdentityManagement(root, {
      fetch: async () => {
        throw failure;
      },
    });
    await assert.rejects(service.run({ operation: "health" }), (error) => error === failure);
  } finally {
    removeTempRepository(root);
  }
});

test("external health without a configured endpoint reports rbac_not_configured", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-unconfigured-health-"));
  let fetches = 0;
  try {
    mkdirSync(path.join(root, "rbac"));
    writeFileSync(
      path.join(root, "rbac", "config.json"),
      JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external" }),
    );
    const service = createIdentityManagement(root, {
      fetch: (async () => {
        fetches += 1;
        return Response.json({});
      }) as typeof fetch,
    });
    await assert.rejects(service.run({ operation: "health" }), { code: "rbac_not_configured" });
    assert.equal(fetches, 0);
  } finally {
    removeTempRepository(root);
  }
});

test("failed external Keycloak probe does not replace the active configuration", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-external-probe-"));
  selectIdentityMode(root, "external");
  try {
    const service = createIdentityManagement(root, {
      fetch: (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch,
    });
    rmSync(path.join(root, "rbac", "config.json"));
    await assert.rejects(
      service.run({
        mode: "external",
        url: "https://identity.example.test",
        realm: "fleet",
        clientId: "harness-center",
        clientSecret: "test-center-secret",
      }),
      (error: unknown) => (error as { code?: string }).code === "rbac_external_probe_failed",
    );
    assert.equal(existsSync(path.join(root, "rbac", "config.json")), false);
  } finally {
    removeTempRepository(root);
  }
});

test("external Keycloak rejects a non-loopback cleartext authority", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-external-invalid-"));
  selectIdentityMode(root, "external");
  try {
    const service = createIdentityManagement(root);
    await assert.rejects(
      service.run({
        mode: "external",
        url: "http://identity.example.test",
        realm: "fleet",
        clientId: "harness-center",
        clientSecret: "test-center-secret",
      }),
      (error: unknown) => (error as { code?: string }).code === "rbac_external_url_insecure",
    );
  } finally {
    removeTempRepository(root);
  }
});

test("managed bootstrap rejects a changed archive before extraction", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-checksum-"));
  selectIdentityMode(root, "managed");
  try {
    const service = createIdentityManagement(root, {
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
    removeTempRepository(root);
  }
});

test("a daemon start resumes the managed services unless an operator stopped them", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-resume-")),
    configFile = path.join(root, "rbac", "config.json"),
    config = () => JSON.parse(readFileSync(configFile, "utf8")),
    spawned: string[] = [],
    // Each start reaches PostgreSQL's launch, which is where this fixture ends it.
    service = () =>
      createIdentityManagement(root, {
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

const keycloakArgsWithoutListener = [
  "start",
  "--http-enabled=true",
  "--hostname-strict=false",
  "--import-realm",
  "--health-enabled=true",
];

/** A bootstrapped managed installation whose PostgreSQL and Keycloak launches report ready at once. */
function managedFixture(
  startsUnder: (env: NodeJS.ProcessEnv) => boolean = () => true,
  fetchPort: typeof fetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch,
  platform: "darwin" | "win32" = "darwin",
  onListenerWriteStage?: (stage: "certificate" | "key" | "config" | "cleanup") => void,
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-listener-")),
    configFile = path.join(root, "rbac", "config.json"),
    certificateFile = path.join(root, "center.crt"),
    certificateKeyFile = path.join(root, "center.key"),
    launches: { name: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  mkdirSync(path.join(root, "rbac", "runtime", "postgres", "bin"), { recursive: true });
  writeFileSync(
    path.join(root, "rbac", "runtime", "postgres", "bin", platform === "win32" ? "postgres.exe" : "postgres"),
    "",
  );
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
      "/CN=center.example.test",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:center.example.test,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  chmodSync(certificateKeyFile, 0o600);
  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        schema: "harness-managed-rbac/v1",
        mode: "managed",
        url: "http://127.0.0.1:1",
        realm: "harness",
        clientId: "harness-center",
        versions: managedRbacVersions,
        postgresPort: 2,
        managementPort: 3,
      },
      null,
      2,
    )}\n`,
  );
  const managedPorts = {
    fetch: fetchPort,
    platform,
    arch: platform === "win32" ? "x64" : "arm64",
    ...(onListenerWriteStage ? { onListenerWriteStage } : {}),
    spawn: ((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      const name = path.basename(command),
        child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          kill: () => setImmediate(() => child.emit("exit", 0)),
        });
      launches.push({ name, args, env: options.env });
      setImmediate(() =>
        name.startsWith("postgres")
          ? child.stdout.emit("data", "database system is ready to accept connections")
          : startsUnder(options.env)
            ? child.stdout.emit("data", "Keycloak 26 started in 1s")
            : child.emit("exit", 1),
      );
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  };
  const service =
    platform === "win32"
      ? new ManagedRbacService(root, windowsFixtureHost(), managedPorts)
      : createIdentityManagement(root, managedPorts);
  return {
    root,
    service,
    certificateFile,
    certificateKeyFile,
    configText: () => readFileSync(configFile, "utf8"),
    config: () => JSON.parse(readFileSync(configFile, "utf8")),
    keycloakLaunches: () =>
      launches.filter(
        ({ name, args }) =>
          name === "kc.sh" ||
          name === "kc.bat" ||
          name === "powershell.exe" ||
          args.some((arg) => /kc\.bat/u.test(arg)),
      ),
    postgresLaunches: () => launches.filter(({ name }) => name.startsWith("postgres")),
    version: async () => String((await service.run({ operation: "listener" })).version),
    close: async () => {
      await service.stop();
      removeTempRepository(root);
    },
  };
}

function windowsFixtureHost(): ManagedRbacHost {
  return {
    runProcessText: () => "",
    runProcessTextAsync: async () => "",
    runProcessExitAsync: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
    validateCertificateNames: () => undefined,
    mapListenerBindError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  };
}

async function withImmediateReadinessIntervals<T>(operation: () => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0, ...args: unknown[]) =>
    originalSetTimeout(callback, delay === 250 ? 0 : delay, ...args)) as typeof setTimeout;
  try {
    return await operation();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("managed RBAC resume waits through a transient realm health connection refusal", async () => {
  const keycloak = fakeKeycloak();
  let healthAttempts = 0;
  const managed = managedFixture(
    () => true,
    async (input, init) => {
      if (new URL(String(input)).pathname === "/realms/harness" && healthAttempts++ === 0)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
        });
      return keycloak.fetch(input, init);
    },
  );
  writeFileSync(path.join(managed.root, "rbac", "center-client-secret"), "fixture-secret");
  try {
    await managed.service.resume();
    assert.equal(healthAttempts, 2, "resume retries realm readiness after a connection refusal");
  } finally {
    await managed.close();
  }
});

test("managed RBAC resume waits through realm HTTP 503 responses beyond the Unix readiness budget", async () => {
  const keycloak = fakeKeycloak();
  let healthAttempts = 0;
  const managed = managedFixture(
    () => true,
    async (input, init) => {
      if (new URL(String(input)).pathname === "/realms/harness" && healthAttempts++ < 120)
        return new Response("Keycloak is still initializing", { status: 503 });
      return keycloak.fetch(input, init);
    },
  );
  writeFileSync(path.join(managed.root, "rbac", "center-client-secret"), "fixture-secret");
  try {
    await withImmediateReadinessIntervals(() => managed.service.resume());
    assert.equal(healthAttempts, 121, "realm readiness accepts 200 after more than the old 30-second budget");
  } finally {
    await managed.close();
  }
});

test("managed RBAC readiness fails closed with an HTTP 503 diagnostic after the full Unix budget", async () => {
  let healthAttempts = 0;
  const managed = managedFixture(
    () => true,
    async (input) => {
      if (new URL(String(input)).pathname === "/realms/harness") {
        healthAttempts += 1;
        return new Response("Keycloak is still initializing", { status: 503 });
      }
      return Response.json({});
    },
  );
  try {
    await withImmediateReadinessIntervals(() =>
      assert.rejects(managed.service.resume(), (error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /HTTP 503 after 180000ms/u);
        return true;
      }),
    );
    assert.equal(healthAttempts, 720, "persistent 503 remains bounded by the 3-minute Unix budget");
  } finally {
    await managed.close();
  }
});

test("managed RBAC resume surfaces an unclassified realm health failure immediately", async () => {
  const failure = new Error("fixture realm health programming failure");
  let healthAttempts = 0;
  const managed = managedFixture(
    () => true,
    async () => {
      healthAttempts += 1;
      throw failure;
    },
  );
  try {
    await assert.rejects(managed.service.resume(), (error) => error === failure);
    assert.equal(healthAttempts, 1, "unknown failures are not treated as startup transport transients");
  } finally {
    await managed.close();
  }
});

test("Windows managed services use native executable and batch entrypoints", async () => {
  const managed = managedFixture(() => true, undefined, "win32");
  try {
    await managed.service.start();
    assert.equal(managed.postgresLaunches()[0]?.name, "postgres.exe");
    assert.equal(managed.keycloakLaunches()[0]?.name, "powershell.exe");
    assert.equal(managed.keycloakLaunches()[0]?.args[3], "-EncodedCommand");
    assert.match(managed.keycloakLaunches()[0]?.args[4] ?? "", /^[A-Za-z0-9+/=]+$/u);
  } finally {
    await managed.close();
  }
});

function availablePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** What a client connecting to `port` receives after sending `text`; `refused` when nothing listens there. */
function exchange(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(chunk.toString());
    });
    socket.once("error", () => resolve("refused"));
  });
}

test("without a listener the managed services start on loopback HTTP exactly as before", async () => {
  const managed = managedFixture(),
    before = managed.configText();
  try {
    await managed.service.start();
    const [keycloak] = managed.keycloakLaunches();
    assert.deepEqual(keycloak!.args, keycloakArgsWithoutListener);
    assert.equal(keycloak!.env.KC_HTTP_HOST, "127.0.0.1");
    assert.deepEqual(
      Object.keys(keycloak!.env).filter((name) => name.startsWith("KC_HTTPS") || name.startsWith("KC_HOSTNAME")),
      [],
    );
    assert.equal(managed.configText(), before);
    assert.equal((await managed.service.run({ operation: "listener" })).listener, null);
  } finally {
    await managed.close();
  }
});

function assertManagedUploadedPair(
  root: string,
  listener: { readonly certificateFile: string; readonly certificateKeyFile: string },
): void {
  const listenerRoot = path.join(root, "rbac", "listener"),
    versionDir = path.dirname(listener.certificateFile);
  assert.equal(path.dirname(versionDir), listenerRoot);
  assert.equal(path.basename(versionDir).startsWith("uploaded-"), true);
  assert.equal(path.dirname(listener.certificateKeyFile), versionDir);
  assert.equal(path.basename(listener.certificateFile), "listener.pem");
  assert.equal(path.basename(listener.certificateKeyFile), "listener.key");
  assert.equal(lstatSync(listener.certificateFile).isSymbolicLink(), false);
  assert.equal(lstatSync(listener.certificateKeyFile).isSymbolicLink(), false);
  assert.equal(statSync(listenerRoot).mode & 0o777, 0o700);
  assert.equal(statSync(versionDir).mode & 0o777, 0o700);
  assert.equal(statSync(listener.certificateFile).mode & 0o777, 0o644);
  assert.equal(statSync(listener.certificateKeyFile).mode & 0o777, 0o600);
}

function generateTestCertificate(dir: string, cn: string, prefix = "cert"): { certFile: string; keyFile: string } {
  const certFile = path.join(dir, `${prefix}.crt`),
    keyFile = path.join(dir, `${prefix}.key`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      `/CN=${cn}`,
      "-days",
      "1",
      "-addext",
      `subjectAltName=DNS:${cn},IP:127.0.0.1`,
    ],
    { stdio: "ignore" },
  );
  chmodSync(keyFile, 0o600);
  return { certFile, keyFile };
}

test("a listener carries HTTPS for edge nodes while Keycloak, PostgreSQL, and management stay on loopback", async () => {
  const managed = managedFixture(),
    port = await availablePort(),
    listener = {
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port,
      certificateFile: managed.certificateFile,
      certificateKeyFile: managed.certificateKeyFile,
    },
    loopbackVersion = await managed.version();
  try {
    const set = await managed.service.run({ operation: "listener-set", ...listener, expectedVersion: loopbackVersion });
    assert.equal(set.ok, true);
    const storedListener = managed.config().listener;
    assertManagedUploadedPair(managed.root, storedListener);
    const managedCert = storedListener.certificateFile,
      managedKey = storedListener.certificateKeyFile;
    assert.deepEqual(storedListener, {
      address: listener.listenAddress,
      hostname: listener.hostname,
      port: listener.port,
      certificateFile: managedCert,
      certificateKeyFile: managedKey,
    });
    assert.deepEqual(readFileSync(managedCert), readFileSync(managed.certificateFile));
    assert.deepEqual(readFileSync(managedKey), readFileSync(managed.certificateKeyFile));
    assert.equal(managed.config().url, "http://127.0.0.1:1");

    const keycloak = managed.keycloakLaunches().at(-1)!;
    assert.deepEqual(keycloak.args, [
      "start",
      "--http-enabled=true",
      `--hostname=https://center.example.test:${port}`,
      "--import-realm",
      "--health-enabled=true",
    ]);
    assert.equal(keycloak.env.KC_HTTP_HOST, "127.0.0.1");
    assert.equal(keycloak.env.KC_HTTP_MANAGEMENT_HOST, "127.0.0.1");
    assert.equal(keycloak.env.KC_HTTPS_CERTIFICATE_FILE, managedCert);
    assert.equal(keycloak.env.KC_HTTPS_CERTIFICATE_KEY_FILE, managedKey);
    assert.deepEqual(managed.postgresLaunches()[0]!.args.slice(2), ["-h", "127.0.0.1", "-p", "2"]);

    // The listen address passes connections through to Keycloak's loopback HTTPS port untouched.
    const keycloakHttps = createServer((socket) => socket.on("data", (chunk) => socket.end(`tls:${chunk}`)));
    await new Promise<void>((resolve) =>
      keycloakHttps.listen(Number(keycloak.env.KC_HTTPS_PORT), "127.0.0.1", resolve),
    );
    assert.equal(await exchange(port, "hello"), "tls:hello");
    keycloakHttps.close();

    // The version an administrator read is what their change is made against: of two, one takes effect.
    const stale = await managed.service.run({ operation: "listener-set", expectedVersion: loopbackVersion });
    assert.deepEqual(
      { ok: stale.ok, code: stale.code, currentVersion: stale.currentVersion },
      { ok: false, code: "version_conflict", currentVersion: set.version },
    );
    const rivals = await Promise.all(
      [await availablePort(), await availablePort()].map((rival) =>
        managed.service.run({
          operation: "listener-set",
          ...listener,
          port: rival,
          expectedVersion: String(set.version),
        }),
      ),
    );
    assert.deepEqual(
      rivals.map((rival) => rival.ok),
      [true, false],
    );
    await assert.rejects(managed.service.run({ operation: "listener-set", ...listener }), {
      code: "rbac_listener_invalid",
    });

    // Setting no listener returns to loopback HTTP only.
    const listening = Number(managed.config().listener.port);
    assert.equal(
      (await managed.service.run({ operation: "listener-set", expectedVersion: await managed.version() })).ok,
      true,
    );
    assert.deepEqual(managed.keycloakLaunches().at(-1)!.args, keycloakArgsWithoutListener);
    assert.equal("listener" in managed.config(), false);
    assert.equal(await managed.version(), loopbackVersion);
    assert.equal(await exchange(listening, "hello"), "refused");
  } finally {
    await managed.close();
  }
});

test("the self-signed certificate mode generates a private listener certificate without returning its key", async () => {
  const managed = managedFixture();
  try {
    const result = await managed.service.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      hostname: "center.example.test",
      listenAddress: "127.0.0.1",
      port: await availablePort(),
      expectedVersion: await managed.version(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.certificateMode, "self-signed");
    assert.equal("certificateKeyFile" in ((result.listener ?? {}) as object), false);
    const config = managed.config();
    assert.equal(config.certificateMode, "self-signed");
    assert.equal(typeof config.listener.certificateKeyFile, "string");
    assert.equal((statSync(config.listener.certificateKeyFile).mode & 0o077) === 0, true);
    assert.doesNotThrow(() =>
      validateCertificateNames(readFileSync(config.listener.certificateFile), ["127.0.0.1", "center.example.test"]),
    );
    // The daemon-side pair read for TLS surfaces without their own certificate: same files the
    // listener was configured with, null once the listener is removed again.
    const pair = managed.service.loginListenerCertificate();
    assert.equal(pair?.certificateFile, config.listener.certificateFile);
    assert.equal(pair?.certificateKeyFile, config.listener.certificateKeyFile);
    assert.equal(
      (
        await managed.service.run({
          operation: "listener-set",
          expectedVersion: await managed.version(),
        })
      ).ok,
      true,
    );
    assert.equal(managed.service.loginListenerCertificate(), null);
  } finally {
    await managed.close();
  }
});

test("self-signed listener defaults its hostname when the UI has no existing listener", async () => {
  const managed = managedFixture();
  try {
    const result = await managed.service.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      port: await availablePort(),
      expectedVersion: await managed.version(),
    });
    assert.equal(result.ok, true);
    const config = managed.config();
    assert.equal(config.listener.hostname, config.listener.address);
    assert.doesNotThrow(() =>
      validateCertificateNames(readFileSync(config.listener.certificateFile), [
        config.listener.address,
        config.listener.hostname,
      ]),
    );
  } finally {
    await managed.close();
  }
});

test("self-signed listener input validates hostname and port before generating a certificate", async () => {
  const managed = managedFixture();
  try {
    for (const input of [
      { hostname: "center.example.test/path", port: 8443 },
      { hostname: "center.example.test", port: 0 },
      { hostname: "center.example.test", port: 70_000 },
    ]) {
      await assert.rejects(
        managed.service.run({
          operation: "listener-set",
          certificateMode: "self-signed",
          hostname: input.hostname,
          listenAddress: "127.0.0.1",
          port: input.port,
          expectedVersion: await managed.version(),
        }),
        { code: "rbac_listener_invalid" },
      );
    }
    assert.equal(existsSync(path.join(managed.root, "rbac", "listener")), false);
  } finally {
    await managed.close();
  }
});

test("a listener hostname is normalized to the lower-case form Keycloak uses as its issuer", async () => {
  const managed = managedFixture();
  try {
    const set = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "Center.Example.Test",
      port: await availablePort(),
      certificateFile: managed.certificateFile,
      certificateKeyFile: managed.certificateKeyFile,
      expectedVersion: await managed.version(),
    });
    assert.equal((set.listener as { hostname?: unknown }).hostname, "center.example.test");
    assert.equal(managed.config().listener.hostname, "center.example.test");
    assert.equal(
      managed
        .keycloakLaunches()
        .at(-1)
        ?.args.find((argument) => argument.startsWith("--hostname=")),
      `--hostname=https://center.example.test:${managed.config().listener.port}`,
    );
  } finally {
    await managed.close();
  }
});

test("self-signed certificates are reused while current and replaced when the hostname changes", async () => {
  const managed = managedFixture();
  try {
    const first = await managed.service.run({
        operation: "listener-set",
        certificateMode: "self-signed",
        hostname: "center-a.example.test",
        listenAddress: "127.0.0.1",
        port: await availablePort(),
        expectedVersion: await managed.version(),
      }),
      certificateFile = managed.config().listener.certificateFile,
      firstPem = readFileSync(certificateFile),
      reused = await managed.service.run({
        operation: "listener-set",
        certificateMode: "self-signed",
        hostname: "center-a.example.test",
        listenAddress: "127.0.0.1",
        port: await availablePort(),
        expectedVersion: String(first.version),
      });
    assert.equal(path.basename(path.dirname(certificateFile)).startsWith("self-signed-"), true);
    assert.equal(path.basename(certificateFile), "listener.pem");
    assert.equal(managed.config().listener.certificateFile, certificateFile);
    assert.deepEqual(readFileSync(certificateFile), firstPem);

    const replaced = await managed.service.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      hostname: "center-b.example.test",
      listenAddress: "127.0.0.1",
      port: await availablePort(),
      expectedVersion: String(reused.version),
    });
    const replacedCertificateFile = managed.config().listener.certificateFile;
    assert.notEqual(replacedCertificateFile, certificateFile);
    assert.equal(path.basename(path.dirname(replacedCertificateFile)).startsWith("self-signed-"), true);
    assert.equal(existsSync(certificateFile), false);
    const replacedPem = readFileSync(replacedCertificateFile);
    assert.notDeepEqual(replacedPem, firstPem);
    assert.doesNotThrow(() => validateCertificateNames(replacedPem, ["127.0.0.1", "center-b.example.test"]));
    assert.equal(replaced.certificateMode, "self-signed");
  } finally {
    await managed.close();
  }
});

test("switching from self-signed to an uploaded certificate removes generated material", async () => {
  const managed = managedFixture();
  try {
    const selfSigned = await managed.service.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      hostname: "center.example.test",
      listenAddress: "127.0.0.1",
      port: await availablePort(),
      expectedVersion: await managed.version(),
    });
    const generated = managed.config().listener as { certificateFile: string; certificateKeyFile: string };
    assert.equal(path.basename(path.dirname(generated.certificateFile)).startsWith("self-signed-"), true);
    assert.equal(existsSync(generated.certificateFile), true);
    assert.equal(existsSync(generated.certificateKeyFile), true);

    await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: managed.certificateFile,
      certificateKeyFile: managed.certificateKeyFile,
      expectedVersion: String(selfSigned.version),
    });
    assert.equal(existsSync(generated.certificateFile), false);
    assert.equal(existsSync(generated.certificateKeyFile), false);
    assert.equal(existsSync(path.dirname(generated.certificateFile)), false);
  } finally {
    await managed.close();
  }
});

test("a private key others can read is refused when the listener is set and when Keycloak starts", async () => {
  const managed = managedFixture(),
    listener = {
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: managed.certificateFile,
      certificateKeyFile: managed.certificateKeyFile,
    },
    before = managed.configText();
  try {
    chmodSync(managed.certificateKeyFile, 0o644);
    await assert.rejects(
      managed.service.run({ operation: "listener-set", ...listener, expectedVersion: await managed.version() }),
      (error: { code?: string; message: string }) =>
        error.code === "rbac_listener_key_exposed" &&
        !error.message.includes(managed.certificateKeyFile) &&
        /owner.*chmod 600/u.test(error.message),
    );
    assert.equal(managed.configText(), before);
    assert.deepEqual(managed.keycloakLaunches(), []);
    for (const incomplete of [
      { ...listener, hostname: undefined },
      { ...listener, listenAddress: "center" },
    ])
      await assert.rejects(
        managed.service.run({ operation: "listener-set", ...incomplete, expectedVersion: await managed.version() }),
        { code: "rbac_listener_invalid" },
      );

    chmodSync(managed.certificateKeyFile, 0o600);
    await managed.service.run({ operation: "listener-set", ...listener, expectedVersion: await managed.version() });
    await managed.service.stop();
    chmodSync(managed.certificateKeyFile, 0o640);
    await managed.service.start();
    await managed.service.stop();
    const managedKey = managed.config().listener.certificateKeyFile;
    chmodSync(managedKey, 0o640);
    const launched = managed.keycloakLaunches().length;
    await assert.rejects(managed.service.run({ operation: "start" }), { code: "rbac_listener_key_exposed" });
    assert.equal(managed.keycloakLaunches().length, launched);
  } finally {
    await managed.close();
  }
});

test("a listener Keycloak cannot start under is not kept", async () => {
  const managed = managedFixture((env) => env.KC_HTTPS_PORT === undefined),
    before = managed.configText();
  try {
    await managed.service.start();
    await assert.rejects(
      managed.service.run({
        operation: "listener-set",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: managed.certificateFile,
        certificateKeyFile: managed.certificateKeyFile,
        expectedVersion: await managed.version(),
      }),
      { code: "rbac_process_failed" },
    );
    assert.equal(managed.configText(), before);
    assert.deepEqual(managed.keycloakLaunches().at(-1)!.args, keycloakArgsWithoutListener);
  } finally {
    await managed.close();
  }
});

test("a failed listener replacement restores the previous managed certificate and key bytes", async () => {
  const managed = managedFixture(),
    portA = await availablePort(),
    externalDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-rollback-cert-")),
    { certFile: certB, keyFile: keyB } = generateTestCertificate(externalDir, "b.example.test", "b");
  try {
    const first = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: portA,
      certificateFile: managed.certificateFile,
      certificateKeyFile: managed.certificateKeyFile,
      expectedVersion: await managed.version(),
    });
    assert.equal(first.ok, true);
    const managedCert = managed.config().listener.certificateFile,
      managedKey = managed.config().listener.certificateKeyFile,
      originalCertBytes = readFileSync(managedCert),
      originalKeyBytes = readFileSync(managedKey),
      beforeConfig = managed.configText();

    // Force the next Keycloak launch attempt to fail after listener ingestion.
    const occupied = createServer();
    const portB = await availablePort();
    await new Promise<void>((resolve) => occupied.listen(portB, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        managed.service.run({
          operation: "listener-set",
          certificateMode: "domain",
          listenAddress: "127.0.0.1",
          hostname: "b.example.test",
          port: portB,
          certificateFile: certB,
          certificateKeyFile: keyB,
          expectedVersion: String(first.version),
        }),
        { code: "rbac_listener_unavailable" },
      );
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    assert.equal(managed.configText(), beforeConfig);
    assert.deepEqual(readFileSync(managedCert), originalCertBytes);
    assert.deepEqual(readFileSync(managedKey), originalKeyBytes);
    const uploadedDirs = readdirSync(path.join(managed.root, "rbac", "listener")).filter((name) =>
      name.startsWith("uploaded-"),
    );
    assert.equal(uploadedDirs.length, 1);
  } finally {
    removeTempRepository(externalDir);
    await managed.close();
  }
});

/** Artifacts and a PostgreSQL data directory already present, so only the configuration path runs. */
function installedManagedRoot(root: string): string {
  const rbac = path.join(root, "rbac");
  for (const artifact of artifactManifest("darwin-arm64")) {
    const destination = path.join(rbac, "runtime", artifact.name);
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, ".installed"), `${artifact.url}\n${"0".repeat(64)}\n`, { mode: 0o600 });
  }
  const data = path.join(rbac, "data", "postgres");
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, "PG_VERSION"), "18\n");
  return rbac;
}

function fakePostgresBin(rbac: string, name: string, body: string): string {
  const file = path.join(rbac, "runtime", "postgres", "bin", name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
  // writeFileSync keeps the mode of an existing file; the fixture pre-creates "postgres".
  chmodSync(file, 0o755);
  return file;
}

test("managed bootstrap keeps Keycloak on loopback until a listener is explicitly set", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-default-listener-"));
  selectIdentityMode(root, "managed");
  try {
    const rbac = installedManagedRoot(root),
      service = createIdentityManagement(root, { platform: "darwin", arch: "arm64" });
    // The data directory is present, so install reaches the config write; start then refuses because
    // the postgres binary is absent. The configuration written before that is what this test reads.
    await assert.rejects(service.run({ operation: "bootstrap" }), { code: "rbac_not_installed" });
    const config = JSON.parse(readFileSync(path.join(rbac, "config.json"), "utf8"));
    assert.equal("listener" in config, false);
    assert.equal(existsSync(path.join(rbac, "listener", "self-signed.pem")), false);
    assert.equal((await service.run({ operation: "listener" })).listener, null);
  } finally {
    removeTempRepository(root);
  }
});

test("managed bootstrap keys PostgreSQL with a daemon-generated scram password", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-postgres-password-"));
  selectIdentityMode(root, "managed");
  try {
    const rbac = path.join(root, "rbac"),
      data = path.join(rbac, "data", "postgres"),
      record = path.join(root, "initdb-args.txt");
    for (const artifact of artifactManifest("darwin-arm64")) {
      const destination = path.join(rbac, "runtime", artifact.name);
      mkdirSync(destination, { recursive: true });
      writeFileSync(path.join(destination, ".installed"), `${artifact.url}\n${"0".repeat(64)}\n`, { mode: 0o600 });
    }
    fakePostgresBin(
      rbac,
      "initdb",
      `printf '%s\\n' "$@" > '${record}'\nprintf '18\\n' > '${path.join(data, "PG_VERSION")}'\n`,
    );
    const service = createIdentityManagement(root, { platform: "darwin", arch: "arm64" });
    await assert.rejects(service.run({ operation: "bootstrap" }), { code: "rbac_not_installed" });
    const args = readFileSync(record, "utf8").split("\n").filter(Boolean),
      passwordFile = path.join(rbac, "postgres-password"),
      password = readFileSync(passwordFile, "utf8");
    assert.equal(args.includes("--auth=trust"), false);
    assert.equal(args.includes("--auth=scram-sha-256"), true);
    assert.equal(args.includes(`--pwfile=${passwordFile}`), true);
    assert.match(password, /^[A-Za-z0-9_-]{32}$/u);
    assert.equal(statSync(passwordFile).mode & 0o077, 0);
  } finally {
    removeTempRepository(root);
  }
});

test("managed Keycloak connects to PostgreSQL with the generated password", async () => {
  const managed = managedFixture();
  try {
    await managed.service.start();
    const passwordFile = path.join(path.dirname(managed.certificateFile), "rbac", "postgres-password");
    assert.equal(existsSync(passwordFile), true);
    const password = readFileSync(passwordFile, "utf8"),
      [keycloak] = managed.keycloakLaunches();
    assert.notEqual(password, "");
    assert.equal(statSync(passwordFile).mode & 0o077, 0);
    assert.equal(keycloak!.env.KC_DB_PASSWORD, password);
  } finally {
    await managed.close();
  }
});

/** Non-comment pg_hba.conf lines; comments in the stock file also mention "trust". */
const activeHbaLines = (hba: string) =>
  readFileSync(hba, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .map((line) => line.trim());

const trustHbaLines = [
  "local all all trust",
  "host all all 127.0.0.1/32 trust",
  "host all all ::1/128 trust",
  "host replication all 127.0.0.1/32 trust",
  "",
].join("\n");

test("a legacy trust PostgreSQL data directory is moved to scram with the bundled postgres, no psql", async () => {
  const managed = managedFixture(),
    rbac = path.join(path.dirname(managed.certificateFile), "rbac"),
    data = path.join(rbac, "data", "postgres"),
    hba = path.join(data, "pg_hba.conf"),
    argsRecord = path.join(rbac, "single-user-args.txt"),
    sqlRecord = path.join(rbac, "single-user.sql"),
    psql = path.join(rbac, "runtime", "postgres", "bin", "psql");
  try {
    mkdirSync(data, { recursive: true });
    writeFileSync(hba, trustHbaLines);
    fakePostgresBin(
      rbac,
      "postgres",
      `printf '%s\\n' "$@" > '${argsRecord}'\ncat > '${sqlRecord}'\nprintf '%s\\n' 'harness-postgres-password-applied'\n`,
    );
    await managed.service.start();
    const hardened = readFileSync(hba, "utf8"),
      sql = readFileSync(sqlRecord, "utf8"),
      args = readFileSync(argsRecord, "utf8").split("\n").filter(Boolean),
      password = readFileSync(path.join(rbac, "postgres-password"), "utf8");
    assert.equal(existsSync(psql), false);
    assert.deepEqual(args, ["--single", "-D", data, "postgres"]);
    assert.equal(
      activeHbaLines(hba).some((line) => line.split(/\s+/u).at(-1) === "trust"),
      false,
    );
    assert.equal(hardened.match(/scram-sha-256/gu)?.length, 4);
    assert.match(sql, /^ALTER ROLE postgres WITH PASSWORD '/u);
    assert.equal(sql.includes(password), true);
    assert.match(sql, /FROM pg_authid WHERE rolname = 'postgres' AND rolpassword LIKE 'SCRAM-SHA-256\$%'/u);
    // Single-user mode is not a server start: Keycloak waits on the one normal PostgreSQL launch.
    assert.equal(managed.postgresLaunches().length, 1);
    assert.equal(managed.keycloakLaunches().length, 1);
  } finally {
    await managed.close();
  }
});

test("a failed single-user password migration leaves trust authentication and reports why", async () => {
  const managed = managedFixture(),
    rbac = path.join(path.dirname(managed.certificateFile), "rbac"),
    data = path.join(rbac, "data", "postgres"),
    hba = path.join(data, "pg_hba.conf"),
    sqlRecord = path.join(rbac, "single-user.sql");
  try {
    mkdirSync(data, { recursive: true });
    writeFileSync(hba, trustHbaLines);
    // Single-user mode reports SQL errors and still exits 0; the service must not trust that exit.
    fakePostgresBin(
      rbac,
      "postgres",
      `cat > '${sqlRecord}'\nprintf '%s\\n' 'ERROR: could not set the postgres password' >&2\n`,
    );
    await assert.rejects(managed.service.start(), (error: { code?: string; message: string }) => {
      assert.equal(error.code, "rbac_postgres_password_failed");
      const password = readFileSync(path.join(rbac, "postgres-password"), "utf8");
      // The statement (and the password in it) must not travel into the lifecycle error.
      assert.equal(error.message.includes(password), false);
      assert.equal(error.message.includes("could not set the postgres password"), false);
      return true;
    });
    assert.equal(
      activeHbaLines(hba).every((line) => line.split(/\s+/u).at(-1) === "trust"),
      true,
    );
    assert.equal(readFileSync(sqlRecord, "utf8").includes("ALTER ROLE postgres WITH PASSWORD"), true);
    assert.deepEqual(managed.postgresLaunches(), []);
    assert.deepEqual(managed.keycloakLaunches(), []);
  } finally {
    await managed.close();
  }
});

test("uploaded listener certificates survive deletion of the external source directory and clean up on mode switch", async () => {
  const managed = managedFixture(),
    externalDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-external-cert-")),
    externalCert = path.join(externalDir, "ext.crt"),
    externalKey = path.join(externalDir, "ext.key");
  try {
    writeFileSync(externalCert, readFileSync(managed.certificateFile));
    writeFileSync(externalKey, readFileSync(managed.certificateKeyFile), { mode: 0o600 });
    chmodSync(externalKey, 0o600);
    const set = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: externalCert,
      certificateKeyFile: externalKey,
      expectedVersion: await managed.version(),
    });
    assert.equal(set.ok, true);
    const installedListener = managed.config().listener;
    assertManagedUploadedPair(managed.root, installedListener);
    const managedCert = installedListener.certificateFile,
      managedKey = installedListener.certificateKeyFile;
    // Deleting the external source directory must not affect subsequent stop/start cycles.
    removeTempRepository(externalDir);
    await managed.service.stop();
    await managed.service.start();
    assert.equal(managed.keycloakLaunches().at(-1)!.env.KC_HTTPS_CERTIFICATE_FILE, managedCert);
    assert.equal(managed.keycloakLaunches().at(-1)!.env.KC_HTTPS_CERTIFICATE_KEY_FILE, managedKey);

    // Switching to self-signed removes the no-longer-used uploaded listener files.
    const selfSigned = await managed.service.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      expectedVersion: await managed.version(),
    });
    assert.equal(selfSigned.ok, true);
    assert.equal(existsSync(managedCert), false);
    assert.equal(existsSync(managedKey), false);

    // Omitting --certificate-mode while uploading from self-signed or loopback must not delete the newly uploaded pair (RBAC-01).
    const uploadedWithoutMode = await managed.service.run({
      operation: "listener-set",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: managed.certificateFile,
      certificateKeyFile: managed.certificateKeyFile,
      expectedVersion: String(selfSigned.version),
    });
    assert.equal(uploadedWithoutMode.ok, true);
    assert.equal(uploadedWithoutMode.certificateMode, "domain");
    assertManagedUploadedPair(managed.root, managed.config().listener);
    await managed.service.stop();
    await managed.service.start();

    // Returning to loopback also cleans up the uploaded listener files.
    const loopback = await managed.service.run({
      operation: "listener-set",
      expectedVersion: String(uploadedWithoutMode.version),
    });
    assert.equal(loopback.ok, true);
    assert.equal("listener" in managed.config(), false);
    assert.equal(
      readdirSync(path.join(managed.root, "rbac", "listener")).some((entry) => entry.startsWith("uploaded-")),
      false,
    );
  } finally {
    removeTempRepository(externalDir);
    await managed.close();
  }
});

test("legacy external listener config migrates into rbac/listener on start and fails without ingestion if deleted beforehand", async () => {
  const managed = managedFixture(),
    unmigrated = managedFixture(),
    externalDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-legacy-cert-")),
    externalCert = path.join(externalDir, "legacy.crt"),
    externalKey = path.join(externalDir, "legacy.key"),
    unmigratedDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-legacy-missing-")),
    unmigratedCert = path.join(unmigratedDir, "legacy.crt"),
    unmigratedKey = path.join(unmigratedDir, "legacy.key"),
    configFile = path.join(managed.root, "rbac", "config.json"),
    unmigratedConfigFile = path.join(unmigrated.root, "rbac", "config.json");
  try {
    writeFileSync(externalCert, readFileSync(managed.certificateFile));
    writeFileSync(externalKey, readFileSync(managed.certificateKeyFile), { mode: 0o644 });
    chmodSync(externalKey, 0o644);
    const port = await availablePort();
    writeFileSync(
      configFile,
      `${JSON.stringify(
        {
          ...managed.config(),
          listener: {
            address: "127.0.0.1",
            hostname: "center.example.test",
            port,
            certificateFile: externalCert,
            certificateKeyFile: externalKey,
          },
        },
        null,
        2,
      )}\n`,
    );

    // Same-variable negative control (RBAC-10): deleting compliant external source BEFORE ingestion fails start().
    writeFileSync(unmigratedCert, readFileSync(unmigrated.certificateFile));
    writeFileSync(unmigratedKey, readFileSync(unmigrated.certificateKeyFile), { mode: 0o600 });
    chmodSync(unmigratedKey, 0o600);
    writeFileSync(
      unmigratedConfigFile,
      `${JSON.stringify(
        {
          ...unmigrated.config(),
          listener: {
            address: "127.0.0.1",
            hostname: "center.example.test",
            port: await availablePort(),
            certificateFile: unmigratedCert,
            certificateKeyFile: unmigratedKey,
          },
        },
        null,
        2,
      )}\n`,
    );
    removeTempRepository(unmigratedDir);
    await assert.rejects(unmigrated.service.start(), { code: "rbac_listener_key_exposed" });

    // Exposed legacy private keys must be rejected before copying into managed storage.
    await assert.rejects(managed.service.start(), { code: "rbac_listener_key_exposed" });
    assert.equal(existsSync(path.join(managed.root, "rbac", "listener")), false);

    // Once compliant, start() migrates the files into <userRoot>/rbac/listener/uploaded-... and updates config.json.
    chmodSync(externalKey, 0o600);
    await managed.service.start();
    assertManagedUploadedPair(managed.root, managed.config().listener);
    const managedCert = managed.config().listener.certificateFile;

    removeTempRepository(externalDir);
    await managed.service.stop();
    await managed.service.start();
    assert.equal(managed.keycloakLaunches().at(-1)!.env.KC_HTTPS_CERTIFICATE_FILE, managedCert);
  } finally {
    removeTempRepository(externalDir);
    removeTempRepository(unmigratedDir);
    await managed.close();
    await unmigrated.close();
  }
});

test("legacy symlinks inside rbac/listener pointing outside are migrated into real managed files (RBAC-06)", async () => {
  const managed = managedFixture(),
    externalDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-symlink-cert-")),
    { certFile: externalCert, keyFile: externalKey } = generateTestCertificate(externalDir, "center.example.test"),
    listenerDir = path.join(managed.root, "rbac", "listener"),
    linkCert = path.join(listenerDir, "link.pem"),
    linkKey = path.join(listenerDir, "link.key"),
    configFile = path.join(managed.root, "rbac", "config.json");
  try {
    mkdirSync(listenerDir, { recursive: true, mode: 0o700 });
    symlinkSync(externalCert, linkCert);
    symlinkSync(externalKey, linkKey);
    writeFileSync(
      configFile,
      `${JSON.stringify(
        {
          ...managed.config(),
          listener: {
            address: "127.0.0.1",
            hostname: "center.example.test",
            port: await availablePort(),
            certificateFile: linkCert,
            certificateKeyFile: linkKey,
          },
        },
        null,
        2,
      )}\n`,
    );
    await managed.service.start();
    assertManagedUploadedPair(managed.root, managed.config().listener);
    assert.equal(existsSync(linkCert), false);
    assert.equal(existsSync(linkKey), false);
    removeTempRepository(externalDir);
    await managed.service.stop();
    await managed.service.start();
    assert.equal(
      managed.keycloakLaunches().at(-1)!.env.KC_HTTPS_CERTIFICATE_FILE,
      managed.config().listener.certificateFile,
    );
  } finally {
    removeTempRepository(externalDir);
    await managed.close();
  }
});

test("uploaded listener validation rejects mismatched keys and malformed PEM chains before disk writes (RBAC-03)", async () => {
  const managed = managedFixture(),
    externalDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-invalid-pair-")),
    { certFile: otherCert, keyFile: otherKey } = generateTestCertificate(externalDir, "center.example.test", "other"),
    corruptChainCert = path.join(externalDir, "corrupt-chain.pem"),
    corruptKey = path.join(externalDir, "corrupt.key");
  try {
    writeFileSync(
      corruptChainCert,
      `${readFileSync(managed.certificateFile, "utf8")}\n-----BEGIN CERTIFICATE-----\nINVALID\n-----END CERTIFICATE-----\n`,
    );
    writeFileSync(corruptKey, "not-a-private-key\n", { mode: 0o600 });
    chmodSync(corruptKey, 0o600);
    for (const bad of [
      { certificateFile: managed.certificateFile, certificateKeyFile: otherKey },
      { certificateFile: otherCert, certificateKeyFile: managed.certificateKeyFile },
      { certificateFile: corruptChainCert, certificateKeyFile: managed.certificateKeyFile },
      { certificateFile: managed.certificateFile, certificateKeyFile: corruptKey },
    ]) {
      await assert.rejects(
        managed.service.run({
          operation: "listener-set",
          certificateMode: "domain",
          listenAddress: "127.0.0.1",
          hostname: "center.example.test",
          port: await availablePort(),
          ...bad,
          expectedVersion: await managed.version(),
        }),
        { code: "rbac_listener_invalid" },
      );
    }
    assert.equal(existsSync(path.join(managed.root, "rbac", "listener")), false);
  } finally {
    removeTempRepository(externalDir);
    await managed.close();
  }
});

test("same-endpoint rotation advances version, stale versions conflict, and partial write or config commit failures preserve active pair (RBAC-02/04/05)", async () => {
  let failStage: "certificate" | "key" | "config" | undefined;
  const managed = managedFixture(undefined, undefined, "darwin", (stage) => {
      if (stage === failStage) throw new Error(`injected-${stage}-failure`);
    }),
    externalDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-atomic-rotate-")),
    { certFile: certB, keyFile: keyB } = generateTestCertificate(externalDir, "center.example.test", "rotated"),
    { certFile: certC, keyFile: keyC } = generateTestCertificate(externalDir, "center.example.test", "rotated2"),
    port = await availablePort();
  try {
    const first = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port,
      certificateFile: managed.certificateFile,
      certificateKeyFile: managed.certificateKeyFile,
      expectedVersion: await managed.version(),
    });
    const firstCert = managed.config().listener.certificateFile,
      firstKey = managed.config().listener.certificateKeyFile,
      firstCertBytes = readFileSync(firstCert),
      firstKeyBytes = readFileSync(firstKey),
      firstConfigText = managed.configText();

    // RBAC-02: Failure writing the second file (listener.key) or committing config.json preserves the active version.
    for (const stage of ["key", "config"] as const) {
      failStage = stage;
      await assert.rejects(
        managed.service.run({
          operation: "listener-set",
          certificateMode: "domain",
          listenAddress: "127.0.0.1",
          hostname: "center.example.test",
          port,
          certificateFile: certB,
          certificateKeyFile: keyB,
          expectedVersion: String(first.version),
        }),
        new RegExp(`injected-${stage}-failure`, "u"),
      );
      failStage = undefined;
      assert.equal(managed.configText(), firstConfigText);
      assert.deepEqual(readFileSync(firstCert), firstCertBytes);
      assert.deepEqual(readFileSync(firstKey), firstKeyBytes);
      assert.equal(
        readdirSync(path.join(managed.root, "rbac", "listener")).filter((name) => name.startsWith("uploaded-")).length,
        1,
      );
      await managed.service.stop();
      await managed.service.start();
    }

    // RBAC-05: Rotating on the exact same endpoint advances version and rejects the previous version with version_conflict.
    const rotated = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port,
      certificateFile: certB,
      certificateKeyFile: keyB,
      expectedVersion: String(first.version),
    });
    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.version, first.version);
    const conflict = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port,
      certificateFile: certC,
      certificateKeyFile: keyC,
      expectedVersion: String(first.version),
    });
    assert.deepEqual(
      { ok: conflict.ok, code: conflict.code, currentVersion: conflict.currentVersion },
      { ok: false, code: "version_conflict", currentVersion: rotated.version },
    );

    // RBAC-04: Failed listener update never re-enables a previously exposed private key.
    await managed.service.stop();
    const rotatedKey = managed.config().listener.certificateKeyFile;
    chmodSync(rotatedKey, 0o644);
    const occupied = createServer();
    const occupiedPort = await availablePort();
    await new Promise<void>((resolve) => occupied.listen(occupiedPort, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        managed.service.run({
          operation: "listener-set",
          certificateMode: "domain",
          listenAddress: "127.0.0.1",
          hostname: "center.example.test",
          port: occupiedPort,
          certificateFile: certC,
          certificateKeyFile: keyC,
          expectedVersion: String(rotated.version),
        }),
        { code: "rbac_listener_unavailable" },
      );
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    assert.equal(statSync(rotatedKey).mode & 0o777, 0o644);
    await assert.rejects(managed.service.start(), { code: "rbac_listener_key_exposed" });
  } finally {
    removeTempRepository(externalDir);
    await managed.close();
  }
});
