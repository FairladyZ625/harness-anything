// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExecutionV1 } from "@harness-anything/kernel";
import { reviewPacket } from "../src/repo-cell-packets.ts";
import { reviewDispatchPrompt } from "../src/task-review-dispatch.ts";

const sha256 = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

/** A store stub serving every artifact of one accepted revision, as readSubmissionArtifact resolves it. */
function cellFor(artifacts: Readonly<Record<string, string>>) {
  return {
    store: {
      readEventAtRevision: (revision: number) => ({
        schema: "doc-event/v1",
        workspaceRevision: revision,
        opId: `op-accept-${String(revision)}`,
        payload: {
          changes: Object.entries(artifacts).map(([path, body]) => ({ path, candidate: { sha256: sha256(body) } })),
        },
      }),
      readContentBlob: (blob: string) =>
        Buffer.from(Object.values(artifacts).find((body) => sha256(body) === blob) ?? "", "utf8"),
    },
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  };
}

test("review prompts truncate oversized artifact bodies and keep the frozen anchor for retrieval", () => {
  const packagePath = "tasks/task-review-prompt-bounds",
    bigBody = `REVIEW-ARTIFACT-HEAD\n${"raw evidence line\n".repeat(2000)}REVIEW-ARTIFACT-TAIL\n`,
    smallBody = "REVIEW-SMALL-ARTIFACT-FULL-BODY\n",
    cell = cellFor({
      [`${packagePath}/artifacts/raw-evidence.txt`]: bigBody,
      [`${packagePath}/artifacts/report.md`]: smallBody,
    }),
    execution = {
      executionId: "exe_review_bounds",
      iteration: 1,
      deliveryBaseline: { kind: "commit", commitSha: "b".repeat(40) },
      submission: {
        artifacts: [
          { path: "artifacts/raw-evidence.txt", revision: 1, blobSha256: sha256(bigBody) },
          { path: "artifacts/report.md", revision: 1, blobSha256: sha256(smallBody) },
        ],
      },
    } as unknown as ExecutionV1;
  const prompt = reviewDispatchPrompt({
    cell: cell as never,
    taskId: "task_review_bounds",
    packagePath,
    dispatchId: "dispatch_reviewbounds000001",
    execution,
    gates: [],
  });
  assert.match(prompt, /Independently review task task_review_bounds/u);
  assert.match(prompt, /JSON required fields: verdict, reason, evidenceChecked/u);
  assert.match(prompt, /verdict: approved\|changes_requested\|dismissed/u);
  assert.doesNotMatch(prompt, /Owner adjudication context/u);
  assert.match(prompt, /execution-frozen delivery baseline.*b{40}/u);
  assert.match(prompt, /Read the G33 production-delta result/u);
  assert.match(prompt, /REVIEW-ARTIFACT-HEAD/u);
  assert.doesNotMatch(prompt, /REVIEW-ARTIFACT-TAIL/u);
  assert.match(prompt, /bodyTruncatedFromChars/u);
  assert.match(prompt, /REVIEW-SMALL-ARTIFACT-FULL-BODY/u);
  assert.match(prompt, new RegExp(sha256(bigBody), "u"));
});

test("review input accepts the dispatched field contract and rejects persisted-record metadata", () => {
  const value = { verdict: "approved", reason: "Checked the frozen delivery.", evidenceChecked: ["closeout.md"] };
  assert.deepEqual(
    reviewPacket("/unused", { kind: "task-review-execution", jsonInput: JSON.stringify(value) }).value,
    value,
  );
  for (const metadata of [{ schema: "review/v1" }, { taskId: "task_1" }, { executionId: "exe_1" }, { findings: [] }])
    assert.throws(
      () =>
        reviewPacket("/unused", {
          kind: "task-review-execution",
          jsonInput: JSON.stringify({ ...value, ...metadata }),
        }),
      /Review JSON requires exactly/u,
    );
});

test("resolved fleet review packets preserve the local packet validation and digest", () => {
  const value = { verdict: "approved", reason: "Checked the wire cut.", evidenceChecked: ["tests"] };
  const resolved = { kind: "task-review-execution", taskId: "task_one", reviewId: "review_one", ...value };
  assert.deepEqual(
    reviewPacket("/unused", resolved),
    reviewPacket("/unused", {
      kind: "task-review-execution",
      jsonInput: JSON.stringify(value),
    }),
  );
  assert.throws(() => reviewPacket("/unused", { ...resolved, principal: "client" }), /Review JSON requires exactly/u);
  const { evidenceChecked: _evidence, ...missing } = resolved;
  assert.throws(() => reviewPacket("/unused", missing), /Review JSON requires exactly/u);
});
