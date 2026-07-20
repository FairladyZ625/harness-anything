import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "../../../kernel/src/index.ts";
import { createGitCanonicalPublicationInspector } from "@harness-anything/daemon";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import {
  authorityEventBodies,
  authorityOperationRecords,
  latestAuthorityOperation,
  writeColdCodexSessionLog,
  type ProductionCanonicalIngressFixture
} from "./fixture.ts";

export async function verifyD22ClaimChain(input: {
  readonly fixture: ProductionCanonicalIngressFixture;
  readonly env: NodeJS.ProcessEnv;
  readonly taskId: string;
  readonly packagePath: string;
}): Promise<void> {
  const { fixture, taskId } = input;
  const claimSessionId = "service-task-claim-cold-session";
  const claimEnv = { ...input.env, CODEX_THREAD_ID: claimSessionId };
  writeColdCodexSessionLog(fixture.repoRoot, claimSessionId);
  assert.equal(existsSync(path.join(fixture.authoredRoot, `sessions/${claimSessionId}.md`)), false);
  const blockedBeforeClaim = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "progress", "append", taskId, "--text", "must remain blocked before claim"
  ], claimEnv);
  assert.equal(blockedBeforeClaim.status, 1, JSON.stringify(blockedBeforeClaim.receipt));
  assert.match(JSON.stringify(blockedBeforeClaim.receipt), /TASK_LEASE_REQUIRED|active lease/iu);

  const beforeColdClaim = authorityOperationRecords(fixture.serviceRoot).length;
  const coldClaimed = runRawJsonMaybeFail(fixture.repoRoot, ["task", "claim", taskId], claimEnv);
  assert.equal(coldClaimed.status, 0, JSON.stringify(coldClaimed.receipt));
  assert.equal(coldClaimed.receipt.ok, true, JSON.stringify(coldClaimed.receipt));
  const coldClaimReport = claimReport(coldClaimed.receipt.details);
  const executionId = String(coldClaimReport.executionId ?? "");
  const coldLeaseToken = String(coldClaimReport.leaseToken ?? "");
  assert.match(executionId, /^exe_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(coldClaimed.receipt));
  assert.equal(coldClaimReport.reused, false, JSON.stringify(coldClaimed.receipt));
  assert.match(coldLeaseToken, /^[0-9a-f]{64}$/u, JSON.stringify(coldClaimed.receipt));
  const claimOperation = latestAuthorityOperation(fixture.serviceRoot);
  assert.equal(claimOperation.state, "COMMITTED", JSON.stringify(claimOperation));
  assert.equal(claimOperation.receipt?.tag, "COMMITTED", JSON.stringify(claimOperation));
  assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeColdClaim + 1);
  const publication = await createGitCanonicalPublicationInspector(fixture.authoredRoot)
    .findPublicationForOperation(claimOperation.opId!);
  assert.equal(publication.commitSha, claimOperation.commitSha);
  assert.equal(publication.parentCommits.length, 2);
  assert.deepEqual(publication.physicalChanges.map((change) => change.path).sort(), [
    `attribution-events/${sha256Text(claimOperation.opId!)}.jsonl`,
    `${path.relative(fixture.authoredRoot, path.join(fixture.repoRoot, input.packagePath))}/executions/${executionId}.md`
  ].sort());
  assert.equal(publication.pipelineGeneratedPaths.length, 1);
  assert.equal(authorityEventBodies(fixture.authoredRoot).filter((body) => body.includes(claimOperation.opId!)).length, 1);
  const executionBody = readFileSync(path.join(fixture.repoRoot, input.packagePath, "executions", `${executionId}.md`), "utf8");
  assert.match(executionBody, new RegExp(`"session_ref": "session/${claimSessionId}"`, "u"));
  assert.equal(existsSync(path.join(fixture.authoredRoot, `sessions/${claimSessionId}.md`)), false,
    "claim binds the cold runtime session but must not fabricate a Session export");

  const progressed = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "progress", "append", taskId, "--text", "D22 create claim progress release chain"
  ], claimEnv);
  assert.equal(progressed.status, 0, JSON.stringify(progressed.receipt));
  assert.equal(progressed.receipt.ok, true, JSON.stringify(progressed.receipt));
  const exported = runRawJsonMaybeFail(fixture.repoRoot, [
    "session", "export", "--session", claimSessionId, "--runtime", "codex", "--source", "runtime",
    "--detected-at", "2026-07-17T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
  ], claimEnv);
  assert.equal(exported.status, 0, JSON.stringify(exported.receipt));

  const beforeHotClaim = authorityOperationRecords(fixture.serviceRoot).length;
  const hotClaimed = runRawJsonMaybeFail(fixture.repoRoot, ["task", "claim", taskId, "--execution"], claimEnv);
  assert.equal(hotClaimed.status, 0, JSON.stringify(hotClaimed.receipt));
  const hotReport = claimReport(hotClaimed.receipt.details);
  assert.equal(hotReport.executionId, executionId);
  assert.equal(hotReport.reused, true);
  assert.notEqual(hotReport.leaseToken, coldLeaseToken, "renewal must rotate the lease token");
  assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeHotClaim,
    "lease renewal must not fabricate a canonical mutation");

  const wrongRelease = runRawJsonMaybeFail(fixture.repoRoot, ["task", "release", taskId], {
    ...claimEnv,
    HARNESS_ACTOR: "agent:other-executor"
  });
  assert.equal(wrongRelease.status, 1, JSON.stringify(wrongRelease.receipt));
  assert.match(JSON.stringify(wrongRelease.receipt), /TASK_RELEASE_NOT_HOLDER|not the active holder/iu);
  const beforeRelease = authorityOperationRecords(fixture.serviceRoot).length;
  const released = runRawJsonMaybeFail(fixture.repoRoot, ["task", "release", taskId], claimEnv);
  assert.equal(released.status, 0, JSON.stringify(released.receipt));
  assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeRelease,
    "lease release must remain in the operational flush domain");
  const rejectedProgress = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "progress", "append", taskId, "--text", "must remain blocked after release"
  ], claimEnv);
  assert.equal(rejectedProgress.status, 1, JSON.stringify(rejectedProgress.receipt));
  assert.match(JSON.stringify(rejectedProgress.receipt), /TASK_LEASE_REQUIRED|active lease/iu);

  const beforeReclaim = authorityOperationRecords(fixture.serviceRoot).length;
  const reclaimed = runRawJsonMaybeFail(fixture.repoRoot, ["task", "claim", taskId, "--execution-id", executionId], claimEnv);
  assert.equal(reclaimed.status, 0, JSON.stringify(reclaimed.receipt));
  const reclaimReport = claimReport(reclaimed.receipt.details);
  assert.equal(reclaimReport.executionId, executionId);
  assert.equal(reclaimReport.reused, true);
  assert.notEqual(reclaimReport.leaseToken, hotReport.leaseToken);
  assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeReclaim,
    "upgrade reclaim of an existing execution must not create a second authored execution");
  const finalRelease = runRawJsonMaybeFail(fixture.repoRoot, ["task", "release", taskId], claimEnv);
  assert.equal(finalRelease.status, 0, JSON.stringify(finalRelease.receipt));
}

function claimReport(details: unknown): Record<string, unknown> {
  return (details as { readonly data?: { readonly report?: Record<string, unknown> } } | undefined)?.data?.report ?? {};
}
