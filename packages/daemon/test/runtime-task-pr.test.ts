// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskPullRequest } from "../src/runtime-task-pr.ts";
import { fixture, secret } from "./task-ci.fixtures.ts";

const lintPass = async () => {};

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
      lintPass,
    );
    assert.equal(calls, 1);
    assert.match(receipt.evidence!, /pull\/1/u);
  });

test("task PR runs the bilingual gate on the body before the provider", async () => {
  const f = prFixture();
  let linted: string | null = null;
  const receipt = await createTaskPullRequest(
    f.context as never,
    { kind: "task-pr", taskId: "task-ci" },
    f.binding,
    async () => "https://github.com/fixture/repo/pull/3",
    async (body, rootDir) => {
      linted = body;
      assert.equal(rootDir, "/fixture/center");
    },
  );
  assert.equal(linted, f.body);
  assert.match(receipt.evidence!, /pull\/3/u);
});

test("task PR refuses a placeholder-only body, names the sections, and never calls the provider", async () => {
  const f = prFixture();
  const context = {
    ...f.context,
    projection: {
      ...f.context.projection,
      readDocument: (documentPath: string) => ({
        watermark: 42,
        sourceRevision: 42,
        document: {
          body: documentPath.endsWith("task-contract.json")
            ? JSON.stringify({ documents: [{ slot: "task.pr-body", path: "artifacts/pr-body.md" }] })
            : "# English\n\n## Summary\n\nReal summary sentence for the latin word count threshold.\n\n## Residual Risk\n\nTBD\n\n---\n\n# 中文\n\n## 概要\n\n概要正文有足够的中文内容通过字数检查。\n\n## 残余风险\n\n待定\n",
          workspaceRevision: 42,
          blobSha256: "placeholder-body",
        },
      }),
    },
  };
  await assert.rejects(
    createTaskPullRequest(
      context as never,
      { kind: "task-pr", taskId: "task-ci" },
      f.binding,
      async () => {
        throw new Error("provider must not run when the lint rejects");
      },
      async () => {
        throw Object.assign(new Error("lint failed"), {
          stderr: "必填节为空或只有占位行（-、TBD、N/A 等）：# English ## Residual Risk、# 中文 ## 残余风险。",
        });
      },
    ),
    (error: Error & { code?: string; message: string }) =>
      error.code === "content_not_ready" &&
      error.message.includes("# English ## Residual Risk") &&
      error.message.includes("# 中文 ## 残余风险") &&
      error.message.includes("artifacts/pr-body.md"),
  );
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
    createTaskPullRequest(
      f.context as never,
      { kind: "task-pr", taskId: "task-ci" },
      f.binding,
      async () => {
        throw new Error(`provider rejected ${secret}`);
      },
      lintPass,
    ),
    (error: Error & { code?: string }) => error.code === "delivery_publish_failed" && !error.message.includes(secret),
  );
});

// The gate is the delivered repository's own script, resolved from its root (this checkout here).
const checkoutRoot = path.resolve(import.meta.dirname, "../../..");

test("task PR runs the repository lint script itself and rejects a placeholder-only body", async () => {
  const rootDir = checkoutRoot;
  const placeholderBody =
    "# English\n\n## Summary\n\nReal summary sentence for the latin word count threshold.\n\n## Residual Risk\n\nTBD\n\n---\n\n# 中文\n\n## 概要\n\n概要正文有足够的中文内容通过字数检查。\n\n## 残余风险\n\n待定\n";
  const filledBody =
    "# English\n\n## Summary\n\nReal summary sentence for the latin word count threshold of this bilingual gate.\n\n## Residual Risk\n\nNo residual risk remains beyond the checked body itself.\n\n---\n\n# 中文\n\n## 概要\n\n概要正文有足够的中文内容通过字数检查。\n\n## 残余风险\n\n除已检查的正文外无残留风险。\n";
  const f = prFixture();
  const withBody = (body: string) => ({
    ...f.context,
    rootDir,
    projection: {
      ...f.context.projection,
      readDocument: (documentPath: string) => ({
        watermark: 42,
        sourceRevision: 42,
        document: {
          body: documentPath.endsWith("task-contract.json")
            ? JSON.stringify({ documents: [{ slot: "task.pr-body", path: "artifacts/pr-body.md" }] })
            : body,
          workspaceRevision: 42,
          blobSha256: "body",
        },
      }),
    },
  });
  await assert.rejects(
    createTaskPullRequest(
      withBody(placeholderBody) as never,
      { kind: "task-pr", taskId: "task-ci" },
      f.binding,
      async () => {
        throw new Error("provider must not run when the lint rejects");
      },
    ),
    (error: Error & { code?: string; message: string }) =>
      error.code === "content_not_ready" &&
      error.message.includes("# English ## Residual Risk") &&
      error.message.includes("# 中文 ## 残余风险"),
  );
  const receipt = await createTaskPullRequest(
    withBody(filledBody) as never,
    { kind: "task-pr", taskId: "task-ci" },
    f.binding,
    async () => "https://github.com/fixture/repo/pull/2",
  );
  assert.match(receipt.evidence!, /pull\/2/u);
});

test("task PR skips the body gate in a repository that has no lint script", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-pr-nolint-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  const f = prFixture();
  const receipt = await createTaskPullRequest(
    { ...f.context, rootDir } as never,
    { kind: "task-pr", taskId: "task-ci" },
    f.binding,
    async () => "https://github.com/fixture/repo/pull/3",
  );
  assert.match(receipt.evidence!, /pull\/3/u);
});
