// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { after, type TestContext } from "node:test";
import { daemonProcessAlive, readDaemonPid } from "@harness-anything/daemon/internal/daemon-singleton";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

type DaemonFixtureTarget = {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly env: NodeJS.ProcessEnv;
};

export async function stopOwnedDaemonFixture(
  input: DaemonFixtureTarget,
  entry = path.resolve("packages/cli/src/index.ts"),
): Promise<void> {
  const pid = readDaemonPid(input.userRoot, input.daemonId);
  if (pid === null || !daemonProcessAlive(pid)) return;
  const stopped = spawnSync(
    process.execPath,
    [entry, "daemon", "stop", "--user-root", input.userRoot, "--daemon-id", input.daemonId, "--json"],
    { encoding: "utf8", env: input.env, timeout: 10_000 },
  );
  assert.equal(stopped.status, 0, `${stopped.error ?? ""}\n${stopped.stderr}\n${stopped.stdout}`);
  await waitForDaemonFixtureExit(pid);
}

export async function waitForDaemonFixtureExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (daemonProcessAlive(pid)) {
    assert.ok(Date.now() < deadline, `fixture daemon ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Register ownership before launching: test failures must not skip daemon teardown. */
export function ownDaemonFixture(
  input: DaemonFixtureTarget & { readonly parent: string },
  context?: TestContext,
): void {
  const cleanup = async () => {
    await stopOwnedDaemonFixture(input);
    removeTempRepository(input.parent);
  };
  if (context) context.after(cleanup);
  else after(cleanup);
}
