import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGitCanonicalPublicationInspector } from "../../../daemon/src/index.ts";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import { git, latestAuthorityOperation } from "./fixture.ts";

interface CanonicalFixtureRoots {
  readonly authoredRoot: string;
  readonly publicHead: string;
  readonly repoRoot: string;
  readonly serviceRoot: string;
}

export async function exerciseIdenticalCodeDocForce(
  fixture: CanonicalFixtureRoots,
  taskId: string,
  env: Readonly<Record<string, string>>
): Promise<string> {
  const taskRoot = path.join(fixture.authoredRoot, `tasks/${taskId}-production-route`);
  const closeoutPath = path.join(taskRoot, "closeout.md");
  writeFileSync(closeoutPath, `${readFileSync(closeoutPath, "utf8")}\nAmended after implementation review.\n`);
  git(fixture.authoredRoot, "add", `tasks/${taskId}-production-route/closeout.md`);
  git(fixture.authoredRoot, "commit", "-q", "-m", "amend closeout before force reconciliation");

  const forceArgs = [
    "task", "code-doc", "reconcile", taskId,
    "--commit", fixture.publicHead, "--path", "README.md",
    "--pr", "https://github.com/example/repo/pull/999", "--force"
  ];
  const forced = runRawJsonMaybeFail(fixture.repoRoot, forceArgs, env);
  assert.equal(forced.status, 0, JSON.stringify(forced.receipt));
  assert.equal(forced.receipt.ok, true, JSON.stringify(forced.receipt));
  const forcedOperation = latestAuthorityOperation(fixture.serviceRoot);
  assert.equal(forcedOperation.canonicalOperation?.kind, "code_doc_reconcile", JSON.stringify(forcedOperation));
  assert.equal(forcedOperation.state, "COMMITTED", JSON.stringify(forcedOperation));
  assert.equal(forcedOperation.receipt?.tag, "COMMITTED", JSON.stringify(forcedOperation));
  const forcedPublication = await createGitCanonicalPublicationInspector(fixture.authoredRoot)
    .findPublicationForOperation(forcedOperation.opId!);
  assert.equal(forcedPublication.commitSha, forcedOperation.commitSha, "force after closeout change");

  const identicalForce = runRawJsonMaybeFail(fixture.repoRoot, forceArgs, env);
  assert.notEqual(identicalForce.status, 0, JSON.stringify(identicalForce.receipt));
  assert.equal(identicalForce.receipt.ok, false, JSON.stringify(identicalForce.receipt));
  assert.match(JSON.stringify(identicalForce.receipt), /produced no authored change/u);
  assert.doesNotMatch(
    JSON.stringify(identicalForce.receipt),
    /repo_write_outcome_unknown|execution_outcome_unknown|outcome remains unknown/u
  );
  return taskRoot;
}
