// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ARTIFACT_OPEN_EXTERNAL_CHANNEL } from "../src/api/artifact-open-contract.ts";
import {
  artifactBasename,
  registerArtifactOpenIpc,
  requireArtifactRelativePath,
  resolveArtifactAbsolutePath,
  validateArtifactOpenExternalInput,
  type ArtifactOpenServices,
} from "../src/main/artifact-open-ipc.ts";

/**
 * 「在默认浏览器打开」的信任边界(task_7e713fee):渲染进程只能报 daemon 报过的
 * repo 相对产物路径;绝对路径、仓库根、磁盘存在性全部由主进程判定。
 * 负向用例是主防面 —— 客户端提供的任意路径形态必须被拒绝。
 */

const trustedEvent = {
  sender: { id: 7 },
  senderFrame: { url: "file:///Applications/Harness/renderer/index.html" },
};

type ServiceOverrides = Partial<ArtifactOpenServices> & Pick<ArtifactOpenServices, "openPath">;
function services(overrides: ServiceOverrides): ArtifactOpenServices {
  return {
    canonicalRootOf: () => "/repo",
    repoModeOf: () => "local",
    readDocument: async () => ({ body: null, worktreeBody: null, uncommitted: false }),
    artifactCacheRoot: () => "/nonexistent-artifact-cache",
    ...overrides,
  };
}
const trustedPolicy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
};

test("only the artifact-open channel is registered, once", () => {
  const channels: string[] = [];
  registerArtifactOpenIpc(
    { handle: (channel) => channels.push(channel) },
    services({ openPath: async () => "" }),
    trustedPolicy,
  );
  assert.deepEqual(channels, [ARTIFACT_OPEN_EXTERNAL_CHANNEL]);
});

test("an untrusted renderer cannot reach the channel", async () => {
  let handled: unknown = null;
  registerArtifactOpenIpc(
    {
      handle: (_channel, listener) => {
        handled = listener;
      },
    },
    services({ openPath: async () => "" }),
    { isTrustedWebContentsId: () => false },
  );
  await assert.rejects(
    () =>
      (handled as (event: unknown, payload: unknown) => Promise<unknown>)(trustedEvent, {
        repoId: "canonical",
        path: "tasks/a/artifacts/x.html",
      }),
    /Rejected IPC message/u,
  );
});

