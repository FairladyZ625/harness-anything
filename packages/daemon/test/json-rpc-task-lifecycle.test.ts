// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import type { JsonRpcRequest } from "../src/index.ts";
import {
  emptyLocalController,
  makeServer,
  readFixture,
  resultReceipt,
  rosterIdentityOptions,
  sampleRoster
} from "./json-rpc-protocol-fixtures.ts";

test("generic Task lifecycle RPC routes preserve mandatory review and completion rejections", async () => {
  let writeAttempts = 0;
  const roster = sampleRoster();
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    },
    services: {
      LocalControllerService: {
        ...emptyLocalController(),
        setTaskStatus: async (payload) => {
          writeAttempts += 1;
          return payload.status === "in_review"
            ? { ok: false, error: { code: "execution_submission_required", hint: "submit the active Execution" } }
            : {
                ok: false,
                error: {
                  code: "terminal_status_requires_task_complete",
                  hint: "Preferred path: ha task complete task-1 --approve. If already terminal, use ha task supersede task-1."
                }
              };
        },
        reviewTask: async () => {
          writeAttempts += 1;
          return { ok: false, error: { code: "execution_submission_required", hint: "use task review-execution" } };
        }
      },
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const request = (id: string, method: string, payload: Record<string, unknown>): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id,
    method,
    params: { repo: { repoId: "canonical" }, payload }
  });
  const inReview = resultReceipt(await server.handle(request("status-in-review", "repo.tasks.status.set", {
    taskId: "task-1",
    status: "in_review"
  })));
  const done = resultReceipt(await server.handle(request("status-done", "repo.tasks.status.set", {
    taskId: "task-1",
    status: "done"
  })));
  const legacyReview = resultReceipt(await server.handle(request("legacy-review", "repo.tasks.review", {
    taskId: "task-1"
  })));

  assert.equal(inReview.ok, false);
  assert.equal(inReview.error?.code, "execution_submission_required");
  assert.equal(done.ok, false);
  assert.equal(done.error?.code, "terminal_status_requires_task_complete");
  assert.match(done.error?.hint ?? "", /ha task complete task-1 --approve/u);
  assert.match(done.error?.hint ?? "", /supersede/u);
  assert.equal(legacyReview.ok, false);
  assert.equal(legacyReview.error?.code, "execution_submission_required");
  assert.equal(writeAttempts, 3);
});
