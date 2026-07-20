// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import {
  daemonLaunchSpecPath,
  parseDaemonLaunchArgv,
  readPersistedDaemonLaunchSpec,
  resolveCompleteDaemonLaunchSpec,
  resolveDaemonLaunchSpec,
  resolveRestoredLaunchOptions,
  type DaemonLaunchConfiguration,
  type DaemonLaunchOptions
} from "../src/daemon/daemon-launch-spec.ts";

const fixtureRoot = path.resolve(tmpdir(), "ha-daemon-launch-spec-fixture");
const endpoint = path.join(fixtureRoot, "old.sock");
const persisted: DaemonLaunchOptions = {
  authorityManifest: path.join(fixtureRoot, "old", "manifest.json"),
  authoredRoot: path.join(fixtureRoot, "old", "authored")
};
const persistedConfiguration = launchConfiguration(endpoint, persisted);

test("persisted daemon launch spec round-trips the RPC launch configuration structure privately", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    resolveDaemonLaunchSpec(userRoot, endpoint, persisted).persist(userRoot, persistedConfiguration);
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, endpoint), persistedConfiguration);
    const specPath = daemonLaunchSpecPath(userRoot, endpoint);
    const document = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    assert.equal(document.schema, "daemon-launch-spec/v3");
    assert.deepEqual(document.launchConfiguration, persistedConfiguration);
    assert.equal("options" in document, false);
    if (process.platform !== "win32") assert.equal(statSync(specPath).mode & 0o777, 0o600);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("cold start restores the omitted authority manifest and authored root from structured fields", () => {
  const restored = resolveRestoredLaunchOptions(persisted, {});
  assert.deepEqual(restored, persisted);
});

test("explicit launch values take precedence independently over the persisted spec", () => {
  const newManifest = path.join(fixtureRoot, "new", "manifest.json");
  const newAuthoredRoot = path.join(fixtureRoot, "new", "authored");
  const environmentManifest = path.join(fixtureRoot, "env", "manifest.json");
  assert.deepEqual(resolveRestoredLaunchOptions(persisted, {
    authorityManifest: newManifest,
    authoredRoot: newAuthoredRoot
  }), {
    authorityManifest: newManifest,
    authoredRoot: newAuthoredRoot
  });
  assert.deepEqual(resolveRestoredLaunchOptions(persisted, {
    authorityManifest: environmentManifest
  }), {
    authorityManifest: environmentManifest,
    authoredRoot: persisted.authoredRoot
  });
});

test("no persisted spec and no explicit values leaves restored options absent (fail closed upstream)", () => {
  assert.deepEqual(resolveRestoredLaunchOptions(undefined, {}), {});
});

