// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { queryDecisionProjection, queryTaskProjection, rebuildTaskProjection } from "../../kernel/src/index.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("attribution backfill declaration resolves every legacy shape without overriding exact matches", () => {
  withFixture((rootDir) => {
    rebuildTaskProjection({ rootDir });
    const beforeRows = queryDecisionProjection({ rootDir, filters: {} }).rows;
    assert.equal(beforeRows.find((row) => row.decisionId === "dec_HUMAN")?.attribution.completeness, "legacy-partial");
    assert.equal(beforeRows.find((row) => row.decisionId === "dec_HUMAN")?.attribution.originator?.principal.personId, "person_fixture");
    assert.equal(beforeRows.find((row) => row.decisionId === "dec_AGENT")?.attribution.completeness, "unresolved");
    assert.equal(beforeRows.find((row) => row.decisionId === "dec_AGENT")?.attribution.originator, null);
    assert.equal(beforeRows.find((row) => row.decisionId === "dec_SYSTEM")?.attribution.originator, null);

    const authoredBefore = decisionBodies(rootDir);
    const eventRoot = path.join(rootDir, "harness/attribution-events");
    const eventFilesBefore = existsSync(eventRoot) ? readdirSync(eventRoot) : [];
    const first = runJson(rootDir, ["migrate", "attribution", "--dry-run"]);
    const second = runJson(rootDir, ["migrate", "attribution", "--dry-run"]);
    assert.equal(first.migrationMode, "plan");
    assert.equal(first.report.planId, second.report.planId);
    assert.equal(first.report.reportDigest, second.report.reportDigest);
    assert.equal(first.report.summary.legacyDerived, 1);
    assert.equal(first.report.summary.declared, 0);
    assert.equal(first.report.summary.unresolved, 7);
    assert.deepEqual(decisionBodies(rootDir), authoredBefore);
    assert.deepEqual(existsSync(eventRoot) ? readdirSync(eventRoot) : [], eventFilesBefore);

    const principalOnly = runJson(rootDir, ["migrate", "attribution", "--declare-principal", "person_declared"], false);
    assert.equal(principalOnly.ok, false);
    assert.equal(principalOnly.error.code, "attribution_declaration_invalid");
    const authorityOnly = runJson(rootDir, ["migrate", "attribution", "--declare-authority", "dec_AUTHORITY"], false);
    assert.equal(authorityOnly.ok, false);
    assert.equal(authorityOnly.error.code, "attribution_declaration_invalid");
    const missingPerson = runJson(rootDir, declarationArgs("person_missing"), false);
    assert.equal(missingPerson.ok, false);
    assert.equal(missingPerson.error.code, "attribution_declaration_invalid");

    const declared = runJson(rootDir, declarationArgs("person_declared"));
    const declaredAgain = runJson(rootDir, declarationArgs("person_declared"));
    const changedDeclaration = runJson(rootDir, [
      "migrate", "attribution", "--declare-principal", "person_declared", "--declare-authority", "dec_OTHER_AUTHORITY"
    ]);
    assert.equal(declared.report.planId, declaredAgain.report.planId);
    assert.notEqual(declared.report.planId, changedDeclaration.report.planId);
    assert.deepEqual(declared.report.declaration, { personId: "person_declared", authority: "dec_AUTHORITY" });
    assert.equal(declared.report.summary.legacyDerived, 1);
    assert.equal(declared.report.summary.declared, 7);
    assert.equal(declared.report.summary.unresolved, 0);

    const exact = candidate(declared, "decision", "dec_HUMAN", "proposedBy");
    assert.equal(exact.resolution, "legacy-derived");
    assert.equal(exact.actor.principal.personId, "person_fixture");
    const humanVariant = candidate(declared, "decision", "dec_AGENT", "arbiter");
    assert.equal(humanVariant.resolution, "declared");
    assert.equal(humanVariant.actor.principal.personId, "person_declared");
    assert.equal(humanVariant.actor.executor, null);
    const agent = candidate(declared, "decision", "dec_AGENT", "proposedBy");
    assert.deepEqual(agent.actor.executor, { kind: "agent", id: "historical-agent" });
    const system = candidate(declared, "decision", "dec_SYSTEM", "proposedBy");
    assert.deepEqual(system.actor.executor, { kind: "agent", id: "historical-cron" });
    assert.match(system.reason, /normalized legacy system actor to agent executor/u);
    const trackedTask = candidate(declared, "task", "task_TRACKED", "createdBy");
    assert.equal(trackedTask.actor.executor, null);
    assert.equal(trackedTask.occurredAt, "2025-12-31T23:00:00Z");
    assert.equal(trackedTask.anchorMissing, undefined);
    const missingAnchorTask = candidate(declared, "task", "task_UNTRACKED", "createdBy");
    assert.equal(missingAnchorTask.anchorMissing, true);
    assert.match(missingAnchorTask.reason, /historical anchor missing/u);

    const unconfirmed = runJson(rootDir, [...declarationArgs("person_declared"), "--apply"], false);
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.error.code, "plan_confirmation_required");
    assert.deepEqual(existsSync(eventRoot) ? readdirSync(eventRoot) : [], eventFilesBefore);

    const applied = runJson(rootDir, [
      ...declarationArgs("person_declared"), "--apply", "--confirm-plan", String(declared.report.planId)
    ]);
    assert.equal(applied.report.appliedEvents, 8);
    assert.deepEqual(decisionBodies(rootDir), authoredBefore);
    const migrationEvents = readEvents(eventRoot).filter((event) => event.principalSource.kind === "migration");
    assert.equal(migrationEvents.length, 8);
    assert.equal(migrationEvents.every((event) => event.principalSource.evidenceRef === declared.report.reportDigest), true);
    const exactEvent = eventFor(migrationEvents, "decision/dec_HUMAN", "decision_propose");
    assert.equal(exactEvent.actor.principal.personId, "person_fixture");
    assert.equal(exactEvent.actor.executor, null);
    assert.equal(exactEvent.at, "2026-01-01T00:00:00.000Z");
    assert.notEqual(exactEvent.recordedAt, exactEvent.at);
    const systemEvent = eventFor(migrationEvents, "decision/dec_SYSTEM", "decision_propose");
    assert.deepEqual(systemEvent.actor.executor, { kind: "agent", id: "historical-cron" });
    const trackedTaskEvent = eventFor(migrationEvents, "task/task_TRACKED", "package_create");
    assert.equal(trackedTaskEvent.at, "2025-12-31T23:00:00Z");
    assert.notEqual(trackedTaskEvent.recordedAt, trackedTaskEvent.at);
    const missingAnchorEvent = eventFor(migrationEvents, "task/task_UNTRACKED", "package_create");
    assert.equal(missingAnchorEvent.at, missingAnchorEvent.recordedAt);

    const afterRows = queryDecisionProjection({ rootDir, filters: {} }).rows;
    assert.equal(afterRows.every((row) => row.attribution.completeness === "complete"), true);
    const afterTasks = queryTaskProjection({ rootDir, filters: {} }).rows;
    assert.equal(afterTasks.length, 2);
    assert.equal(afterTasks.every((row) => row.attribution.completeness === "complete"), true);
    const covered = runJson(rootDir, declarationArgs("person_declared"));
    assert.equal(covered.report.summary.alreadyCovered, 8);
    assert.equal(covered.report.summary.declared, 0);
    assert.equal(covered.report.summary.applicableEvents, 0);
  });
});

