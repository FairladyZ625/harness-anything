// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  runDaemonServe,
  type DaemonServeHooks
} from "@harness-anything/daemon";
import { cliDaemonServiceHostServices } from "../src/composition/daemon-service-host-services.ts";
import {
  defaultDaemonUserRoot,
  runRawJson,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";

test("persisted daemon termination diagnostics retain a stop handler's nested reason", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "recovery",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    const endpoint = path.join(rootDir, "daemon-diagnostic.sock");
    const hooks: DaemonServeHooks = {
      onStop: async () => {
        throw new AggregateError([
          new Error("fixture nested stop cause")
        ], "fixture stop aggregate");
      }
    };

    await assert.rejects(runDaemonServe({
      rootDir,
      userRoot,
      endpoint,
      requestedRepoId: "canonical",
      entrypoint: path.resolve("packages/cli/src/index.ts"),
      idleMs: 1,
      preflightReplacement: async () => undefined
    }, cliDaemonServiceHostServices, {
      persistLaunchConfiguration: () => undefined,
      createAuthorityLifecycle: () => {
        throw new Error("fixture authority lifecycle is not used");
      },
      projectStartedStatus: () => ({})
    }, hooks), (error: unknown) => error instanceof AggregateError);

    const recordText = persistedTerminationRecord(userRoot);
    const record = JSON.parse(recordText) as {
      readonly event?: unknown;
      readonly hint?: unknown;
    };
    assert.equal(record.event, "daemon.lifecycle.terminated");
    assert.match(String(record.hint), /AggregateError: fixture stop aggregate/u);
    assert.match(String(record.hint), /Error: fixture nested stop cause/u);
    assert.match(recordText, /fixture nested stop cause/u);
  });
});

function persistedTerminationRecord(userRoot: string): string {
  const logRoot = path.join(userRoot, "logs", "harness-anything");
  const lines = readdirSync(logRoot)
    .filter((name) => name.endsWith(".ndjson"))
    .sort()
    .flatMap((name) => readFileSync(path.join(logRoot, name), "utf8").split("\n"))
    .filter((line) => line.trim().length > 0);
  const record = lines.findLast((line) => {
    const parsed = JSON.parse(line) as { readonly event?: unknown };
    return parsed.event === "daemon.lifecycle.terminated";
  });
  assert.ok(record, "expected a persisted daemon.lifecycle.terminated record");
  return record;
}
