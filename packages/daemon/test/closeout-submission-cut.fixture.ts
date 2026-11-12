import { completionSnapshot } from "../../kernel/test/domain/completion.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { sha256Bytes } from "@harness-anything/kernel";
import { deriveCloseoutSubmission } from "./closeout-submission.fixture.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";

export const packagePath = "tasks/task-1";
export const documentPath = `${packagePath}/closeout.md`;
export const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const put = (root: string, file: string, body: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), body);
};
export const commit = (root: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "test: delivery cut");
  return git(root, "rev-parse", "HEAD");
};
export const closeout = (summary: string) =>
  `## Summary\n${summary}\n## Verification\nTests passed.\n` +
  "## Residual Risk\n已知缺口：publication pending.\n" +
  "## Same Mechanism Elsewhere\nSibling delivery remains unverified.\n";

export function fixture(t: TestContext, sharedGit = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-cut-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    git(directory, "init", "-q", "-b", "main");
    git(directory, "config", "user.name", "Harness Test");
    git(directory, "config", "user.email", "harness@example.test");
    git(directory, "config", "commit.gpgsign", "false");
  };
  init(root);
  put(root, ".gitignore", "harness/\n.harness/\n");
  put(root, "src/old.ts", "export const oldValue = 1;\n");
  put(root, "src/live.ts", "export const liveValue = 1;\n");
  const base = commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", base);
  const ledger = path.join(root, "harness");
  if (sharedGit) mkdirSync(ledger, { recursive: true });
  else {
    init(ledger);
    put(ledger, "README.md", "Private ledger.\n");
    commit(ledger);
  }
  return { root, ledger, base };
}

export function artifactStore() {
  const artifactPath = `${packagePath}/artifacts/report.md`,
    bytes = Buffer.from("Frozen report.\n"),
    blobSha256 = sha256Bytes(bytes);
  return {
    blobSha256,
    store: {
      readEventAtRevision: (revision: number) =>
        revision === 7
          ? {
              schema: "doc-event/v1",
              workspaceRevision: 7,
              opId: "accepted-7",
              payload: {
                changes: [artifactPath, `${packagePath}/artifacts/reports/authored.md`].map((path) => ({
                  path,
                  candidate: { sha256: blobSha256 },
                })),
              },
            }
          : null,
      readContentBlob: () => bytes,
      readContentBlobRange: (_hash: string, offset: number, maxBytes: number) =>
        bytes.subarray(offset, offset + maxBytes),
      readContentBlobSize: () => bytes.byteLength,
    },
  };
}

/** The execution's start-frozen baseline: the repository root commit by default. */
function baseline(root: string) {
  return { kind: "commit" as const, commitSha: git(root, "rev-list", "--max-parents=0", "HEAD") };
}

export function deriveInput(
  rootDir: string,
  summary: string,
  missingPath?: string,
  gates: readonly string[] = ["lint"],
  store: Parameters<typeof deriveCloseoutSubmission>[0]["store"] = {} as Parameters<
    typeof deriveCloseoutSubmission
  >[0]["store"],
  deliveryBaseline:
    | {
        readonly kind: "commit";
        readonly commitSha: string;
        readonly stackOn?: { readonly taskId: string; readonly executionId: string };
      }
    | { readonly kind: "empty-tree" }
    | null
    | undefined = rootDir === "/nonexistent" ? { kind: "empty-tree" } : baseline(rootDir),
  commitSha?: string,
  // The delivery falls to this output shape, never the completion gate set: a repository-diff task always
  // carries a public delivery commit, even with an empty (lightweight) gate list.
  outputShape: "repository-diff" | "task-package-artifact" = "repository-diff",
  priorCommit?: string,
  frozenSubmission?: Awaited<ReturnType<typeof deriveCloseoutSubmission>>,
  accepted: readonly { readonly path: string; readonly revision: number }[] = [],
  reviews: readonly { readonly reviewId: string }[] = [],
  reviewerDispatches: readonly string[] = [],
  closeoutBody?: string,
): Parameters<typeof deriveCloseoutSubmission> {
  const snapshot = {
      reviews,
      executions: [
        ...(priorCommit ? [{ executionId: "earlier-execution", submission: { commitSha: priorCommit } }] : []),
        {
          schema: "execution/v1",
          executionId: "execution-1",
          taskId: "task-1",
          nodeId: "implementation",
          iteration: 0,
          state: "active",
          actor: { principal: { personId: "owner" }, executor: null },
          claimedAt: "2026-09-12T00:00:00.000Z",
          submittedAt: null,
          closedAt: null,
          submission: frozenSubmission ?? null,
          ...(deliveryBaseline == null ? {} : { deliveryBaseline }),
        },
      ],
      task: {
        taskId: "task-1",
        taskClass: "standard",
        presetSnapshotDigest: "snapshot-task-1",
        completionGateIds: gates,
      },
    } as unknown as Parameters<typeof deriveCloseoutSubmission>[3],
    body = closeoutBody ?? closeout(summary),
    projection = {
      readDocuments: () => ({ documents: accepted }),
      readPresetSnapshot: () => ({ snapshot: { ...completionSnapshot, profile: { outputShape } } }),
      readRuntimeDispatchesByTaskExecution: () =>
        reviewerDispatches.map((dispatchId) => ({ event: { payload: { role: "reviewer", dispatchId } } })),
      read: () => ({ watermark: 1, sourceRevision: 1, snapshot: { ...snapshot, task: {} }, packagePath }),
      readDocument: (target: string) => ({
        watermark: 1,
        sourceRevision: 1,
        document:
          target === missingPath
            ? null
            : {
                body: target.endsWith("task-contract.json")
                  ? JSON.stringify({
                      documents: [
                        {
                          slot: "task.closeout",
                          path: "closeout.md",
                          templateRef: "template://planning/closeout@1",
                          locale: "en-US",
                        },
                      ],
                    })
                  : body,
                blobSha256: "test-blob",
                workspaceRevision: accepted.find((entry) => entry.path === target)?.revision ?? 1,
              },
      }),
    } as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["projection"];
  return [
    {
      rootDir,
      projection,
      store,
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      settings: {
        readRepository: () => ({
          gates: [
            {
              gateId: "lint",
              adapter: "research/check",
              appliesTo: "code",
            },
          ],
        }),
      } as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["settings"],
    },
    "task-1",
    "execution-1",
    snapshot,
    undefined,
    commitSha,
  ];
}

export async function derive(...args: Parameters<typeof deriveInput>) {
  return await deriveCloseoutSubmission(...deriveInput(...args));
}

export function dispatch(root: string, cwd: string, dispatchId = "dispatch_111111111111111111111111") {
  openDispatchStream(root, {
    dispatchId,
    taskId: "task-1",
    executionId: "execution-1",
    runtimeSessionId: "runtime_111111111111111111111111",
    instanceId: "instance-1",
    startedAt: "2026-09-12T00:00:00.000Z",
    cwd,
  });
}
