import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pollUntil } from "../helpers/poll-until.ts";
import { runDaemonCommand, runRawJsonMaybeFail, stopDaemon } from "../helpers/daemon-cli.ts";
import type { ProductionCanonicalIngressFixture } from "./fixture.ts";

export async function verifyDecisionAttributionAfterRestart(
  fixture: ProductionCanonicalIngressFixture,
  userRoot: string,
  env: Readonly<Record<string, string>>,
  decisionId: string
): Promise<void> {
  await stopDaemon(fixture.repoRoot, userRoot);
  runDaemonCommand(fixture.repoRoot, [
    "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
  ], env);
  await pollUntil(
    () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
    (status) => status.reachable === true,
    (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
    { timeoutMs: 20_000 }
  );

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
