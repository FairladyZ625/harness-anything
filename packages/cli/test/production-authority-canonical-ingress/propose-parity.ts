import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import { git, type ProductionCanonicalIngressFixture } from "./fixture.ts";

export function verifyDecisionProposeParity(
  fixture: ProductionCanonicalIngressFixture,
  env: NodeJS.ProcessEnv
): void {
  const generated = runRawJsonMaybeFail(fixture.repoRoot, [
    "decision", "propose", "--title", "Generated ingress decision id",
    "--question", "Does parser completion cross the daemon wire?",
    "--chosen", "Generate once before transport", "--rejected", "Generate inside the application runner",
    "--why-not", "The compiler must observe the same id", "--claim", "The generated id is present in the transported action"
  ], env);
  assert.equal(generated.status, 0, JSON.stringify(generated.receipt));
  assert.equal(generated.receipt.ok, true, JSON.stringify(generated.receipt));
  const generatedId = decisionId(generated.receipt);
  assert.match(generatedId, /^dec_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(generated.receipt));
  assert.equal(existsSync(path.join(fixture.authoredRoot, `decisions/decision-${generatedId}/decision.md`)), true);

  const fallback = runRawJsonMaybeFail(fixture.repoRoot, [
    "decision", "propose", "--title", "Fallback ingress decision claim",
    "--question", "Does chosen text become the default claim before transport?",
    "--chosen", "Use the chosen text as claim", "--rejected", "Leave claims empty",
    "--why-not", "The authority payload requires a claim"
  ], env);
  assert.equal(fallback.status, 0, JSON.stringify(fallback.receipt));
  assert.equal(fallback.receipt.ok, true, JSON.stringify(fallback.receipt));
  const fallbackId = decisionId(fallback.receipt);
  assert.match(fallbackId, /^dec_[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.match(readFileSync(path.join(fixture.authoredRoot, `decisions/decision-${fallbackId}/decision.md`), "utf8"),
    /id: "C1", text: "Use the chosen text as claim"/u);

  const manual = runRawJsonMaybeFail(fixture.repoRoot, [
    "decision", "propose", "--id", "dec_01KXT3E1MN1VBS64DCNZ4VX81C",
    "--title", "Caller-selected ingress identity", "--question", "Who allocates the id?",
    "--chosen", "Canonical ingress", "--rejected", "The caller", "--why-not", "Identity must be generated"
  ], env);
  assert.equal(manual.status, 1, JSON.stringify(manual.receipt));
  assert.equal(manual.receipt.error?.code, "authority_ingress_rejected", JSON.stringify(manual.receipt));
  assert.match(manual.receipt.error?.hint ?? "", /omit --id/u);

  const unsupported = runRawJsonMaybeFail(fixture.repoRoot, [
    "decision", "amend", fallbackId, "--title", "Unsupported ingress probe"
  ], env);
  assert.equal(unsupported.status, 1, JSON.stringify(unsupported.receipt));
  assert.equal(unsupported.receipt.error?.code, "authority_ingress_rejected", JSON.stringify(unsupported.receipt));
  assert.doesNotMatch(JSON.stringify(unsupported.receipt), /JournalUnavailable/u);

  const before = git(fixture.authoredRoot, "rev-parse", "HEAD");
  const dryRun = runRawJsonMaybeFail(fixture.repoRoot, [
    "decision", "propose", "--title", "Dry-run ingress decision",
    "--question", "Does daemon dry-run satisfy the decision receipt contract?",
    "--chosen", "Return complete receipt data", "--rejected", "Return a partial receipt",
    "--why-not", "Partial receipts are contract violations", "--dry-run"
  ], env);
  assert.equal(dryRun.status, 0, JSON.stringify(dryRun.receipt));
  assert.equal(dryRun.receipt.ok, true, JSON.stringify(dryRun.receipt));
  assert.match(decisionId(dryRun.receipt), /^dec_[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.equal(git(fixture.authoredRoot, "rev-parse", "HEAD"), before);
}

function decisionId(receipt: { readonly details?: unknown }): string {
  return String((receipt.details as { readonly data?: { readonly decisionId?: string } } | undefined)?.data?.decisionId ?? "");
}
