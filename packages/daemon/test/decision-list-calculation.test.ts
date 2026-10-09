// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DecisionProjectionRow } from "@harness-anything/kernel";
import { dispatchRead } from "../src/repo-cell-command.ts";
import type { DecisionListFilters } from "@harness-anything/kernel";
import { createRepoCellApi, type RepoCellApiContext } from "../src/repo-cell-api.ts";

function decision(decisionId: string): DecisionProjectionRow {
  return {
    decisionId,
    proposedAt: "2026-01-01T00:00:00.000Z",
    appliesTo: { modules: [], productLines: [] },
    title: "Probe",
    state: "in_effect",
    riskTier: "low",
    urgency: "low",
    body: null,
    reviews: [],
  } as unknown as DecisionProjectionRow;
}

test("full decision lists reuse Git calculation across unrelated cuts and invalidate every readiness input", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-cache-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  let rows = [decision("dec_a")],
    revision = 1,
    lists = 0;
  const cell = createRepoCellApi({
    extracted: {},
    mode: "local",
    fleetRoster: null,
    input: { repoId: "probe" },
    state: "attached",
    rootDir,
    settings: { readRepository: () => ({ decisionReviewRequirement: "all" }) },
    dispatchRead,
    projection: {
      listDecisions: (filters: DecisionListFilters) => {
        lists += 1;
        assert.equal(filters.withBody, true);
        return { decisions: rows, sourceRevision: revision };
      },
      readDecisions: () => {
        throw new Error("duplicate hydration");
      },
      readCut: () => ({ sourceRevision: revision }),
      readRuntimeDispatchesByDecision: () => [],
    },
  } as unknown as RepoCellApiContext);
  const read = () => cell.read("repo.decisions.list", { projection: "full" });
  let previous = (await read()).decisions[0]!.readiness;
  revision += 1;
  assert.equal((await read()).decisions[0]!.readiness, previous, "unrelated writes must reuse Git calculation");
  for (const changed of [
    { proposedAt: "2026-02-01T00:00:00.000Z" },
    { appliesTo: { modules: ["nonexistent-module"], productLines: [] } },
    { appliesTo: { modules: [], productLines: ["product"] } },
    { decisionId: "dec_b" },
  ]) {
    rows = [{ ...rows[0]!, ...changed }];
    const current = (await read()).decisions[0]!.readiness;
    assert.notEqual(current, previous, JSON.stringify(changed));
    previous = current;
  }
  rows.push(decision("dec_c"));
  assert.notEqual((await read()).decisions[0]!.readiness, previous, "new decisions invalidate the calculation");
  previous = (await read()).decisions[0]!.readiness;
  rows.reverse();
  assert.notEqual((await read()).decisions[1]!.readiness, previous, "row order is part of the positional result");
  const full = await read();
  assert.equal(full.decisions[0]!.body, null, "authored body must stay on server");
  previous = full.decisions[0]!.readiness;
  git("commit", "--allow-empty", "-qm", "next Git cut");
  const changedCut = (await read()).decisions[0]!.readiness;
  assert.notEqual(changedCut, previous, "new canonical Git cut invalidates readiness");
  assert.equal(changedCut?.basisCommitSha, git("rev-parse", "HEAD"));
  assert.equal(lists, 11);
});
