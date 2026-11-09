// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { completionSnapshot } from "../../kernel/test/domain/completion.fixtures.ts";
import { readCloseoutSubmission, submitTask } from "../src/repo-cell-submit.ts";
import { judgeOldDataCopyReceipt, oldDataCopyReceiptPath } from "../src/submit-old-data-copy.ts";

const packagePath = "tasks/task-1",
  receiptPath = oldDataCopyReceiptPath(packagePath),
  closeoutBody =
    "## Summary\nReport delivered.\n## Verification\nChecked.\n## Residual Risk\nNone.\n" +
    "## Same Mechanism Elsewhere\nChecked.\n",
  actor = { principal: { personId: "owner" }, executor: { kind: "runtime", id: "execution-1" } };

interface FixtureOptions {
  readonly pathReviewers: readonly string[];
  readonly changedPath?: string;
}

function receiptFor(headCommit: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "old-data-copy-evidence/v1",
    at: "2026-11-08T00:00:00.000Z",
    ok: true,
    build: { headCommit },
    attach: { outcome: "terminal-record", record: { event: "repo_attach_completed" } },
    failures: [],
    ...overrides,
  });
}

function fixture(t: TestContext, options: FixtureOptions) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-old-data-copy-submit-")),
    git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
    put = (file: string, body: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Harness Test");
  git("config", "user.email", "harness@example.test");
  git("config", "commit.gpgsign", "false");
  put(".gitignore", "/harness/\n");
  git("add", ".");
  git("commit", "-qm", "test: base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("checkout", "-qb", "task-1");
  put(options.changedPath ?? "packages/storage/src/store/schema.ts", "export const schema = 1;\n");
  git("add", ".");
  git("commit", "-qm", "test: delivery");
  const head = git("rev-parse", "HEAD"),
    blobOf = (text: string) => createHash("sha256").update(text).digest("hex"),
    acceptedRevision = 7,
    documents = new Map<string, string>([
      [`${packagePath}/closeout.md`, closeoutBody],
      [
        `${packagePath}/task-contract.json`,
        JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] }),
      ],
    ]),
    snapshot = {
      task: {
        schema: "task/v2",
        taskId: "task-1",
        taskClass: "standard",
        status: "active",
        currentNode: "implementation",
        iteration: 0,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: completionSnapshot.digest,
        metadata: { presetId: "standard-task", riskTier: "medium" },
      },
      reviews: [],
      executions: [
        {
          schema: "execution/v1",
          executionId: "execution-1",
          taskId: "task-1",
          iteration: 0,
          state: "active",
          actor,
          deliveryBaseline: { kind: "commit", commitSha: base },
        },
      ],
      lease: {
        phase: "held",
        taskId: "task-1",
        executionId: "execution-1",
        actor,
        source: { kind: "node", nodeId: "node-1" },
      },
    } as unknown as Parameters<typeof readCloseoutSubmission>[3],
    settings = { gates: [], review: { pathReviewers: options.pathReviewers } },
    cell = {
      rootDir: root,
      cellCodedError: (code: string, text: string) => Object.assign(new Error(text), { code }),
      store: {
        readEventAtRevision: (revision: number) => {
          const body = documents.get(receiptPath);
          return revision === acceptedRevision && body !== undefined
            ? {
                schema: "doc-event/v1",
                workspaceRevision: acceptedRevision,
                opId: "accepted-receipt",
                payload: { changes: [{ path: receiptPath, candidate: { sha256: blobOf(body) } }] },
              }
            : null;
        },
        readContentBlob: (blobSha256: string) => {
          const body = documents.get(receiptPath);
          return body !== undefined && blobOf(body) === blobSha256 ? Buffer.from(body) : null;
        },
        readContentBlobSize: () => documents.get(receiptPath)?.length ?? 0,
      },
      settings: { readRepository: () => settings },
      projection: {
        // The receipt is an accepted package artifact like any other, so the submission freezes
        // its anchor before the gate reads the same accepted document.
        readDocuments: () => {
          const body = documents.get(receiptPath);
          return {
            status: "ready",
            watermark: 1,
            sourceRevision: 1,
            documents:
              body === undefined
                ? []
                : [
                    {
                      path: receiptPath,
                      blobSha256: blobOf(body),
                      size: body.length,
                      mediaType: "application/json",
                      policyId: "opaque-textual/v1",
                    },
                  ],
          };
        },
        read: () => ({ snapshot, packagePath }),
        readPresetSnapshot: () => ({
          snapshot: { ...completionSnapshot, profile: { outputShape: "repository-diff" } },
        }),
        readRuntimeDispatchesByTaskExecution: () => [],
        readDocument: (target: string) => {
          const body = documents.get(target);
          return {
            document:
              body === undefined ? null : { body, workspaceRevision: acceptedRevision, blobSha256: blobOf(body) },
          };
        },
      },
      // The real submit entry's short circuits: fewer than one cut would fall back to the
      // lifecycle path, so the fixture exposes exactly one frozen cut to select.
      service: { read: async () => ({ snapshot, packagePath }) },
      rejected: (opId: string, code: string) => ({ outcome: "op_rejected", opId, code }),
      operationId: () => "op-old-data-copy",
      input: { repoId: "repo" },
      requiredCellText: (value: unknown, name: string) => {
        if (typeof value === "string" && value) return value;
        throw new Error(`${name} is required.`);
      },
    };
  return {
    head,
    base,
    cell,
    setReceipt: (body: string | null) => {
      if (body === null) documents.delete(receiptPath);
      else documents.set(receiptPath, body);
    },
    derive: (bodyOverrides?: ReadonlyMap<string, string>) =>
      readCloseoutSubmission(
        cell as unknown as Parameters<typeof readCloseoutSubmission>[0],
        "task-1",
        "execution-1",
        snapshot,
        bodyOverrides,
        head,
        "local",
      ),
    submit: () =>
      submitTask(
        cell as unknown as Parameters<typeof submitTask>[0],
        { kind: "task-submit", taskId: "task-1", commitSha: head },
        { actor, source: { kind: "node", nodeId: "node-1" } } as unknown as Parameters<typeof submitTask>[2],
      ),
  };
}

