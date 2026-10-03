// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
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
    const service = new ManagedRbacService(root, {
      fetch: async () => {
        throw failure;
      },
    });
    await assert.rejects(service.run({ operation: "health" }), (error) => error === failure);
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

const keycloakArgsWithoutListener = [
  "start",
  "--http-enabled=true",
  "--hostname-strict=false",
  "--import-realm",
  "--health-enabled=true",
];

/** A bootstrapped managed installation whose PostgreSQL and Keycloak launches report ready at once. */
function managedFixture(startsUnder: (env: NodeJS.ProcessEnv) => boolean = () => true) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-listener-")),
    configFile = path.join(root, "rbac", "config.json"),
    certificateFile = path.join(root, "center.crt"),
    certificateKeyFile = path.join(root, "center.key"),
    launches: { name: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  mkdirSync(path.join(root, "rbac", "runtime", "postgres", "bin"), { recursive: true });
  writeFileSync(path.join(root, "rbac", "runtime", "postgres", "bin", "postgres"), "");
  writeFileSync(certificateFile, "certificate");
  writeFileSync(certificateKeyFile, "key", { mode: 0o600 });
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
  const service = new ManagedRbacService(root, {
    fetch: (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch,
    spawn: ((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      const name = path.basename(command),
        child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          kill: () => setImmediate(() => child.emit("exit", 0)),
        });
      launches.push({ name, args, env: options.env });
      setImmediate(() =>
        name === "postgres"
          ? child.stdout.emit("data", "database system is ready to accept connections")
          : startsUnder(options.env)
            ? child.stdout.emit("data", "Keycloak 26 started in 1s")
            : child.emit("exit", 1),
      );
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });
  return {
    service,
    certificateFile,
    certificateKeyFile,
    configText: () => readFileSync(configFile, "utf8"),
    config: () => JSON.parse(readFileSync(configFile, "utf8")),
    keycloakLaunches: () => launches.filter(({ name }) => name === "kc.sh"),
    postgresLaunches: () => launches.filter(({ name }) => name === "postgres"),
    version: async () => String((await service.run({ operation: "listener" })).version),
    close: async () => {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

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
    const stored = { ...listener, address: listener.listenAddress, listenAddress: undefined };
    assert.deepEqual(managed.config().listener, JSON.parse(JSON.stringify(stored)));
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
    assert.equal(keycloak.env.KC_HTTPS_CERTIFICATE_FILE, managed.certificateFile);
    assert.equal(keycloak.env.KC_HTTPS_CERTIFICATE_KEY_FILE, managed.certificateKeyFile);
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
        error.code === "rbac_listener_key_exposed" && /mode 0644/u.test(error.message),
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
