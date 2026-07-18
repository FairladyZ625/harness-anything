import assert from "node:assert/strict";
import { productionAuthorityTypedIngressKinds } from "../../src/cli/command-spec/index.ts";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import { type ProductionCanonicalIngressFixture, writeColdCodexSessionLog } from "./fixture.ts";

interface MinimalCase {
  readonly argv: ReadonlyArray<string>;
  readonly outcome: "success" | "guided-error";
}

export function verifyTypedMinimalParameterMatrix(
  fixture: ProductionCanonicalIngressFixture,
  env: NodeJS.ProcessEnv
): void {
  const missingTask = "task_01KXT3E1MN1VBS64DCNZ4VX81B";
  const missingExecution = "exe_01KXT3E1MN1VBS64DCNZ4VX81C";
  const missingDecision = "dec_01KXT3E1MN1VBS64DCNZ4VX81D";
  const cases: Readonly<Record<string, MinimalCase>> = {
    "session-export": { argv: ["session", "export"], outcome: "success" },
    "new-task": { argv: ["task", "create", "--title", "Minimal ingress task"], outcome: "success" },
    "task-claim": { argv: ["task", "claim", missingTask], outcome: "guided-error" },
    "status-set": { argv: ["task", "transition", missingTask, "active"], outcome: "guided-error" },
    "progress-append": { argv: ["task", "progress", "append", missingTask, "--text", "minimal"], outcome: "guided-error" },
    "task-amend": { argv: ["task", "amend", missingTask, "--set", "queue:ready"], outcome: "guided-error" },
    "task-archive": { argv: ["task", "archive", missingTask, "--reason", "minimal"], outcome: "guided-error" },
    "task-supersede": { argv: ["task", "supersede", missingTask, "--by", "task_01KXT3E1MN1VBS64DCNZ4VX81E", "--confirm", missingTask, "--reason", "minimal"], outcome: "guided-error" },
    "task-delete": { argv: ["task", "delete", "--soft", missingTask, "--reason", "minimal"], outcome: "guided-error" },
    "task-reopen": { argv: ["task", "reopen", missingTask, "--reason", "minimal"], outcome: "guided-error" },
    "task-relate": { argv: ["task", "relate", missingTask, "depends-on", "task_01KXT3E1MN1VBS64DCNZ4VX81E", "--rationale", "minimal"], outcome: "guided-error" },
    "task-code-doc-reconcile": { argv: ["task", "code-doc", "reconcile", missingTask, "--commit", fixture.publicHead, "--path", "README.md"], outcome: "guided-error" },
    "task-consent-record": { argv: ["task", "consent-record", missingTask, "--execution-id", missingExecution, "--utterance", "Approved"], outcome: "guided-error" },
    "task-review-execution": { argv: ["task", "review-execution", missingTask, "--execution-id", missingExecution, "--verdict", "dismissed", "--findings", "none", "--rationale", "minimal"], outcome: "guided-error" },
    "task-complete": { argv: ["task", "complete", missingTask], outcome: "guided-error" },
    "decision-propose": { argv: ["decision", "propose", "--title", "Minimal ingress decision", "--question", "Minimal?", "--chosen", "Yes", "--rejected", "No", "--why-not", "Not selected"], outcome: "success" },
    "decision-transition": { argv: ["decision", "transition", "rejected", missingDecision], outcome: "guided-error" },
    "decision-relate": { argv: ["decision", "relate", missingDecision, "--anchor", "CH1", "--type", "derives", "--target", `task/${missingTask}`, "--rationale", "minimal"], outcome: "guided-error" },
    "decision-amend": { argv: ["decision", "amend", missingDecision, "--title", "Minimal amendment"], outcome: "guided-error" },
    "decision-relation-retire": { argv: ["decision", "relation", "retire", missingDecision, "--relation", "rel_0123456789abcdef"], outcome: "guided-error" },
    "decision-relation-replace": { argv: ["decision", "relation", "replace", missingDecision, "--relation", "rel_0123456789abcdef", "--anchor", "CH1", "--type", "relates", "--target", "decision/dec_MISSING", "--rationale", "minimal"], outcome: "guided-error" },
    "record-fact": { argv: ["fact", "record", "--task", missingTask, "--statement", "Minimal fact"], outcome: "guided-error" },
    "fact-invalidate": { argv: ["fact", "invalidate", "--task", missingTask, "--id", "F-DEADBEEF", "--by", "F-FEEDFACE", "--rationale", "minimal"], outcome: "guided-error" },
    "module-register": { argv: ["module", "register", "minimal", "--title", "Minimal ingress", "--scope", "packages/minimal/**"], outcome: "success" },
    "module-unregister": { argv: ["module", "unregister", "missing"], outcome: "guided-error" },
    "module-step": { argv: ["module", "step", "missing", "M-1", "--state", "done"], outcome: "guided-error" }
  };
  assert.deepEqual(Object.keys(cases).sort(), productionAuthorityTypedIngressKinds());

  const sessionId = "minimal-parameter-matrix";
  writeColdCodexSessionLog(fixture.repoRoot, sessionId);
  const matrixEnv = { ...env, CODEX_THREAD_ID: sessionId };
  for (const [kind, candidate] of Object.entries(cases)) {
    const result = runRawJsonMaybeFail(fixture.repoRoot, candidate.argv, matrixEnv);
    if (candidate.outcome === "success") {
      assert.equal(result.status, 0, `${kind}:${JSON.stringify(result.receipt)}`);
      assert.equal(result.receipt.ok, true, `${kind}:${JSON.stringify(result.receipt)}`);
      continue;
    }
    assert.notEqual(result.status, 0, `${kind}:${JSON.stringify(result.receipt)}`);
    assert.equal(result.receipt.ok, false, `${kind}:${JSON.stringify(result.receipt)}`);
    const hint = result.receipt.error?.hint ?? "";
    assert.equal(hint.length >= 16, true, `${kind}: missing guided error: ${JSON.stringify(result.receipt)}`);
    assert.match(hint, /(?:use|run|create|claim|record|submit|retry|requires?|not found|missing|resolve|existing)/iu, `${kind}:${hint}`);
  }
}