async function rejection(
  promise: Promise<{ readonly ok: boolean; readonly error?: Error }>,
): Promise<Error & { code?: string; nextAction?: string }> {
  try {
    const result = await promise;
    if (result.ok === false && result.error) return result.error as Error & { code?: string; nextAction?: string };
  } catch (error) {
    return error as Error & { code?: string; nextAction?: string };
  }
  assert.fail("expected the submission to be refused");
}

test("submit refuses a migration-surface cut with no old-data-copy receipt and names the command", async (t) => {
  const { derive, submit, head } = fixture(t, {
    pathReviewers: ["data-migration packages/storage/src/store/"],
  });
  const error = await rejection(derive());
  assert.equal(error.code, "invalid_submission");
  assert.match(error.message, /touches the data-migration review surface/u);
  assert.ok(error.message.includes(`harness/${receiptPath}`), error.message);
  assert.match(error.message, new RegExp(head, "u"));
  assert.equal(
    error.nextAction,
    `node tools/old-data-copy-evidence.mjs --build . --out harness/${packagePath}/artifacts/old-data-copy-evidence`,
  );
  // The same refusal reaches the real submit entry, not only its derivation.
  const submitted = await submit();
  assert.equal(submitted.code, "document_invalid");
  assert.match(String(submitted.rejectionExplanation), /requires a real old-data-copy receipt/u);
  assert.equal(submitted.next?.[0]?.action, error.nextAction);
});

test("submit refuses a receipt bound to an earlier cut", async (t) => {
  const { base, head, derive, setReceipt } = fixture(t, {
    pathReviewers: ["data-migration packages/storage/src/store/"],
  });
  setReceipt(receiptFor(base));
  const error = await rejection(derive());
  assert.equal(error.code, "invalid_submission");
  assert.match(error.message, new RegExp(`is bound to cut ${base}, not the submitted cut ${head}`, "u"));
});

test("submit refuses a receipt that recorded failures", async (t) => {
  const { head, derive, setReceipt } = fixture(t, {
    pathReviewers: ["data-migration packages/storage/src/store/"],
  });
  setReceipt(receiptFor(head, { ok: false, failures: [{ phase: "cold-rebuild", message: "watermark mismatch" }] }));
  const error = await rejection(derive());
  assert.match(error.message, /records 1 failure\(s\): cold-rebuild/u);
});

test("submit accepts a receipt bound to the submitted cut with no failures", async (t) => {
  const { head, derive, setReceipt } = fixture(t, {
    pathReviewers: ["data-migration packages/storage/src/store/"],
  });
  setReceipt(receiptFor(head));
  const result = await derive();
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  assert.equal(result.submission.commitSha, head);
  assert.deepEqual(result.submission.riskTierAssessment?.matchedPathReviewers, [
    { agentId: "data-migration", paths: ["packages/storage/src/store/schema.ts"] },
  ]);
});

test("a receipt carried in the same submit satisfies the gate before the ledger accepts it", async (t) => {
  const { head, derive } = fixture(t, {
    pathReviewers: ["data-migration packages/storage/src/store/"],
  });
  const result = await derive(new Map([[receiptPath, receiptFor(head)]]));
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
});

test("submit does not require a receipt when the cut misses the data-migration lane", async (t) => {
  const { derive } = fixture(t, {
    pathReviewers: ["data-migration packages/kernel/src/domain/"],
  });
  const result = await derive();
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
});

test("submit follows the configured lane, not a hardcoded migration path list", async (t) => {
  const configured = fixture(t, {
    changedPath: "docs/migration-notes.md",
    pathReviewers: ["data-migration docs/migration-notes.md"],
  });
  assert.equal((await rejection(configured.derive())).code, "invalid_submission");
  configured.setReceipt(receiptFor(configured.head));
  const accepted = await configured.derive();
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.message);
});

test("another reviewer's lane over the same path does not require the data-migration receipt", async (t) => {
  const { derive } = fixture(t, {
    pathReviewers: ["gui-reviewer packages/storage/src/store/"],
  });
  assert.equal((await derive()).ok, true);
});

test("the receipt judge binds the cut and reports a missing failure phase honestly", () => {
  assert.equal(judgeOldDataCopyReceipt(receiptFor("a".repeat(40)), "a".repeat(40)).ok, true);
  assert.match(
    judgeOldDataCopyReceipt(receiptFor("a".repeat(40)), "b".repeat(40)).reason ?? "",
    /not the submitted cut/u,
  );
  assert.match(judgeOldDataCopyReceipt("{", "a".repeat(40)).reason ?? "", /not valid JSON/u);
});
