// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ARTIFACT_OPEN_EXTERNAL_CHANNEL } from "../src/api/artifact-open-contract.ts";
import {
  registerArtifactOpenIpc,
  requireArtifactRelativePath,
  resolveArtifactAbsolutePath,
  validateArtifactOpenExternalInput,
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
const trustedPolicy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
};

test("only the artifact-open channel is registered, once", () => {
  const channels: string[] = [];
  registerArtifactOpenIpc(
    { handle: (channel) => channels.push(channel) },
    { canonicalRootOf: () => "/repo", openPath: async () => "" },
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
    { canonicalRootOf: () => "/repo", openPath: async () => "" },
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
    { canonicalRootOf: () => parent, openPath: async (absolute) => (opened.push(absolute), "") },
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

test("payload accepts exactly repoId and path", () => {
  assert.deepEqual(validateArtifactOpenExternalInput({ repoId: "canonical", path: "tasks/a/artifacts/x.md" }), {
    repoId: "canonical",
    path: "tasks/a/artifacts/x.md",
  });
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
    { canonicalRootOf: () => parent, openPath: async () => "no application knows how to open it" },
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
