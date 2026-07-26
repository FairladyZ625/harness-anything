// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDaemonLaunchConfiguration,
  createDaemonLaunchConfigurationFromPersistedPolicy,
  daemonLaunchOptionsResolvedFlag,
  daemonLaunchSpecPath,
  daemonLaunchSpecSchema,
  type DaemonLaunchConfiguration,
  type DaemonLaunchConfigurationInput
} from "../src/client/local-json-rpc-client.ts";

test("persisted policy is restored while current runtime and target fields stay authoritative", () => {
  const fixture = makeFixture();
  try {
    const authorityManifest = path.join(fixture.userRoot, "authority.json");
    const authoredRoot = path.join(fixture.currentTarget.canonicalRoot, ".authored");
    const staleConfiguration = createDaemonLaunchConfiguration({
      target: {
        ...fixture.currentTarget,
        canonicalRoot: path.join(fixture.userRoot, "moved-repository"),
        repoId: "stale-repo"
      },
      entrypoint: "/stale/cli.js",
      idleExitMs: 750,
      execPath: "/stale/node",
      execArgv: ["--stale-runtime-flag"],
      authorityManifest,
      authoredRoot,
      launchOptionsResolved: true,
      machineId: "stale-machine",
      daemonGeneration: 41
    });
    writeLaunchSpec(fixture, staleConfiguration);

    const actual = createDaemonLaunchConfigurationFromPersistedPolicy(fixture.currentInput);

    assert.equal(actual.execPath, fixture.currentInput.execPath);
    assert.deepEqual(actual.execArgv, fixture.currentInput.execArgv);
    assert.equal(actual.entrypoint, fixture.currentInput.entrypoint);
    assert.deepEqual(actual.args, [
      "--root", fixture.currentTarget.canonicalRoot,
      "--authored-root", authoredRoot,
      "daemon", "serve",
      "--repo", fixture.currentTarget.repoId,
      "--socket", fixture.currentTarget.socketPath,
      "--user-root", fixture.currentTarget.userRoot,
      "--idle-ms", String(fixture.currentInput.idleExitMs),
      "--authority-manifest", authorityManifest,
      daemonLaunchOptionsResolvedFlag
    ]);
    assert.equal(actual.machineId, undefined);
    assert.equal(actual.daemonGeneration, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("no persisted spec preserves the previous GUI autostart configuration", () => {
  const fixture = makeFixture();
  try {
    assert.deepEqual(
      createDaemonLaunchConfigurationFromPersistedPolicy(fixture.currentInput),
      createDaemonLaunchConfiguration(fixture.currentInput)
    );
  } finally {
    fixture.cleanup();
  }
});

test("a persisted spec without an authority manifest does not invent one", () => {
  const fixture = makeFixture();
  try {
    writeLaunchSpec(fixture, createDaemonLaunchConfiguration({
      ...fixture.currentInput,
      execPath: "/stale/node",
      entrypoint: "/stale/cli.js",
      launchOptionsResolved: true
    }));

    const actual = createDaemonLaunchConfigurationFromPersistedPolicy(fixture.currentInput);

    assert.equal(actual.args.includes("--authority-manifest"), false);
    assert.equal(actual.args.includes(daemonLaunchOptionsResolvedFlag), true);
  } finally {
    fixture.cleanup();
  }
});

test("a spec document owned by another endpoint is treated as absent", () => {
  const fixture = makeFixture();
  try {
    const otherEndpoint = path.join(fixture.userRoot, "other.sock");
    const configuration = createDaemonLaunchConfiguration({
      ...fixture.currentInput,
      target: { ...fixture.currentTarget, socketPath: otherEndpoint },
      authorityManifest: path.join(fixture.userRoot, "other-authority.json"),
      launchOptionsResolved: true
    });
    writeFileSync(daemonLaunchSpecPath(fixture.userRoot, fixture.currentTarget.socketPath), JSON.stringify({
      schema: daemonLaunchSpecSchema,
      endpoint: otherEndpoint,
      launchConfiguration: configuration
    }));

    assert.deepEqual(
      createDaemonLaunchConfigurationFromPersistedPolicy(fixture.currentInput),
      createDaemonLaunchConfiguration(fixture.currentInput)
    );
  } finally {
    fixture.cleanup();
  }
});

test("an unclassified persisted launch argument is detected instead of silently dropped", () => {
  const fixture = makeFixture();
  try {
    const configuration = createDaemonLaunchConfiguration({
      ...fixture.currentInput,
      authorityManifest: path.join(fixture.userRoot, "authority.json"),
      launchOptionsResolved: true
    });
    writeLaunchSpec(fixture, {
      ...configuration,
      args: [...configuration.args, "--future-policy-flag"]
    });

    assert.throws(
      () => createDaemonLaunchConfigurationFromPersistedPolicy(fixture.currentInput),
      /DAEMON_LAUNCH_SPEC_POLICY_MISMATCH/u
    );
  } finally {
    fixture.cleanup();
  }
});

function makeFixture(): {
  readonly userRoot: string;
  readonly currentTarget: DaemonLaunchConfigurationInput["target"];
  readonly currentInput: DaemonLaunchConfigurationInput;
  readonly cleanup: () => void;
} {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-policy-spec-"));
  const currentTarget = {
    canonicalRoot: path.join(userRoot, "current-repository"),
    repoId: "current-repo",
    socketPath: path.join(userRoot, "daemon.sock"),
    userRoot
  };
  return {
    userRoot,
    currentTarget,
    currentInput: {
      target: currentTarget,
      entrypoint: "/current/cli.js",
      idleExitMs: 15_000,
      execPath: "/current/node",
      execArgv: ["--current-runtime-flag"],
      env: {}
    },
    cleanup: () => rmSync(userRoot, { recursive: true, force: true })
  };
}

function writeLaunchSpec(
  fixture: { readonly userRoot: string; readonly currentTarget: DaemonLaunchConfigurationInput["target"] },
  launchConfiguration: DaemonLaunchConfiguration
): void {
  writeFileSync(
    daemonLaunchSpecPath(fixture.userRoot, fixture.currentTarget.socketPath),
    JSON.stringify({
      schema: daemonLaunchSpecSchema,
      endpoint: fixture.currentTarget.socketPath,
      launchConfiguration
    })
  );
}
