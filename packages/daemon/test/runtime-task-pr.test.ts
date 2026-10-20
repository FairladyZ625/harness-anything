// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskPullRequest } from "../src/runtime-task-pr.ts";
import { fixture, secret } from "./runtime-task-pr.fixtures.ts";

const CLOSEOUT_BODY = "# Closeout\n\n## Summary\n\nDelivered the channel change.\n";

function prFixture() {
  const f = fixture(),
    context = {
      ...f.context,
      store: { readHead: () => ({ revision: 42 }) },
      withHumanSummary: (receipt: unknown) => receipt,
      projection: {
        ...f.context.projection,
        read: () => ({
          ...f.context.projection.read(),
          packagePath: "tasks/task-pr",
          watermark: 42,
          sourceRevision: 42,
          snapshot: { ...f.context.projection.read().snapshot, task: { title: "Task CI" } },
        }),
        readDocument: (documentPath: string) => ({
          watermark: 42,
          sourceRevision: 42,
          document: {
            body: documentPath.endsWith("task-contract.json")
              ? JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] })
              : CLOSEOUT_BODY,
            workspaceRevision: 42,
            blobSha256: "accepted-body",
          },
        }),
      },
    };
  return { ...f, context };
}

for (const update of [false, true])
  test(`task PR ${update ? "update" : "create"} defaults the body to the task closeout`, async () => {
    const f = prFixture();
    let calls = 0;
    const receipt = await createTaskPullRequest(
      f.context as never,
      { kind: "task-pr", taskId: "task-pr", update, ...(update ? {} : { title: "fix(daemon): publish task PR" }) },
      f.binding,
      async (args, env, cwd) => {
        calls++;
        assert.equal(env.GH_TOKEN, secret);
        assert.equal(cwd, "/fixture/center");
        assert.equal(args[1], update ? "edit" : "create");
        assert.equal(args[args.indexOf("--body") + 1], CLOSEOUT_BODY);
        assert.equal(args.includes("task-pr"), true);
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
    assert.deepEqual(receipt.next, [
      {
        command: `ha task pr task-pr --wait-ci`,
        reason: "the single quiet CI wait; it prints one line and its exit 0/1/2 says green/failed/timeout",
      },
    ]);
  });

test("task PR prefers the worker's --body-file over the closeout default", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-pr-file-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "harness", "tasks", "task-pr"), { recursive: true });
  const bodyFile = "harness/tasks/task-pr/body.md",
    body = "# Repository PR convention\n\nSingle-language body from the delivered repository.\n";
  writeFileSync(path.join(rootDir, bodyFile), body);
  const f = prFixture(),
    seen: string[] = [];
  await createTaskPullRequest(
    { ...f.context, rootDir } as never,
    { kind: "task-pr", taskId: "task-pr", title: "fix(daemon): body from file", bodyFile },
    f.binding,
    async (args) => {
      seen.push(args[args.indexOf("--body") + 1]!);
      return "https://github.com/fixture/repo/pull/6";
    },
  );
  assert.deepEqual(seen, [body]);
  await assert.rejects(
    createTaskPullRequest(
      { ...f.context, rootDir } as never,
      {
        kind: "task-pr",
        taskId: "task-pr",
        title: "fix(daemon): missing file",
        bodyFile: "harness/tasks/task-pr/gone.md",
      },
      f.binding,
      async () => {
        throw new Error("provider must not run");
      },
    ),
    (error: Error & { readonly code?: string }) =>
      error.code === "invalid_command" && error.message.includes("readable UTF-8 file"),
  );
});

test("task PR rejects non-conventional titles before reading credentials", async () => {
  const f = prFixture();
  await assert.rejects(
    createTaskPullRequest(
      f.context as never,
      { kind: "task-pr", taskId: "task-pr", title: "中文任务名" },
      f.binding,
      async () => {
        throw new Error("provider must not run");
      },
    ),
    (error: Error & { code?: string; message: string }) =>
      error.code === "invalid_field" && error.message.includes("feat|fix|refactor|perf|test|docs|chore|ci"),
  );
  assert.equal(f.credentialReads(), 0);
});

test("task PR update validates and forwards an optional title", async () => {
  const f = prFixture();
  let args: readonly string[] = [];
  await createTaskPullRequest(
    f.context as never,
    { kind: "task-pr", taskId: "task-pr", update: true, title: "docs(daemon): clarify PR title" },
    f.binding,
    async (received) => {
      args = received;
      return "https://github.com/fixture/repo/pull/4";
    },
  );
  assert.deepEqual(args.slice(0, 5), ["pr", "edit", "task-pr", "--title", "docs(daemon): clarify PR title"]);
});

test("task PR refuses another task or reviewer before invoking the provider", async () => {
  for (const [taskId, role] of [
    ["task-other", "implementation"],
    ["task-pr", "reviewer"],
  ] as const) {
    const f = prFixture();
    await assert.rejects(
      createTaskPullRequest(
        f.context as never,
        { kind: "task-pr", taskId, title: "fix(daemon): unauthorized PR" },
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
    createTaskPullRequest(
      f.context as never,
      { kind: "task-pr", taskId: "task-pr", title: "fix(daemon): redact provider error" },
      f.binding,
      async () => {
        throw new Error(`provider rejected ${secret}`);
      },
    ),
    (error: Error & { code?: string }) => error.code === "delivery_publish_failed" && !error.message.includes(secret),
  );
});

test("human task PR uses repository authentication without a dispatch credential", async () => {
  const f = prFixture();
  let prepared = false;
  const context = {
    ...f.context,
    input: {
      prepareDaemonGitEnvironment: async () => {
        prepared = true;
        throw new Error("human task PR must not resolve an execution instance credential");
      },
    },
  };
  const receipt = await createTaskPullRequest(
    context as never,
    { kind: "task-pr", taskId: "task-pr", title: "fix(daemon): use human repository identity" },
    { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" },
    async (_args, env) => {
      assert.equal(env.GH_TOKEN, undefined);
      return "https://github.com/fixture/repo/pull/5";
    },
  );
  assert.equal(prepared, false);
  assert.match(receipt.evidence!, /pull\/5/u);
});
