// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";

import { selectExecutorDeclaration, type TaskAuthoringExecutorCandidate } from "../src/dispatch-read.ts";

const candidate = (
  runtimeSessionId: string,
  overrides: Partial<TaskAuthoringExecutorCandidate> = {},
): TaskAuthoringExecutorCandidate => ({
  runtimeSessionId,
  executorId: `runtime-session:${runtimeSessionId}`,
  agentId: undefined,
  dispatchTaskId: "task-current",
  executionId: "exec-current",
  ...overrides,
});

const reviewerIdentities = new Set(["rev-1", "runtime-session:rev-1", "reviewer-agent"]);

test("an unrelated parent dispatch does not block an explicit external author declaration", () => {
  const selection = selectExecutorDeclaration({
    requested: "codex-gpt-6.1-sol",
    exact: [],
    fallback: [candidate("parent-author", { executionId: "exec-parent", dispatchTaskId: "task-parent" })],
    reviewerIdentities,
  });
  assert.deepEqual(selection, { kind: "external", executorId: "codex-gpt-6.1-sol" });
});

test("an explicit agent that matches the fallback dispatch replays it instead", () => {
  const parent = candidate("parent-author", { executionId: "exec-parent", dispatchTaskId: "task-parent" }),
    selection = selectExecutorDeclaration({
      requested: "parent-author",
      exact: [],
      fallback: [parent],
      reviewerIdentities,
    });
  assert.deepEqual(selection, { kind: "replay", candidate: parent });
});

test("an execution with its own dispatch cannot be reassigned to an unrelated external agent", () => {
  const selection = selectExecutorDeclaration({
    requested: "codex-gpt-6.1-sol",
    exact: [candidate("author")],
    fallback: [candidate("author")],
    reviewerIdentities,
  });
  assert.deepEqual(selection, {
    kind: "choose",
    requested: "codex-gpt-6.1-sol",
    choices: ["runtime-session:author"],
  });
});

test("several exact dispatches require one of the exact candidates", () => {
  const selection = selectExecutorDeclaration({
    exact: [candidate("author-a"), candidate("author-b")],
    fallback: [candidate("author-a"), candidate("author-b")],
    reviewerIdentities,
  });
  assert.deepEqual(selection, {
    kind: "choose",
    requested: undefined,
    choices: ["runtime-session:author-a", "runtime-session:author-b"],
  });
});

test("no candidate and no requested agent asks the caller to name one", () => {
  assert.deepEqual(selectExecutorDeclaration({ exact: [], fallback: [], reviewerIdentities }), {
    kind: "owner-declaration-required",
  });
});

test("accepted identity spellings normalize before matching a dispatch", () => {
  const author = candidate("author"),
    selection = selectExecutorDeclaration({
      requested: "agent:runtime-session:author",
      exact: [author],
      fallback: [author],
      reviewerIdentities,
    });
  assert.deepEqual(selection, { kind: "replay", candidate: author });
});

test("every reviewer identity spelling is refused before candidate matching", () => {
  const cases = [
    ["rev-1", "rev-1"],
    ["runtime-session:rev-1", "runtime-session:rev-1"],
    ["agent:runtime-session:rev-1", "runtime-session:rev-1"],
    ["reviewer-agent", "reviewer-agent"],
  ] as const;
  for (const [requested, normalized] of cases)
    assert.deepEqual(
      selectExecutorDeclaration({
        requested,
        exact: [],
        fallback: [],
        reviewerIdentities,
      }),
      { kind: "reviewer-alias", requested: normalized },
      requested,
    );
});
