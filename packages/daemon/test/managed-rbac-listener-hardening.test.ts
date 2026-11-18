// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
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
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  managedListenerProblem,
  readRegularListenerCertificateIfPresent,
} from "@harness-anything/authorization-keycloak";
import { managedRbacVersions } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import type { ListenerWriteStage } from "../../authorization-keycloak/src/managed-rbac-listener-certificate.ts";
import { createIdentityManagement } from "../src/authorization-provider.ts";
import { validateCertificateNames } from "../src/tls-listener-admission.ts";

interface HardeningFixtureOptions {
  readonly fetch?: typeof fetch;
  readonly onListenerWriteStage?: (stage: ListenerWriteStage) => void;
  readonly recordLifecycle?: (event: Record<string, unknown>) => void;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function reachableIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return "127.0.0.1";
}

function generateCertWithSan(
  dir: string,
  prefix: string,
  cn: string,
  san: string,
): { readonly certFile: string; readonly keyFile: string } {
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
      `subjectAltName=${san}`,
    ],
    { stdio: "ignore" },
  );
  chmodSync(keyFile, 0o600);
  return { certFile, keyFile };
}

function createHardeningFixture(options: HardeningFixtureOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-hardening-")),
    rbac = path.join(root, "rbac"),
    postgres = path.join(rbac, "runtime", "postgres", "bin", "postgres"),
    keycloak = path.join(rbac, "runtime", "keycloak", "bin", "kc.sh"),
    configFile = path.join(rbac, "config.json"),
    launches: Array<{
      readonly name: string;
      readonly args: readonly string[];
      readonly env: NodeJS.ProcessEnv;
      readonly killed: () => boolean;
    }> = [],
    lifecycleEvents: Array<Record<string, unknown>> = [];
  mkdirSync(path.dirname(postgres), { recursive: true });
  mkdirSync(path.dirname(keycloak), { recursive: true });
  writeFileSync(postgres, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(keycloak, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
  let activeFetch = options.fetch ?? ((() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch);
  let activeStageHook = options.onListenerWriteStage;
  const service = createIdentityManagement(root, {
    platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    arch: process.arch === "x64" ? "x64" : "arm64",
    fetch: ((input, init) => activeFetch(input, init)) as typeof fetch,
    onListenerWriteStage: (stage) => activeStageHook?.(stage),
    recordLifecycle: (event) => {
      lifecycleEvents.push(event);
      options.recordLifecycle?.(event);
    },
    spawn: ((command: string, args: readonly string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
      let wasKilled = false;
      const name = path.basename(command),
        child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          kill: () => {
            wasKilled = true;
            setImmediate(() => child.emit("exit", 0));
            return true;
          },
        });
      launches.push({ name, args, env: spawnOptions.env, killed: () => wasKilled });
      setImmediate(() =>
        child.stdout.emit(
          "data",
          name.startsWith("postgres") ? "database system is ready to accept connections" : "Keycloak 26 started in 1s",
        ),
      );
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });
  return {
    root,
    rbac,
    configFile,
    service,
    lifecycleEvents,
    setFetch: (next: typeof fetch) => {
      activeFetch = next;
    },
    setStageHook: (next: ((stage: ListenerWriteStage) => void) | undefined) => {
      activeStageHook = next;
    },
    configText: () => readFileSync(configFile, "utf8"),
    config: () => JSON.parse(readFileSync(configFile, "utf8")),
    writeConfig: (next: Record<string, unknown>) => writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`),
    keycloakLaunches: () => launches.filter(({ name }) => name === "kc.sh"),
    version: async () => String((await service.run({ operation: "listener" })).version),
    close: async () => {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createOpensslCaWorkspace(baseDir: string) {
  const indexFile = path.join(baseDir, "index.txt"),
    serialFile = path.join(baseDir, "serial"),
    newCertsDir = path.join(baseDir, "newcerts"),
    configFile = path.join(baseDir, "ca.cnf");
  mkdirSync(newCertsDir, { recursive: true });
  writeFileSync(indexFile, "");
  writeFileSync(serialFile, "1000\n");
  writeFileSync(
    configFile,
    [
      "[ca]",
      "default_ca = CA_default",
      "[CA_default]",
      `database = ${indexFile}`,
      `serial = ${serialFile}`,
      `new_certs_dir = ${newCertsDir}`,
      "default_md = sha256",
      "policy = policy_anything",
      "x509_extensions = v3_leaf",
      "copy_extensions = copy",
      "unique_subject = no",
      "[policy_anything]",
      "commonName = supplied",
      "[v3_root]",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always,issuer",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,keyCertSign,cRLSign",
      "[v3_intermediate]",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always,issuer",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,keyCertSign,cRLSign",
      "[v3_not_ca]",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always,issuer",
      "basicConstraints = critical,CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "[v3_leaf]",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always,issuer",
      "basicConstraints = CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = DNS:center.example.test,IP:127.0.0.1",
      "[v3_leaf_client]",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always,issuer",
      "basicConstraints = CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage = clientAuth",
      "subjectAltName = DNS:center.example.test,IP:127.0.0.1",
    ].join("\n"),
  );

  const issueSelfSigned = (name: string, extensions: string, startdate: string, enddate: string) => {
    const keyFile = path.join(baseDir, `${name}.key`),
      csrFile = path.join(baseDir, `${name}.csr`),
      certFile = path.join(baseDir, `${name}.crt`);
    execFileSync(
      "openssl",
      ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", csrFile, "-subj", `/CN=${name}`],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "ca",
        "-batch",
        "-selfsign",
        "-config",
        configFile,
        "-keyfile",
        keyFile,
        "-extensions",
        extensions,
        "-startdate",
        startdate,
        "-enddate",
        enddate,
        "-notext",
        "-in",
        csrFile,
        "-out",
        certFile,
      ],
      { stdio: "ignore" },
    );
    chmodSync(keyFile, 0o600);
    return { keyFile, certFile, pem: readFileSync(certFile, "utf8") };
  };

  const issueSigned = (
    name: string,
    cn: string,
    issuer: { readonly certFile: string; readonly keyFile: string },
    extensions: string,
    startdate: string,
    enddate: string,
  ) => {
    const keyFile = path.join(baseDir, `${name}.key`),
      csrFile = path.join(baseDir, `${name}.csr`),
      certFile = path.join(baseDir, `${name}.crt`);
    execFileSync(
      "openssl",
      ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", csrFile, "-subj", `/CN=${cn}`],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "ca",
        "-batch",
        "-config",
        configFile,
        "-cert",
        issuer.certFile,
        "-keyfile",
        issuer.keyFile,
        "-extensions",
        extensions,
        "-startdate",
        startdate,
        "-enddate",
        enddate,
        "-notext",
        "-in",
        csrFile,
        "-out",
        certFile,
      ],
      { stdio: "ignore" },
    );
    chmodSync(keyFile, 0o600);
    return { keyFile, certFile, pem: readFileSync(certFile, "utf8") };
  };

  return { issueSelfSigned, issueSigned };
}

test("directory symlinks inside rbac/listener do not delete external targets during rotation or mode switch (RBAC-11)", async () => {
  if (process.platform === "win32") return;
  const managed = createHardeningFixture(),
    externalTarget = mkdtempSync(path.join(tmpdir(), "ha-rbac-ext-dir-")),
    sources = mkdtempSync(path.join(tmpdir(), "ha-rbac-ext-src-"));
  try {
    writeFileSync(path.join(externalTarget, "keep.crt"), "external-cert\n");
    writeFileSync(path.join(externalTarget, "keep.key"), "external-key\n", { mode: 0o600 });
    const pairA = generateCertWithSan(sources, "a", "center.example.test", "DNS:center.example.test,IP:127.0.0.1"),
      pairB = generateCertWithSan(sources, "b", "center.example.test", "DNS:center.example.test,IP:127.0.0.1");

    const listenerDir = path.join(managed.rbac, "listener");
    mkdirSync(listenerDir, { recursive: true, mode: 0o700 });
    symlinkSync(externalTarget, path.join(listenerDir, "uploaded-symlink-trap"), "dir");
    symlinkSync(externalTarget, path.join(listenerDir, "extdir"), "dir");
    symlinkSync(path.join(externalTarget, "keep.crt"), path.join(listenerDir, "file-symlink.pem"));

    const config = managed.config();
    config.listener = {
      address: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: path.join(listenerDir, "extdir", "keep.crt"),
      certificateKeyFile: path.join(listenerDir, "extdir", "keep.key"),
    };
    managed.writeConfig(config);

    const first = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: pairA.certFile,
      certificateKeyFile: pairA.keyFile,
      expectedVersion: await managed.version(),
    });
    assert.equal(first.ok, true);

    const second = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: pairB.certFile,
      certificateKeyFile: pairB.keyFile,
      expectedVersion: String(first.version),
    });
    assert.equal(second.ok, true);

    const loopback = await managed.service.run({
      operation: "listener-set",
      expectedVersion: String(second.version),
    });
    assert.equal(loopback.ok, true);

    assert.equal(readFileSync(path.join(externalTarget, "keep.crt"), "utf8"), "external-cert\n");
    assert.equal(readFileSync(path.join(externalTarget, "keep.key"), "utf8"), "external-key\n");
    assert.equal(lstatSync(path.join(listenerDir, "uploaded-symlink-trap")).isSymbolicLink(), true);
  } finally {
    rmSync(externalTarget, { recursive: true, force: true });
    rmSync(sources, { recursive: true, force: true });
    await managed.close();
  }
});

test("symlinked rbac or rbac/listener roots refuse writes without chmodding or deleting targets (RBAC-11)", async () => {
  if (process.platform === "win32") return;
  const externalListenerTarget = mkdtempSync(path.join(tmpdir(), "ha-rbac-sym-listener-")),
    sources = mkdtempSync(path.join(tmpdir(), "ha-rbac-sym-src-")),
    managed = createHardeningFixture();
  try {
    chmodSync(externalListenerTarget, 0o755);
    writeFileSync(path.join(externalListenerTarget, "victim.pem"), "victim\n");
    const pair = generateCertWithSan(sources, "s", "center.example.test", "DNS:center.example.test,IP:127.0.0.1");

    symlinkSync(externalListenerTarget, path.join(managed.rbac, "listener"), "dir");
    await assert.rejects(
      managed.service.run({
        operation: "listener-set",
        certificateMode: "domain",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: pair.certFile,
        certificateKeyFile: pair.keyFile,
        expectedVersion: await managed.version(),
      }),
      { code: "rbac_listener_invalid" },
    );
    await assert.rejects(
      managed.service.run({
        operation: "listener-set",
        certificateMode: "self-signed",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        expectedVersion: await managed.version(),
      }),
      { code: "rbac_listener_invalid" },
    );
    assert.equal(statSync(externalListenerTarget).mode & 0o777, 0o755);
    assert.equal(readFileSync(path.join(externalListenerTarget, "victim.pem"), "utf8"), "victim\n");

    const parentWithSymlinkRbac = mkdtempSync(path.join(tmpdir(), "ha-rbac-sym-root-")),
      externalRbacDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-sym-target-"));
    try {
      chmodSync(externalRbacDir, 0o755);
      writeFileSync(path.join(externalRbacDir, "secret.txt"), "keep-me\n");
      writeFileSync(
        path.join(externalRbacDir, "config.json"),
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
      symlinkSync(externalRbacDir, path.join(parentWithSymlinkRbac, "rbac"), "dir");
      const rootSymService = createIdentityManagement(parentWithSymlinkRbac, {
        platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
        arch: process.arch === "x64" ? "x64" : "arm64",
        fetch: (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch,
      });
      const currentVersion = String((await rootSymService.run({ operation: "listener" })).version);
      await assert.rejects(
        rootSymService.run({
          operation: "listener-set",
          certificateMode: "self-signed",
          listenAddress: "127.0.0.1",
          hostname: "center.example.test",
          port: await availablePort(),
          expectedVersion: currentVersion,
        }),
        { code: "rbac_listener_invalid" },
      );
      assert.equal(readFileSync(path.join(externalRbacDir, "secret.txt"), "utf8"), "keep-me\n");
      assert.equal(statSync(externalRbacDir).mode & 0o777, 0o755);
    } finally {
      rmSync(parentWithSymlinkRbac, { recursive: true, force: true });
      rmSync(externalRbacDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(externalListenerTarget, { recursive: true, force: true });
    rmSync(sources, { recursive: true, force: true });
    await managed.close();
  }
});

test("self-signed generation staging rolls back cleanly on key or config failure and handles cleanup failure safely (RBAC-13)", async () => {
  const managed = createHardeningFixture(),
    portA = await availablePort();
  try {
    const first = await managed.service.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      listenAddress: "127.0.0.1",
      hostname: "center-a.example.test",
      port: portA,
      expectedVersion: await managed.version(),
    });
    const configA = managed.config(),
      certAPath = configA.listener.certificateFile as string,
      keyAPath = configA.listener.certificateKeyFile as string,
      certABytes = readFileSync(certAPath),
      keyABytes = readFileSync(keyAPath),
      configAText = managed.configText();

    for (const failStage of ["key", "config"] as const) {
      managed.setStageHook((stage) => {
        if (stage === failStage) throw new Error(`simulated ${failStage} failure`);
      });
      await assert.rejects(
        managed.service.run({
          operation: "listener-set",
          certificateMode: "self-signed",
          listenAddress: "127.0.0.1",
          hostname: "center-b.example.test",
          port: await availablePort(),
          expectedVersion: String(first.version),
        }),
        new RegExp(`simulated ${failStage} failure`, "u"),
      );
      managed.setStageHook(undefined);
      assert.equal(managed.configText(), configAText);
      assert.deepEqual(readFileSync(certAPath), certABytes);
      assert.deepEqual(readFileSync(keyAPath), keyABytes);
      const dirsAfterFail = readdirSync(path.join(managed.rbac, "listener")).filter((entry) =>
        entry.startsWith("self-signed-"),
      );
      assert.deepEqual(dirsAfterFail, [path.basename(path.dirname(certAPath))]);
    }

    await managed.service.stop();
    await managed.service.start();
    assert.equal(managed.keycloakLaunches().at(-1)?.env.KC_HTTPS_CERTIFICATE_FILE, certAPath);

    // Cleanup failure after config commit must NOT roll back or trigger failed Keycloak restart.
    managed.setStageHook((stage) => {
      if (stage === "cleanup") throw new Error("cleanup EPERM");
    });
    const second = await managed.service.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      listenAddress: "127.0.0.1",
      hostname: "center-c.example.test",
      port: await availablePort(),
      expectedVersion: String(first.version),
    });
    managed.setStageHook(undefined);

    assert.equal(second.ok, true);
    assert.match(String(second.cleanupWarning), /cleanup EPERM/u);
    assert.equal(
      managed.lifecycleEvents.some(
        (entry) => entry.event === "rbac_listener_cleanup_failed" && String(entry.error).includes("cleanup EPERM"),
      ),
      true,
    );
    const certCPath = managed.config().listener.certificateFile as string;
    assert.notEqual(certCPath, certAPath);
    assert.equal((await managed.service.run({ operation: "listener" })).version, second.version);
    assert.equal(managed.keycloakLaunches().at(-1)?.env.KC_HTTPS_CERTIFICATE_FILE, certCPath);

    await managed.service.stop();
    await managed.service.start();
    assert.equal(managed.keycloakLaunches().at(-1)?.env.KC_HTTPS_CERTIFICATE_FILE, certCPath);
  } finally {
    await managed.close();
  }
});

test("failed replacement from a broken previous listener kills the newly spawned Keycloak child and drops staged material (RBAC-13)", async () => {
  const managed = createHardeningFixture(),
    sources = mkdtempSync(path.join(tmpdir(), "ha-rbac-broken-prev-"));
  try {
    const pairA = generateCertWithSan(sources, "a", "a.example.test", "DNS:a.example.test,IP:127.0.0.1"),
      pairB = generateCertWithSan(sources, "b", "b.example.test", "DNS:b.example.test,IP:127.0.0.1");

    const installed = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "a.example.test",
      port: await availablePort(),
      certificateFile: pairA.certFile,
      certificateKeyFile: pairA.keyFile,
      expectedVersion: await managed.version(),
    });
    const prevKey = managed.config().listener.certificateKeyFile as string;
    await managed.service.stop();
    rmSync(prevKey, { force: true });
    const brokenConfigText = managed.configText();

    // Let Keycloak spawn & open passthrough on portB, then fail readiness immediately without transport retry.
    managed.setFetch(() => Promise.reject(new Error("simulated readiness boom")));
    const portB = await availablePort(),
      launchesBefore = managed.keycloakLaunches().length;

    await assert.rejects(
      managed.service.run({
        operation: "listener-set",
        certificateMode: "domain",
        listenAddress: "127.0.0.1",
        hostname: "b.example.test",
        port: portB,
        certificateFile: pairB.certFile,
        certificateKeyFile: pairB.keyFile,
        expectedVersion: String(installed.version),
      }),
      /simulated readiness boom/u,
    );

    const newLaunches = managed.keycloakLaunches().slice(launchesBefore);
    assert.equal(newLaunches.length, 1);
    assert.equal(newLaunches[0]!.killed(), true);
    assert.equal(managed.configText(), brokenConfigText);
    const remainingDirs = readdirSync(path.join(managed.rbac, "listener")).filter((entry) =>
      entry.startsWith("uploaded-"),
    );
    assert.equal(remainingDirs.length, 1);

    // Passthrough on portB must have closed synchronously inside stopChild("keycloak").
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(portB, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    rmSync(sources, { recursive: true, force: true });
    await managed.close();
  }
});

test("omitting certificateMode and listenAddress binds firstReachableAddress while explicit domain mode binds 0.0.0.0 (RBAC-15)", async () => {
  const managed = createHardeningFixture(),
    sources = mkdtempSync(path.join(tmpdir(), "ha-rbac-bind-")),
    expectedReachable = reachableIpv4();
  try {
    const dnsOnly = generateCertWithSan(sources, "dnsonly", "center.example.test", "DNS:center.example.test"),
      reachableSan = generateCertWithSan(
        sources,
        "reachable",
        "center.example.test",
        `DNS:center.example.test,IP:${expectedReachable}`,
      ),
      loopbackSan = generateCertWithSan(
        sources,
        "loopback",
        "center.example.test",
        "DNS:center.example.test,IP:127.0.0.1",
      );

    // Without certificateMode or listenAddress: binds firstReachableAddress() and validates its SAN.
    await assert.rejects(
      managed.service.run({
        operation: "listener-set",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: dnsOnly.certFile,
        certificateKeyFile: dnsOnly.keyFile,
        expectedVersion: await managed.version(),
      }),
      { code: "cert_san_mismatch" },
    );

    // Explicit certificateMode: "domain" without listenAddress binds 0.0.0.0 and omits wildcard SAN checks.
    const explicitDomain = await managed.service.run({
      operation: "listener-set",
      certificateMode: "domain",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: dnsOnly.certFile,
      certificateKeyFile: dnsOnly.keyFile,
      expectedVersion: await managed.version(),
    });
    assert.equal(explicitDomain.ok, true);
    assert.equal(managed.config().listener.address, "0.0.0.0");

    // Omitting both with a cert carrying expectedReachable SAN binds expectedReachable directly.
    const implicitReachable = await managed.service.run({
      operation: "listener-set",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: reachableSan.certFile,
      certificateKeyFile: reachableSan.keyFile,
      expectedVersion: String(explicitDomain.version),
    });
    assert.equal(implicitReachable.ok, true);
    assert.equal(managed.config().listener.address, expectedReachable);

    // Explicit listenAddress overrides firstReachableAddress().
    const explicitListen = await managed.service.run({
      operation: "listener-set",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: loopbackSan.certFile,
      certificateKeyFile: loopbackSan.keyFile,
      expectedVersion: String(implicitReachable.version),
    });
    assert.equal(explicitListen.ok, true);
    assert.equal(managed.config().listener.address, "127.0.0.1");
  } finally {
    rmSync(sources, { recursive: true, force: true });
    await managed.close();
  }
});

test("uploaded certificate validation enforces chain dates, issuer CA basic constraints, and leaf serverAuth EKU (RBAC-16)", async () => {
  const managed = createHardeningFixture(),
    caDir = mkdtempSync(path.join(tmpdir(), "ha-rbac-ca-"));
  try {
    const ca = createOpensslCaWorkspace(caDir),
      validStart = "20240101000000Z",
      validEnd = "20350101000000Z",
      pastStart = "20200101000000Z",
      pastEnd = "20210101000000Z",
      futureStart = "20340101000000Z",
      futureEnd = "20360101000000Z";

    const validSelfSigned = ca.issueSelfSigned("center.example.test", "v3_leaf", validStart, validEnd),
      rootCa = ca.issueSelfSigned("root-ca", "v3_root", validStart, validEnd),
      intermediateCa = ca.issueSigned("int-ca", "int-ca", rootCa, "v3_intermediate", validStart, validEnd),
      leafFromInt = ca.issueSigned("leaf-int", "center.example.test", intermediateCa, "v3_leaf", validStart, validEnd),
      leafFromRoot = ca.issueSigned("leaf-root", "center.example.test", rootCa, "v3_leaf", validStart, validEnd),
      expiredLeaf = ca.issueSigned("leaf-expired", "center.example.test", rootCa, "v3_leaf", pastStart, pastEnd),
      futureLeaf = ca.issueSigned("leaf-future", "center.example.test", rootCa, "v3_leaf", futureStart, futureEnd),
      expiredInt = ca.issueSigned("int-expired", "int-expired", rootCa, "v3_intermediate", pastStart, pastEnd),
      leafFromExpiredInt = ca.issueSigned(
        "leaf-from-exp-int",
        "center.example.test",
        expiredInt,
        "v3_leaf",
        validStart,
        validEnd,
      ),
      futureRoot = ca.issueSelfSigned("root-future", "v3_root", futureStart, futureEnd),
      leafFromFutureRoot = ca.issueSigned(
        "leaf-from-future-root",
        "center.example.test",
        futureRoot,
        "v3_leaf",
        validStart,
        validEnd,
      ),
      nonCaIssuer = ca.issueSelfSigned("non-ca", "v3_not_ca", validStart, validEnd),
      leafFromNonCa = ca.issueSigned(
        "leaf-non-ca",
        "center.example.test",
        nonCaIssuer,
        "v3_leaf",
        validStart,
        validEnd,
      ),
      clientAuthLeaf = ca.issueSigned(
        "leaf-client-only",
        "center.example.test",
        rootCa,
        "v3_leaf_client",
        validStart,
        validEnd,
      );

    const writeChain = (name: string, pems: readonly string[]) => {
      const file = path.join(caDir, `${name}.pem`);
      writeFileSync(file, pems.join(""));
      return file;
    };

    const fullIntBundle = writeChain("bundle-full-int", [leafFromInt.pem, intermediateCa.pem, rootCa.pem]),
      publicPartialBundle = writeChain("bundle-leaf-int", [leafFromInt.pem, intermediateCa.pem]),
      rootBundle = writeChain("bundle-leaf-root", [leafFromRoot.pem, rootCa.pem]);

    let version = await managed.version();
    for (const [label, certFile, keyFile, certificateMode] of [
      ["self-signed", validSelfSigned.certFile, validSelfSigned.keyFile, "domain"],
      ["leaf+intermediate+root", fullIntBundle, leafFromInt.keyFile, "internal-ca"],
      ["leaf+root", rootBundle, leafFromRoot.keyFile, "internal-ca"],
      ["leaf+intermediate", publicPartialBundle, leafFromInt.keyFile, "domain"],
    ] as const) {
      const reply = await managed.service.run({
        operation: "listener-set",
        certificateMode,
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: certFile,
        certificateKeyFile: keyFile,
        expectedVersion: version,
      });
      assert.equal(reply.ok, true, label);
      version = String(reply.version);
    }

    const badChains: Array<readonly [string, string, string]> = [
      ["expired leaf", expiredLeaf.certFile, expiredLeaf.keyFile],
      ["not-yet-valid leaf", futureLeaf.certFile, futureLeaf.keyFile],
      [
        "expired intermediate",
        writeChain("bad-exp-int", [leafFromExpiredInt.pem, expiredInt.pem, rootCa.pem]),
        leafFromExpiredInt.keyFile,
      ],
      [
        "not-yet-valid root",
        writeChain("bad-future-root", [leafFromFutureRoot.pem, futureRoot.pem]),
        leafFromFutureRoot.keyFile,
      ],
      [
        "issuer without CA basicConstraints",
        writeChain("bad-non-ca", [leafFromNonCa.pem, nonCaIssuer.pem]),
        leafFromNonCa.keyFile,
      ],
      ["leaf without serverAuth EKU", clientAuthLeaf.certFile, clientAuthLeaf.keyFile],
    ];
    for (const [label, certFile, keyFile] of badChains) {
      await assert.rejects(
        managed.service.run({
          operation: "listener-set",
          certificateMode: "internal-ca",
          listenAddress: "127.0.0.1",
          hostname: "center.example.test",
          port: await availablePort(),
          certificateFile: certFile,
          certificateKeyFile: keyFile,
          expectedVersion: version,
        }),
        { code: "rbac_listener_invalid" },
        label,
      );
    }

    // Corrupting an already-configured certificate on disk with expired PEM reports invalid_material.
    const activeCert = managed.config().listener.certificateFile as string;
    writeFileSync(activeCert, expiredLeaf.pem);
    assert.equal(managedListenerProblem(managed.root, validateCertificateNames), "invalid_material");
  } finally {
    rmSync(caDir, { recursive: true, force: true });
    await managed.close();
  }
});

test("FIFO paths in listener uploads or stored config fail fast without blocking (RBAC-18)", async () => {
  if (process.platform === "win32") return;
  const managed = createHardeningFixture(),
    sources = mkdtempSync(path.join(tmpdir(), "ha-rbac-fifo-"));
  try {
    const fifoCert = path.join(sources, "cert.fifo"),
      fifoKey = path.join(sources, "key.fifo"),
      valid = generateCertWithSan(sources, "v", "center.example.test", "DNS:center.example.test,IP:127.0.0.1");
    execFileSync("mkfifo", [fifoCert]);
    execFileSync("mkfifo", [fifoKey]);

    await assert.rejects(
      managed.service.run({
        operation: "listener-set",
        certificateMode: "domain",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: fifoCert,
        certificateKeyFile: valid.keyFile,
        expectedVersion: await managed.version(),
      }),
      { code: "rbac_listener_invalid" },
    );
    await assert.rejects(
      managed.service.run({
        operation: "listener-set",
        certificateMode: "domain",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: valid.certFile,
        certificateKeyFile: fifoKey,
        expectedVersion: await managed.version(),
      }),
      { code: "rbac_listener_key_exposed" },
    );

    const cfg = managed.config();
    cfg.listener = {
      address: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: fifoCert,
      certificateKeyFile: valid.keyFile,
    };
    managed.writeConfig(cfg);
    assert.equal(managedListenerProblem(managed.root, validateCertificateNames), "missing_certificate");
    assert.equal(readRegularListenerCertificateIfPresent(fifoCert), undefined);
    const recovered = await managed.service.run({
      operation: "listener-set",
      expectedVersion: await managed.version(),
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.listener, null);
  } finally {
    rmSync(sources, { recursive: true, force: true });
    await managed.close();
  }
});
