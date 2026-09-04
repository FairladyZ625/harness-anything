// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, git, initRepo, write } from "./doc-sync-slice-a.fixtures.ts";

interface ScanRow {
  readonly path: string;
  readonly state: string;
  readonly reason: string | null;
  readonly mediaType: string | null;
}

test("repo prose channel blocks artifacts under an unregistered tasks/ package directory", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ghost-package-"));
  initRepo(rootDir);
  const repoId = workspaceId("ghost-package"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "ghost-package-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-ghost", title: "Ghost Package" },
      binding,
    )) as {
      readonly outcome: string;
      readonly packagePath: string;
    };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = created.packagePath;
    assert.equal(packagePath, "tasks/task-ghost-ghost-package");
    // The impostor directory shares the task id prefix but is not the projected
    // packagePath — the exact shape of the four ghost directories in the wild.
    const impostor = "tasks/task-ghost-wrong-slug",
      ghost = `${impostor}/artifacts/closeout-packet.md`,
      real = `${packagePath}/artifacts/report.md`;
    write(rootDir, ghost, "# Ghosted copy\n\nwritten into a guessed directory name\n");
    write(rootDir, real, "# Real artifact\n");
    const statusRows = scanRows(await cell.run({ kind: "doc-status", paths: [] }, binding));
    const ghostRow = statusRows.find((row) => row.path === ghost),
      realRow = statusRows.find((row) => row.path === real);
    assert.deepEqual([ghostRow?.state, realRow?.state], ["blocked", "eligible"]);
    assert.match(ghostRow?.reason ?? "", /tasks\/task-ghost-wrong-slug is not the package path of any projected task/u);
    assert.match(ghostRow?.reason ?? "", /ha task artifact add/u);
    assert.equal(ghostRow?.mediaType, "text/markdown");
    // Misfire control: the eligible sibling in the registered package still
    // publishes, and the blocked ghost must not ride along in that submit.
    const submitted = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as {
      readonly outcome: string;
      readonly opId: string;
      readonly summary: string | null;
    };
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(submitted.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        [real],
      );
    assert.match(
      submitted.summary ?? "",
      new RegExp(`${ghost.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\tblocked\\t`, "u"),
    );
    assert.equal(existsSync(path.join(rootDir, "harness", ghost)), true);
    // A submit whose only candidate is the ghost refuses with the recovery route.
    write(rootDir, `${impostor}/artifacts/second.md`, "# Second ghost\n");
    const rejected = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as {
      readonly outcome: string;
      readonly code: string;
      readonly detail: {
        readonly unresolvedTouches: readonly { readonly path: string; readonly requiredRoute: string }[];
      };
    };
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "preview_blocked");
    assert.deepEqual(
      rejected.detail.unresolvedTouches.map((touch) => [touch.path, touch.requiredRoute]),
      [
        [ghost, "ha task artifact add"],
        [`${impostor}/artifacts/second.md`, "ha task artifact add"],
      ],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the --task channel keeps its package-prefix enumeration and admits its own artifacts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ghost-package-scoped-"));
  initRepo(rootDir);
  const repoId = workspaceId("ghost-package-scoped"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "ghost-package-scoped-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-scoped", title: "Scoped Ghost" },
      binding,
    )) as {
      readonly outcome: string;
      readonly packagePath: string;
    };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = created.packagePath;
    write(rootDir, `${packagePath}/artifacts/report.md`, "# Registered package artifact\n");
    write(rootDir, `tasks/task-scoped-wrong-slug/artifacts/x.md`, "# Unregistered neighbor\n");
    write(rootDir, "context/unrelated.md", "# Unrelated\n");
    const scopedRows = scanRows(await cell.run({ kind: "doc-status", taskId: "task-scoped" }, binding));
    assert.equal(
      scopedRows.every((row) => row.path.startsWith(`${packagePath}/`)),
      true,
      `--task enumeration must stay scoped to the package prefix: ${JSON.stringify(scopedRows.map((row) => row.path))}`,
    );
    assert.deepEqual(
      scopedRows.filter((row) => row.path === `${packagePath}/artifacts/report.md`).map((row) => row.state),
      ["eligible"],
    );
    assert.equal(
      scopedRows.some((row) => row.path === "context/unrelated.md"),
      false,
    );
    const submitted = await cell.run({ kind: "doc-submit", taskId: "task-scoped" }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(git(rootDir, "status", "--porcelain", "-uall").includes("context/unrelated"), true);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function scanRows(receipt: { readonly evidence?: string }): readonly ScanRow[] {
  assert.match(receipt.evidence ?? "", /^doc-scan:/u);
  return (
    JSON.parse((receipt.evidence ?? "").slice("doc-scan:".length) as string) as { readonly rows: readonly ScanRow[] }
  ).rows;
}
