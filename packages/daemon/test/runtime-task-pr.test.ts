// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createTaskPullRequest } from "../src/runtime-task-pr.ts";
import { fixture, secret } from "./task-ci.fixtures.ts";

function prFixture() {
  const f = fixture(),
    body = "# English\nAccepted body\n---\n# 中文\n已接受正文";
  const context = {
    ...f.context,
    store: { readHead: () => ({ revision: 42 }) },
    withHumanSummary: (receipt: unknown) => receipt,
    projection: {
      ...f.context.projection,
      read: () => ({
        ...f.context.projection.read(),
        packagePath: "tasks/task-ci-ci",
        watermark: 42,
        sourceRevision: 42,
        snapshot: { ...f.context.projection.read().snapshot, task: { title: "Task CI" } },
      }),
      readDocument: (path: string) => ({
        watermark: 42,
        sourceRevision: 42,
        document: {
          body: path.endsWith("task-contract.json")
            ? JSON.stringify({ documents: [{ slot: "task.pr-body", path: "artifacts/pr-body.md" }] })
            : body,
          workspaceRevision: 42,
          blobSha256: "accepted-body",
        },
      }),
    },
  };
  return { ...f, context, body };
}

for (const update of [false, true])
  test(`task PR ${update ? "update" : "create"} uses accepted body and only its own branch`, async () => {
    const f = prFixture();
    let calls = 0;
    const receipt = await createTaskPullRequest(
      f.context as never,
      { kind: "task-pr", taskId: "task-ci", update },
      f.binding,
      async (args, env, cwd) => {
        calls++;
        assert.equal(env.GH_TOKEN, secret);
        assert.equal(cwd, "/fixture/center");
        assert.equal(args[1], update ? "edit" : "create");
        assert.equal(args[args.indexOf("--body") + 1], f.body);
        assert.equal(args.includes("task-ci"), true);
        assert.equal(args.includes("merge"), false);
        assert.equal(
          args.some((arg) => arg.includes(secret)),
          false,
        );
        return "https://github.com/fixture/repo/pull/1";
      },
    );
    assert.equal(calls, 1);
    assert.match(receipt.evidence!, /pull\/1/u);
  });

test("task PR refuses another task or reviewer before invoking the provider", async () => {
  for (const [taskId, role] of [
    ["task-other", "implementation"],
    ["task-ci", "reviewer"],
  ] as const) {
    const f = prFixture();
    await assert.rejects(
      createTaskPullRequest(
        f.context as never,
        { kind: "task-pr", taskId },
        { ...f.binding, executionPrincipal: { ...f.binding.executionPrincipal, role } },
        async () => {
          throw new Error("provider must not run");
        },
      ),
      { code: "execution_credential_rejected" },
    );
    assert.equal(f.credentialReads(), 0);
  }
});

test("task PR provider errors surface with credentials removed", async () => {
  const f = prFixture();
  await assert.rejects(
    createTaskPullRequest(f.context as never, { kind: "task-pr", taskId: "task-ci" }, f.binding, async () => {
      throw new Error(`provider rejected ${secret}`);
    }),
    (error: Error & { code?: string }) => error.code === "delivery_publish_failed" && !error.message.includes(secret),
  );
});