function withFixture(fn: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-attribution-backfill-"));
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFile(rootDir, "harness/people.yaml", JSON.stringify({
    schema: "harness-people/v1",
    people: [
      { personId: "person_fixture", displayName: "Fixture", primaryEmail: "fixture@example.test", roles: [], credentials: [] },
      { personId: "person_declared", displayName: "Declared", primaryEmail: "declared@example.test", roles: [], credentials: [] }
    ],
    roles: []
  }));
  writeFile(rootDir, "harness/harness.yaml", [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "settings:",
    "  identity:",
    "    personId: person_declared",
    "    displayName: Declared",
    ""
  ].join("\n"));
  writeDecision(rootDir, "dec_HUMAN", "human", "person_fixture", "agent", "legacy-arbiter");
  writeDecision(rootDir, "dec_AGENT", "agent", "historical-agent", "human", "unknown-person");
  writeDecision(rootDir, "dec_SYSTEM", "system", "historical-cron", "agent", "legacy-arbiter");
  writeTask(rootDir, "task_TRACKED");
  execFileSync("git", ["-C", harnessRoot, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "fixture"], {
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_DATE: "2025-12-31T23:00:00+00:00", GIT_COMMITTER_DATE: "2025-12-31T23:00:00+00:00" }
  });
  writeTask(rootDir, "task_UNTRACKED");
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeTask(rootDir: string, id: string): void {
  writeFile(rootDir, `harness/tasks/${id}/INDEX.md`, [
    "---",
    "schema: task-package/v2",
    `task_id: ${id}`,
    `title: ${id}`,
    "status: planned",
    "createdAt: 2025-01-01T00:00:00.000Z",
    "updatedAt: 2025-01-01T00:00:00.000Z",
    "lifecycle:",
    "  engine: local",
    "  ref: local",
    "  bindingCreatedAt: 2025-01-01T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "createdBy:",
    "  name: Historical User",
    "  email: historical@example.test",
    "---",
    "",
    `# ${id}`,
    ""
  ].join("\n"));
}

