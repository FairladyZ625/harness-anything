import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { canonicalRoot, workspaceId } from "../../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "../../../packages/daemon/test/repo-settings.fixture.ts";
import { actor } from "../../../packages/daemon/test/task-surface.fixtures.ts";

const [mode, rootDir, repoId, taskId] = process.argv.slice(2);
if (!mode || !rootDir) throw new Error("usage: repo-cell-shadow-fixture.mjs <mode> <root> [repo-id] [task-id]");

if (mode === "pwrite-probe") {
  mkdirSync(rootDir, { recursive: true });
  const descriptor = openSync(path.join(rootDir, "pwrite-probe.bin"), "w", 0o600);
  try {
    try {
      const written = writeSync(descriptor, Buffer.from("probe"), 0, 5, 0);
      process.stdout.write(`${JSON.stringify({ pid: process.pid, status: "ok", written })}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          pid: process.pid,
          status: "error",
          code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
} else if (mode === "command") {
  if (!repoId || !taskId) throw new Error("command mode requires repo-id and task-id");
  const stateRoot = path.join(rootDir, ".harness", "fleet");
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: "stress-s2-command",
    defaultWriterEpochFence: {
      schema: "harness-writer-epoch-fence/v1",
      stateRoot,
      repoId,
      epoch: 1,
      holderId: "stress-s2-center",
    },
    now: () => "2026-09-05T01:00:00.000Z",
  });
  try {
    const receipt = await cell.run(
      { kind: "task-create", taskId, title: "Stress S2 shadow fault", profileId: "baseline" },
      { actor, source: "local" },
    );
    process.stdout.write(`${JSON.stringify({ pid: process.pid, receipt })}\n`);
  } finally {
    await cell.close();
  }
} else {
  throw new Error(`unknown mode: ${mode}`);
}
