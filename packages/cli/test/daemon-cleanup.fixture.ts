// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { daemonProcessAlive, readDaemonPid } from "../../daemon/src/daemon-singleton.ts";

/** Register ownership before launching: test failures must not skip daemon teardown. */
export function ownDaemonFixture(input: {
  readonly parent: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly env: NodeJS.ProcessEnv;
}): void {
  after(async () => {
    const pid = readDaemonPid(input.userRoot, input.daemonId);
    if (pid !== null) {
      const stopped = spawnSync(
        process.execPath,
        [
          path.resolve("packages/cli/src/index.ts"),
          "daemon",
          "stop",
          "--user-root",
          input.userRoot,
          "--daemon-id",
          input.daemonId,
          "--json",
        ],
        { encoding: "utf8", env: input.env, timeout: 10_000 },
      );
      assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
      // A successful stop can still be draining. Keep its files until the process has exited.
      const deadline = Date.now() + 10_000;
      while (daemonProcessAlive(pid)) {
        assert.ok(Date.now() < deadline, `fixture daemon ${pid} did not exit; preserving ${input.parent}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    rmSync(input.parent, { recursive: true, force: true });
  });
}
