// harness-test-tier: nightly
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pollUntil } from "../helpers/poll-until.ts";
import { runDaemonCommand, runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import type { ProductionCanonicalIngressFixture } from "./fixture.ts";

export async function verifyDecisionAttributionAfterRestart(
  fixture: ProductionCanonicalIngressFixture,
  userRoot: string,
  env: Readonly<Record<string, string>>,
  decisionId: string
): Promise<void> {
  const before = runDaemonCommand(
    fixture.repoRoot,
    ["daemon", "status", "--user-root", userRoot, "--json"],
    env
  );
  const refreshed = runDaemonCommand(fixture.repoRoot, [
    "daemon", "refresh", "--timeout-ms", "20000", "--user-root", userRoot, "--json"
  ], env);
  assert.equal(refreshed.accepted, true, JSON.stringify(refreshed));
  const after = await pollUntil(
    () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
    (status) => status.reachable === true && status.pid !== before.pid,
    (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
    { timeoutMs: 20_000 }
  );
  assert.notEqual(after.pid, before.pid, JSON.stringify({ before, after }));

  const { HARNESS_ACTOR: _agentActor, ...humanEnv } = env;
  const accepted = runRawJsonMaybeFail(fixture.repoRoot, [
    "--actor", "human:person_alice", "decision", "transition", "active", decisionId,
    "--judgment-only", "A human verified the persisted V2 propose attribution after restart."
  ], humanEnv);
  assert.equal(accepted.status, 0, JSON.stringify(accepted.receipt));
  assert.equal(accepted.receipt.ok, true, JSON.stringify(accepted.receipt));
  assert.match(readFileSync(path.join(
    fixture.authoredRoot, `decisions/decision-${decisionId}/decision.md`
  ), "utf8"), /^state: active$/mu);
}
