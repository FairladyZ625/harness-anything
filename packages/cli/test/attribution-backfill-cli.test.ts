// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { queryDecisionProjection, rebuildTaskProjection } from "../../kernel/src/index.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("attribution backfill dry-run is deterministic and apply emits only exact-match migration events", () => {
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
    assert.equal(first.report.summary.unresolved, 5);
    assert.deepEqual(decisionBodies(rootDir), authoredBefore);
    assert.deepEqual(existsSync(eventRoot) ? readdirSync(eventRoot) : [], eventFilesBefore);

    const unconfirmed = runJson(rootDir, ["migrate", "attribution", "--apply"], false);
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.error.code, "plan_confirmation_required");
    assert.deepEqual(existsSync(eventRoot) ? readdirSync(eventRoot) : [], eventFilesBefore);

    const applied = runJson(rootDir, [
      "migrate", "attribution", "--apply", "--confirm-plan", String(first.report.planId)
    ]);
    assert.equal(applied.report.appliedEvents, 1);
    assert.deepEqual(decisionBodies(rootDir), authoredBefore);
    const migrationEvents = readEvents(eventRoot).filter((event) => event.principalSource.kind === "migration");
    assert.equal(migrationEvents.length, 1);
    assert.equal(migrationEvents[0]?.entityId, "decision/dec_HUMAN");
    assert.equal(migrationEvents[0]?.actor.principal.personId, "person_fixture");
    assert.equal(migrationEvents[0]?.actor.executor, null);
    assert.equal(migrationEvents[0]?.principalSource.kind, "migration");
    assert.equal(migrationEvents[0]?.principalSource.kind === "migration" && migrationEvents[0].principalSource.evidenceRef, first.report.reportDigest);
    assert.equal(migrationEvents[0]?.at, "2026-01-01T00:00:00.000Z");
    assert.notEqual(migrationEvents[0]?.recordedAt, migrationEvents[0]?.at);

    const afterRows = queryDecisionProjection({ rootDir, filters: {} }).rows;
    const migrated = afterRows.find((row) => row.decisionId === "dec_HUMAN")!;
    assert.equal(migrated.attribution.completeness, "complete");
    assert.equal(migrated.attribution.trailCount, 1);
    assert.equal(afterRows.find((row) => row.decisionId === "dec_AGENT")?.attribution.originator, null);
    assert.equal(afterRows.find((row) => row.decisionId === "dec_SYSTEM")?.attribution.originator, null);
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
    people: [{ personId: "person_fixture", displayName: "Fixture", primaryEmail: "fixture@example.test", roles: [] }],
    roles: []
  }));
  writeDecision(rootDir, "dec_HUMAN", "human", "person_fixture", "agent", "legacy-arbiter");
  writeDecision(rootDir, "dec_AGENT", "agent", "historical-agent", "human", "unknown-person");
  writeDecision(rootDir, "dec_SYSTEM", "system", "historical-cron", "agent", "legacy-arbiter");
  execFileSync("git", ["-C", harnessRoot, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "fixture"], { stdio: "ignore" });
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