test("a validated v2 launch spec remains a compatible cold-start source", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    writeFileSync(daemonLaunchSpecPath(userRoot, endpoint), JSON.stringify({
      schema: "daemon-launch-spec/v2",
      endpoint,
      options: persisted
    }), "utf8");
    assert.deepEqual(resolveDaemonLaunchSpec(userRoot, endpoint, {}).options, persisted);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("malformed persisted formats fail closed with a rebuild command without exposing JSON content", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  const privateFragment = `${persisted.authorityManifest}-private-fragment`;
  try {
    writeFileSync(
      daemonLaunchSpecPath(userRoot, endpoint),
      `{"schema":"daemon-launch-spec/v3","authorityManifest":"${privateFragment}",BROKEN}`,
      "utf8"
    );
    assert.throws(
      () => resolveDaemonLaunchSpec(userRoot, endpoint, {}),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const message = (error as Error).message;
        assert.match(
          message,
          /DAEMON_LAUNCH_SPEC_INCOMPATIBLE.*invalid-json.*ha daemon start --service --user-root <user-root> --authority-manifest <path>/u
        );
        assert.equal(message.includes(privateFragment), false);
        return true;
      }
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("launch spec paths hash the real endpoint without character or case collisions", () => {
  const userRoot = "/tmp/ha-daemon-launch-spec";
  const endpoints = ["a/b", "a?b", "a_b", "A_B"].map((daemonId) => (
    localUserDaemonEndpoint(userRoot, daemonId)
  ));
  endpoints.push("/a.sock", "/b.sock");
  const specPaths = endpoints.map((candidate) => daemonLaunchSpecPath(userRoot, candidate));
  assert.equal(new Set(specPaths).size, endpoints.length);
  for (const specPath of specPaths) {
    assert.match(path.basename(specPath), /^daemon-launch-spec\.[a-f0-9]{64}\.json$/u);
  }
});

test("different explicit sockets cannot read or replace each other's launch options", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    const firstEndpoint = path.join(userRoot, "a.sock");
    const secondEndpoint = path.join(userRoot, "b.sock");
    const otherManifest = path.join(userRoot, "other", "manifest.json");
    const firstConfiguration = launchConfiguration(firstEndpoint, persisted);
    resolveDaemonLaunchSpec(userRoot, firstEndpoint, persisted).persist(userRoot, firstConfiguration);
    resolveDaemonLaunchSpec(userRoot, secondEndpoint, {
      authorityManifest: otherManifest
    }).persist(userRoot, launchConfiguration(secondEndpoint, { authorityManifest: otherManifest }));
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, firstEndpoint), firstConfiguration);
    assert.deepEqual(
      readPersistedDaemonLaunchSpec(userRoot, secondEndpoint),
      launchConfiguration(secondEndpoint, { authorityManifest: otherManifest })
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("structured restore derives inherited options from the shared launch configuration", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    writeFileSync(daemonLaunchSpecPath(userRoot, endpoint), JSON.stringify({
      schema: "daemon-launch-spec/v3",
      endpoint,
      launchConfiguration: persistedConfiguration
    }), "utf8");
    assert.deepEqual(resolveDaemonLaunchSpec(userRoot, endpoint, {}).options, persisted);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("foreground and autostart omission resolve before persistence and cannot overwrite a complete spec", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    resolveDaemonLaunchSpec(userRoot, endpoint, persisted).persist(userRoot, persistedConfiguration);
    resolveDaemonLaunchSpec(userRoot, endpoint, {}).persist(userRoot, persistedConfiguration);
    resolveDaemonLaunchSpec(userRoot, endpoint, {}).persist(userRoot, persistedConfiguration);
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, endpoint), persistedConfiguration);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("explicit empty launch options are invalid instead of restoring persisted values", () => {
  assert.throws(
    () => resolveRestoredLaunchOptions(persisted, { authorityManifest: "" }),
    /--authority-manifest/u
  );
  assert.throws(
    () => resolveRestoredLaunchOptions(persisted, { authoredRoot: "" }),
    /--authored-root/u
  );
});

test("launch argv parsing canonicalizes recoverable paths and validates known option boundaries", () => {
  const cwd = path.join(tmpdir(), "daemon-launch-cwd");
  const parsed = parseDaemonLaunchArgv([
    "daemon", "start", "--root", "repo", "--authority-manifest", "config/authority.json",
    "--authored-root", "--relative-authored", "--socket", "daemon.sock", "--user-root", "state"
  ], cwd, {});
  assert.equal(parsed.rootDir, path.join(cwd, "repo"));
  assert.equal(parsed.authorityManifest, path.join(cwd, "config/authority.json"));
  assert.equal(parsed.authoredRoot, path.join(cwd, "repo", "--relative-authored"));
  assert.equal(parsed.socketPath, path.join(cwd, "daemon.sock"));
  assert.equal(parsed.userRoot, path.join(cwd, "state"));
  for (const argv of [
    ["daemon", "serve", "--socket"],
    ["daemon", "serve", "--user-root", ""],
    ["daemon", "serve", "--socket", "--root", "/repo"],
    ["daemon", "serve", "--root"],
    ["daemon", "serve", "--root", ""],
    ["daemon", "serve", "--root", "--socket", "/tmp/daemon.sock"],
    ["daemon", "start", "--user-root", "-relative-root"],
    ["daemon", "start", "--authored-root", "--json"]
  ]) assert.throws(() => parseDaemonLaunchArgv(argv, cwd, {}), /requires a non-empty/u);
});

test("an opaque immutable resolution persists its captured snapshot without rereading durable state", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    resolveCompleteDaemonLaunchSpec(endpoint, persisted).persist(userRoot, persistedConfiguration);
    const captured = resolveDaemonLaunchSpec(userRoot, endpoint, {});
    const otherConfiguration = launchConfiguration(endpoint, {
      authorityManifest: path.join(fixtureRoot, "other", "manifest.json")
    });
    resolveCompleteDaemonLaunchSpec(endpoint, {
      authorityManifest: path.join(fixtureRoot, "other", "manifest.json")
    }).persist(userRoot, otherConfiguration);
    captured.persist(userRoot, persistedConfiguration);
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, endpoint), persistedConfiguration);
    assert.equal(Object.isFrozen(captured.options), true);
    assert.equal("persist" in { ...captured }, false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function launchConfiguration(
  ownedEndpoint: string,
  options: DaemonLaunchOptions
): DaemonLaunchConfiguration {
  return {
    execPath: "/current/node",
    execArgv: ["--enable-source-maps"],
    entrypoint: "/current/ha.js",
    args: [
      "--root", fixtureRoot,
      ...(options.authoredRoot !== undefined ? ["--authored-root", options.authoredRoot] : []),
      "daemon", "serve",
      "--repo", "canonical",
      "--socket", ownedEndpoint,
      "--user-root", fixtureRoot,
      ...(options.authorityManifest !== undefined
        ? ["--authority-manifest", options.authorityManifest]
        : [])
    ]
  };
}