function writeDecision(rootDir: string, id: string, kind: "human" | "agent" | "system", actorId: string, arbiterKind: "human" | "agent", arbiterId: string): void {
  writeFile(rootDir, `harness/decisions/${id}/decision.md`, [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${id}`,
    `_coordinatorWatermark: watermark-${id}`,
    `title: ${id}`,
    "state: proposed",
    "riskTier: low",
    "urgency: low",
    "vertical: software/coding",
    "preset: standard-task",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    `proposedBy: {kind: ${kind}, id: ${actorId}}`,
    "proposedAt: 2026-01-01T00:00:00.000Z",
    `arbiter: {kind: ${arbiterKind}, id: ${arbiterId}}`,
    "provenance:",
    "  - {runtime: human, sessionId: fixture, boundAt: 2026-01-01T00:00:00.000Z}",
    `question: Question for ${id}?`,
    "chosen:",
    "  - {id: CH1, text: Fixture choice}",
    "rejected:",
    "  - {id: RJ1, text: Alternative, why_not: Not selected}",
    "claims:",
    "  - {id: C1, text: Fixture claim}",
    "relations: []",
    "---",
    "",
    `# ${id}`,
    ""
  ].join("\n"));
}

function decisionBodies(rootDir: string): ReadonlyArray<string> {
  return ["dec_AGENT", "dec_HUMAN", "dec_SYSTEM"].map((id) => readFileSync(path.join(rootDir, `harness/decisions/${id}/decision.md`), "utf8"));
}

function readEvents(eventRoot: string): ReadonlyArray<Record<string, any>> {
  if (!existsSync(eventRoot)) return [];
  return readdirSync(eventRoot).sort().map((name) => JSON.parse(readFileSync(path.join(eventRoot, name), "utf8")) as Record<string, any>);
}

function declarationArgs(personId: string): ReadonlyArray<string> {
  return ["migrate", "attribution", "--declare-principal", personId, "--declare-authority", "dec_AUTHORITY"];
}

function candidate(report: Record<string, any>, entityKind: string, entityId: string, role: string): Record<string, any> {
  const row = report.report.candidates.find((item: Record<string, any>) =>
    item.entityKind === entityKind && item.entityId === entityId && item.role === role
  );
  assert.ok(row, `missing candidate ${entityKind}/${entityId}:${role}`);
  return row;
}

function eventFor(events: ReadonlyArray<Record<string, any>>, entityId: string, kind: string): Record<string, any> {
  const event = events.find((item) => item.entityId === entityId && item.kind === kind);
  assert.ok(event, `missing event ${entityId}:${kind}`);
  return event;
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_ACTOR: "agent:fixture",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    return unwrapCommandReceipt(JSON.parse((error as { readonly stdout?: string }).stdout ?? "{}") as Record<string, any>);
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}
