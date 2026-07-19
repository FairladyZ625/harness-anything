// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import {
  daemonLaunchSpecPath,
  persistDaemonLaunchSpec,
  readPersistedDaemonLaunchSpec,
  resolveDaemonLaunchSpec,
  resolveRestoredLaunchOptions,
  type DaemonLaunchOptions
} from "../src/daemon/daemon-launch-spec.ts";

const endpoint = "/old.sock";
const persisted: DaemonLaunchOptions = {
  authorityManifest: "/old/manifest.json",
  authoredRoot: "/old/authored"
};

test("persisted daemon launch options round-trip as structured owner-private state", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    persistDaemonLaunchSpec(userRoot, resolveDaemonLaunchSpec(userRoot, endpoint, persisted));
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, endpoint), persisted);
    const specPath = daemonLaunchSpecPath(userRoot, endpoint);
    const document = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    assert.equal(document.schema, "daemon-launch-spec/v2");
    assert.deepEqual(document.options, persisted);
    assert.equal("launchConfiguration" in document, false);
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
  assert.deepEqual(resolveRestoredLaunchOptions(persisted, {
    authorityManifest: "/new/manifest.json",
    authoredRoot: "/new/authored"
  }), {
    authorityManifest: "/new/manifest.json",
    authoredRoot: "/new/authored"
  });
  assert.deepEqual(resolveRestoredLaunchOptions(persisted, {
    authorityManifest: "/env/manifest.json"
  }), {
    authorityManifest: "/env/manifest.json",
    authoredRoot: "/old/authored"
  });
});

test("no persisted spec and no explicit values leaves restored options absent (fail closed upstream)", () => {
  assert.deepEqual(resolveRestoredLaunchOptions(undefined, {}), {});
});

test("unpublished or malformed persisted formats are ignored and fail closed as missing options", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    writeFileSync(daemonLaunchSpecPath(userRoot, endpoint), JSON.stringify({
      schema: "daemon-launch-spec/v1",
      launchConfiguration: { args: ["--authority-manifest", "/old/manifest.json"] }
    }), "utf8");
    assert.equal(readPersistedDaemonLaunchSpec(userRoot, endpoint), undefined);
    assert.deepEqual(resolveDaemonLaunchSpec(userRoot, endpoint, {}).options, {});
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
    persistDaemonLaunchSpec(userRoot, resolveDaemonLaunchSpec(userRoot, firstEndpoint, persisted));
    persistDaemonLaunchSpec(userRoot, resolveDaemonLaunchSpec(userRoot, secondEndpoint, {
      authorityManifest: "/other/manifest.json"
    }));
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, firstEndpoint), persisted);
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, secondEndpoint), {
      authorityManifest: "/other/manifest.json"
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("structured restore ignores malformed positional and single-dash tokens in legacy argv fields", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    writeFileSync(daemonLaunchSpecPath(userRoot, endpoint), JSON.stringify({
      schema: "daemon-launch-spec/v2",
      endpoint,
      options: persisted,
      launchConfiguration: {
        args: ["--authored-root", "daemon", "serve", "--authority-manifest", "-x"]
      }
    }), "utf8");
    assert.deepEqual(resolveDaemonLaunchSpec(userRoot, endpoint, {}).options, persisted);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("foreground and autostart omission resolve before persistence and cannot overwrite a complete spec", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-launch-spec-"));
  try {
    persistDaemonLaunchSpec(userRoot, resolveDaemonLaunchSpec(userRoot, endpoint, persisted));
    persistDaemonLaunchSpec(userRoot, resolveDaemonLaunchSpec(userRoot, endpoint, {}));
    persistDaemonLaunchSpec(userRoot, resolveDaemonLaunchSpec(userRoot, endpoint, {}));
    assert.deepEqual(readPersistedDaemonLaunchSpec(userRoot, endpoint), persisted);
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