test("a repo-relative artifact path resolves inside the harness root and is opened", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-open-"));
  const harnessRoot = path.join(parent, "harness");
  mkdirSync(path.join(harnessRoot, "tasks", "task_a", "artifacts"), { recursive: true });
  writeFileSync(path.join(harnessRoot, "tasks", "task_a", "artifacts", "report.html"), "<h1>x</h1>\n", "utf8");
  const opened: string[] = [];
  let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | null = null;
  registerArtifactOpenIpc(
    { handle: (_c, listener) => (handler = listener) },
    services({ canonicalRootOf: () => parent, openPath: async (absolute) => (opened.push(absolute), "") }),
    trustedPolicy,
  );
  try {
    const result = (await handler!(trustedEvent, {
      repoId: "canonical",
      path: "tasks/task_a/artifacts/report.html",
    })) as { ok: boolean; openedPath: string };
    assert.equal(result.ok, true);
    assert.equal(result.openedPath, path.join(harnessRoot, "tasks", "task_a", "artifacts", "report.html"));
    assert.deepEqual(opened, [result.openedPath]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("client-provided path shapes are rejected instead of resolved", () => {
  const rejected = [
    "/etc/passwd",
    "C:\\Windows\\system32\\config.sys",
    "../../secrets/keys.md",
    "tasks/a/artifacts/../../secrets/keys.md",
    "tasks/a/notes/secret.md",
    "docs/report.md",
    "tasks/a/artifacts/report.pdf",
    "tasks/a/artifacts/",
    "",
    "tasks//a/artifacts/x.md",
  ];
  for (const value of rejected) assert.throws(() => requireArtifactRelativePath(value), undefined, value);
  assert.equal(
    requireArtifactRelativePath("tasks/a/artifacts/sub/dir/report.htm"),
    "tasks/a/artifacts/sub/dir/report.htm",
  );
});

test("payload accepts exactly repoId, path, and an optional taskId", () => {
  assert.deepEqual(validateArtifactOpenExternalInput({ repoId: "canonical", path: "tasks/a/artifacts/x.md" }), {
    repoId: "canonical",
    path: "tasks/a/artifacts/x.md",
  });
  assert.deepEqual(
    validateArtifactOpenExternalInput({ repoId: "canonical", path: "tasks/a/artifacts/x.md", taskId: "task_a" }),
    { repoId: "canonical", path: "tasks/a/artifacts/x.md", taskId: "task_a" },
  );
  assert.throws(() =>
    validateArtifactOpenExternalInput({ repoId: "canonical", path: "tasks/a/artifacts/x.md", taskId: "" }),
  );
  assert.throws(() =>
    validateArtifactOpenExternalInput({ repoId: "canonical", path: "tasks/a/artifacts/x.md", absolute: "/tmp/x" }),
  );
  assert.throws(() => validateArtifactOpenExternalInput({ repoId: "Canonical", path: "tasks/a/artifacts/x.md" }));
  assert.throws(() => validateArtifactOpenExternalInput(null));
});

test("resolution refuses a harness-root escape and a missing file", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-open-missing-"));
  const harnessRoot = path.join(parent, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  try {
    assert.throws(() => resolveArtifactAbsolutePath(harnessRoot, "../outside.md"), /escapes/u);
    assert.throws(
      () => resolveArtifactAbsolutePath(harnessRoot, "tasks/a/artifacts/absent.md"),
      /not present on disk/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a failed system open surfaces as an error, not a silent success", async () => {
  let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | null = null;
  const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-open-fail-"));
  const harnessRoot = path.join(parent, "harness");
  mkdirSync(path.join(harnessRoot, "tasks", "task_a", "artifacts"), { recursive: true });
  writeFileSync(path.join(harnessRoot, "tasks", "task_a", "artifacts", "report.html"), "x\n", "utf8");
  registerArtifactOpenIpc(
    { handle: (_c, listener) => (handler = listener) },
    services({
      canonicalRootOf: () => parent,
      openPath: async () => "no application knows how to open it",
    }),
    trustedPolicy,
  );
  try {
    await assert.rejects(
      () => handler!(trustedEvent, { repoId: "canonical", path: "tasks/task_a/artifacts/report.html" }),
      /failed: no application knows how to open it/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a remote-proxy repository materializes a read-only server copy before opening", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-proxy-"));
  const cacheRoot = path.join(parent, "artifact-cache");
  const reads: { repoId: string; taskId: string; path: string }[] = [];
  const opened: string[] = [];
  let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | null = null;
  registerArtifactOpenIpc(
    { handle: (_c, listener) => (handler = listener) },
    services({
      repoModeOf: (repoId) => (repoId === "proxy-repo" ? "remote-proxy" : "local"),
      readDocument: async (repoId, taskId, artifactPath) => {
        reads.push({ repoId, taskId, path: artifactPath });
        return { body: "<h1>server body</h1>\n", worktreeBody: null, uncommitted: false };
      },
      artifactCacheRoot: () => cacheRoot,
      openPath: async (absolute) => (opened.push(absolute), ""),
    }),
    trustedPolicy,
  );
  try {
    const result = (await handler!(trustedEvent, {
      repoId: "proxy-repo",
      path: "tasks/task_a/artifacts/report.html",
      taskId: "task_a",
    })) as { ok: boolean; openedPath: string };
    assert.deepEqual(reads, [{ repoId: "proxy-repo", taskId: "task_a", path: "tasks/task_a/artifacts/report.html" }]);
    const sha = createHash("sha256").update("<h1>server body</h1>\n", "utf8").digest("hex");
    const expected = path.join(cacheRoot, "proxy-repo", sha, "report.html");
    assert.equal(result.ok, true);
    assert.equal(result.openedPath, expected);
    assert.deepEqual(opened, [expected]);
    assert.equal(readFileSync(expected, "utf8"), "<h1>server body</h1>\n");
    // 同一内容第二次打开复用同一副本,不重复物化新文件。
    await handler!(trustedEvent, {
      repoId: "proxy-repo",
      path: "tasks/task_a/artifacts/report.html",
      taskId: "task_a",
    });
    assert.deepEqual(opened, [expected, expected]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a remote-proxy open without a task id is rejected instead of guessed", async () => {
  let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | null = null;
  registerArtifactOpenIpc(
    { handle: (_c, listener) => (handler = listener) },
    services({
      repoModeOf: () => "remote-proxy",
      artifactCacheRoot: () => "/nonexistent-artifact-cache",
      openPath: async () => "",
    }),
    trustedPolicy,
  );
  await assert.rejects(
    () => handler!(trustedEvent, { repoId: "proxy-repo", path: "tasks/task_a/artifacts/report.html" }),
    /requires its task id/u,
  );
});

test("a proxy body miss is an explicit failure, not an empty copy", async () => {
  let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | null = null;
  registerArtifactOpenIpc(
    { handle: (_c, listener) => (handler = listener) },
    services({
      repoModeOf: () => "remote-proxy",
      readDocument: async () => ({ body: null, worktreeBody: null, uncommitted: false }),
      artifactCacheRoot: () => "/nonexistent-artifact-cache",
      openPath: async () => "",
    }),
    trustedPolicy,
  );
  await assert.rejects(
    () => handler!(trustedEvent, { repoId: "proxy-repo", path: "tasks/task_a/artifacts/report.html", taskId: "t" }),
    /does not have the artifact body/u,
  );
});

test("artifact basename keeps the copy file name inside the cache tree", () => {
  assert.equal(artifactBasename("tasks/a/artifacts/sub/report.md"), "report.md");
  assert.throws(() => artifactBasename("tasks/a/artifacts/"), /plain file name/u);
});
