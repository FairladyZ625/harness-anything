// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import type { RepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const actor = { actor: { principal: { personId: "schedule-repair-test" }, executor: null }, source: "local" as const };

test("a canonical Schedule row missing a newly required field stays readable and can repair itself", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-invalid-projection-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(root);
    cell = await open(root, "seed");
    for (const scheduleId of ["legacy-probe", "healthy-probe"])
      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-create",
              scheduleId,
              name: scheduleId,
              mode: "detect",
              everyMs: 300_000,
              agentId: "probe-agent",
              runtimeInstanceId: "runtime-local",
              mission: `Run ${scheduleId}.`,
              idempotencyKey: `seed:${scheduleId}`,
            },
            actor,
          )
        ).outcome,
        "applied",
      );
    await cell.close();
    cell = undefined;

    removeProjectedAndAuthoredMode(root, "legacy-probe");
    cell = await open(root, "repair");

    const listed = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
        readonly outcome: string;
        readonly schedules: readonly Record<string, unknown>[];
      },
      invalid = listed.schedules.find(({ scheduleId }) => scheduleId === "legacy-probe"),
      healthy = listed.schedules.find(({ scheduleId }) => scheduleId === "healthy-probe");
    assert.equal(listed.outcome, "applied");
    assert.equal(invalid?.state, "invalid");
    assert.match(String(invalid?.invalidReason), /missing required field "mode"/u);
    assert.equal(healthy?.state, "armed");
    assert.equal(healthy?.mode, "detect");

    const shown = (await cell.run({ kind: "schedule-show", scheduleId: "legacy-probe" }, actor)) as unknown as {
      readonly outcome: string;
      readonly schedule: Readonly<Record<string, unknown>>;
    };
    assert.equal(shown.outcome, "applied");
    assert.equal(shown.schedule.state, "invalid");
    assert.match(String(shown.schedule.invalidReason), /missing required field "mode"/u);

    const gui = parseDaemonGuiReadResult("repo.schedules.list", await cell.read("repo.schedules.list")),
      guiInvalid = gui.schedules.find(({ scheduleId }) => scheduleId === "legacy-probe");
    assert.equal(guiInvalid?.state, "invalid");
    if (guiInvalid?.state === "invalid") assert.match(guiInvalid.invalidReason, /missing required field "mode"/u);

    const stillInvalid = await cell.run(
      {
        kind: "schedule-update",
        scheduleId: "legacy-probe",
        name: "Legacy probe renamed",
        idempotencyKey: "repair:without-mode",
      },
      actor,
    );
    assert.equal(stillInvalid.outcome, "op_rejected");
    assert.equal(stillInvalid.code, "invalid_store");
    assert.match(String(stillInvalid.nextAction), /missing required field "mode"/u);

    const invalidMode = await cell.run(
      {
        kind: "schedule-update",
        scheduleId: "legacy-probe",
        mode: "observe",
        idempotencyKey: "repair:invalid-mode",
      },
      actor,
    );
    assert.equal(invalidMode.outcome, "op_rejected");
    assert.equal(invalidMode.code, "invalid_command");

    const repaired = await cell.run(
      {
        kind: "schedule-update",
        scheduleId: "legacy-probe",
        mode: "detect",
        idempotencyKey: "repair:detect",
      },
      actor,
    );
    assert.equal(repaired.outcome, "applied", JSON.stringify(repaired));

    const after = (await cell.run({ kind: "schedule-list" }, actor)) as unknown as {
        readonly schedules: readonly Record<string, unknown>[];
      },
      repairedRow = after.schedules.find(({ scheduleId }) => scheduleId === "legacy-probe");
    assert.equal(repairedRow?.state, "armed");
    assert.equal(repairedRow?.mode, "detect");
    assert.equal(
      after.schedules.every(({ state }) => state !== "invalid"),
      true,
    );
    assert.equal(authoredSchedule(root, "legacy-probe").mode, "detect");
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function initRepo(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: schedule-invalid-projection\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(root, "init", "-q");
  git(root, "config", "user.name", "Schedule Repair Test");
  git(root, "config", "user.email", "schedule-repair@example.invalid");
  git(root, "add", "harness/harness.yaml");
  git(root, "commit", "-qm", "base");
}

function open(root: string, ownerId: string): Promise<RepoCell> {
  return openRepoCell({
    repoId: workspaceId("schedule-invalid-projection"),
    rootDir: canonicalRoot(root),
    ownerId: `schedule-invalid-projection-${ownerId}`,
    now: () => "2026-08-30T06:00:00.000Z",
  });
}

function removeProjectedAndAuthoredMode(root: string, scheduleId: string): void {
  const document = authoredSchedule(root, scheduleId);
  delete document.mode;
  writeFileSync(path.join(root, `harness/schedules/${scheduleId}.json`), `${JSON.stringify(document, null, 2)}\n`);

  const database = new DatabaseSync(path.join(root, ".harness/cache/task.sqlite")),
    row = database
      .prepare("SELECT value_json FROM entity_projection WHERE entity_kind = 'schedule' AND entity_id = ?")
      .get(scheduleId) as { readonly value_json: string },
    projection = JSON.parse(row.value_json) as Record<string, unknown>;
  delete projection.mode;
  database
    .prepare("UPDATE entity_projection SET value_json = ? WHERE entity_kind = 'schedule' AND entity_id = ?")
    .run(JSON.stringify(projection), scheduleId);
  database.close();
}

function authoredSchedule(root: string, scheduleId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, `harness/schedules/${scheduleId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function git(root: string, ...args: readonly string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
