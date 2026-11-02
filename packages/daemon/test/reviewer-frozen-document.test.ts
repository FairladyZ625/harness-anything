// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runDocAction } from "../src/doc-sync-actions.ts";
import { isFleetTaskAction, type FleetFrameV1 } from "../src/fleet/command-protocol.ts";
import { encodeFleetFrames, FleetTransferAssembler } from "../src/fleet/command-transfer.ts";

test("large doc-show evidence uses the generic transfer envelope", async () => {
  const frame: Extract<FleetFrameV1, { schema: "fleet.task.result/v1" }> = {
      schema: "fleet.task.result/v1",
      messageId: "result-one",
      inReplyTo: "read-one",
      outcome: "applied",
      opId: "op-one",
      revision: 7,
      replicationSequence: 9,
      appliedCut: null,
      code: null,
      receipt: { outcome: "applied", evidence: "evidence\n".repeat(20000) },
    },
    encoded: FleetFrameV1[] = [];
  for await (const part of encodeFleetFrames(frame, "response", "repo-one")) encoded.push(part);
  assert.equal(encoded[0]?.schema, "fleet.transfer.begin/v1");
  assert.equal(encoded.at(-1)?.schema, "fleet.transfer.end/v1");
  const assembler = new FleetTransferAssembler({ direction: "response" });
  let result: FleetFrameV1 | null = null;
  for (const part of encoded) result = assembler.push(part) ?? result;
  assert.deepEqual(result, frame);
});

test("Fleet accepts the declared doc-show fields for center-owned frozen reads", () => {
  assert.equal(isFleetTaskAction({ kind: "doc-show", path: "tasks/task-one/artifacts/report.md", raw: true }), true);
  assert.equal(isFleetTaskAction({ kind: "doc-show", path: "tasks/task-one/artifacts/report.md" }), true);
  assert.equal(
    isFleetTaskAction({ kind: "doc-show", path: "tasks/task-one/artifacts/report.md", offset: 0, length: 1024 }),
    true,
  );
  assert.equal(
    isFleetTaskAction({ kind: "doc-show", path: "tasks/task-one/artifacts/report.md", revision: 99 }),
    false,
  );
  assert.equal(isFleetTaskAction({ kind: "doc-show" }), false);
  assert.equal(isFleetTaskAction({ kind: "doc-show", path: "report.md", raw: "true" }), false);
});

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("reviewer doc-show preserves frozen submitted artifacts and permits other read paths", () => {
  const packagePath = "tasks/task-one",
    text = Buffer.from(`HEAD\n${"evidence\n".repeat(40000)}TAIL\n`),
    binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]),
    rangeReads = { count: 0 },
    bodies = new Map([
      [`${packagePath}/artifacts/report.md`, text],
      [`${packagePath}/artifacts/image.png`, binary],
      [`${packagePath}/artifacts/empty.md`, Buffer.alloc(0)],
    ]),
    artifacts = [...bodies].map(([path, bytes]) => ({ path, revision: 7, blobSha256: digest(bytes) })),
    input = {
      workspaceId: "repo-one",
      rootDir: "/unavailable-reviewer-workspace",
      now: () => new Date().toISOString(),
      binding: {
        actor: { principal: { personId: "reviewer" }, executor: null },
        source: "local" as const,
        executionPrincipal: {
          personId: "reviewer",
          repoId: "repo-one",
          runtimeSessionId: "runtime-one",
          dispatchId: "dispatch-one",
          taskId: "task-one",
          executionId: "execution-one",
          role: "reviewer" as const,
          source: "local" as const,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
      projection: {
        read: (taskId: string) => {
          assert.equal(taskId, "task-one");
          return {
            packagePath,
            snapshot: { executions: [{ executionId: "execution-one", submission: { artifacts } }] },
          };
        },
        readDocument: (candidate: string) => {
          assert.equal(candidate, "tasks/task-other/artifacts/report.md");
          return {
            status: "ready",
            document: { path: candidate, body: "Other task read", blobSha256: digest(Buffer.from("Other task read")) },
            watermark: 8,
          };
        },
      } as never,
      store: {
        currentCut: () => ({ repoId: "repo-one", revision: 8, headDigest: "head-eight" }),
        readEventAtRevision: (revision: number) => {
          assert.equal(revision, 7);
          return {
            schema: "doc-event/v1",
            workspaceRevision: 7,
            opId: "accepted-seven",
            payload: {
              changes: artifacts.map((anchor) => ({
                path: anchor.path,
                candidate: {
                  sha256: anchor.blobSha256,
                  size: bodies.get(anchor.path)!.byteLength,
                  mediaType: "text/markdown",
                },
              })),
            },
          };
        },
        readContentBlob: (blob: string) => [...bodies.values()].find((bytes) => digest(bytes) === blob),
        readContentBlobRange: (blob: string, offset: number, maxBytes: number) =>
          (() => {
            rangeReads.count += 1;
            return (
              [...bodies.values()].find((bytes) => digest(bytes) === blob)?.subarray(offset, offset + maxBytes) ?? null
            );
          })(),
      } as never,
    };
  for (const source of ["local", { kind: "node", nodeId: "edge-one" }] as const) {
    for (const [path, bytes] of bodies) {
      const receipt = runDocAction({
        ...input,
        binding: { ...input.binding, source },
        action: { kind: "doc-show", path, raw: true },
      });
      assert.ok(!(receipt instanceof Promise));
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.revision, 7);
      assert.equal(receipt.evidence, bytes.toString(path.endsWith(".png") ? "base64" : "utf8"));
      if (path.endsWith("report.md")) {
        const ranged = runDocAction({
          ...input,
          binding: { ...input.binding, source },
          action: { kind: "doc-show", path, offset: 2, length: 5 },
        }) as { readonly evidence: string; readonly evidenceEncoding?: string };
        assert.equal(ranged.evidenceEncoding, "base64");
        assert.deepEqual(Buffer.from(ranged.evidence, "base64"), bytes.subarray(2, 7));
      }
      if (path.endsWith("image.png")) {
        const ranged = runDocAction({
          ...input,
          binding: { ...input.binding, source },
          action: { kind: "doc-show", path, offset: 1, length: 3 },
        }) as { readonly evidence: string; readonly evidenceEncoding?: string };
        assert.equal(ranged.evidenceEncoding, "base64");
        assert.deepEqual(Buffer.from(ranged.evidence, "base64"), bytes.subarray(1, 4));
      }
    }
  }
  assert.equal(rangeReads.count, 11);
  const otherTask = runDocAction({
    ...input,
    action: { kind: "doc-show", path: "tasks/task-other/artifacts/report.md" },
  });
  assert.ok(!(otherTask instanceof Promise));
  assert.equal(otherTask.outcome, "applied");
  assert.equal(otherTask.evidence, "Other task read");
  assert.throws(() => runDocAction({ ...input, action: { kind: "doc-show", path: "../report.md" } }), {
    code: "invalid_command",
  });
});

test("implementer doc-show reads repository documents through the live projection (dec_CF96A3C910B31D2D7498F32DDD/CH2)", () => {
  const packagePath = "tasks/task-one",
    shown = `${packagePath}/artifacts/report.md`,
    body = "# run manifest\naccepted\n",
    rootDir = mkdtempSync(path.join(tmpdir(), "ha-impl-doc-show-"));
  try {
    mkdirSync(path.join(rootDir, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(rootDir, shown), body);
    const input = {
      workspaceId: "repo-one",
      rootDir,
      now: () => new Date().toISOString(),
      binding: {
        actor: { principal: { personId: "worker" }, executor: null },
        source: "local" as const,
        executionPrincipal: {
          personId: "worker",
          repoId: "repo-one",
          runtimeSessionId: "runtime-one",
          dispatchId: "dispatch-one",
          taskId: "task-one",
          executionId: "execution-one",
          role: "implementation" as const,
          source: "local" as const,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
      projection: {
        taskIdForDocumentPath: (candidate: string) =>
          candidate.startsWith("tasks/task-one/") ? "task-one" : candidate.startsWith("tasks/") ? "task-other" : null,
        readDocument: (candidate: string) => {
          return {
            status: "ready",
            document: { path: candidate, body, blobSha256: digest(Buffer.from(body)) },
            watermark: 9,
          };
        },
      } as never,
      store: { currentCut: () => ({ repoId: "repo-one", revision: 9, headDigest: "head-nine" }) } as never,
    };
    const receipt = runDocAction({ ...input, action: { kind: "doc-show", path: shown } }) as {
      readonly outcome: string;
      readonly evidence: string;
    };
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.evidence, body);
    for (const outside of [
      "tasks/task-other/artifacts/report.md",
      "context/readme.md",
      "decisions/decision-dec_one/decision.md",
    ]) {
      const other = runDocAction({ ...input, action: { kind: "doc-show", path: outside } }) as {
        readonly outcome: string;
      };
      assert.equal(other.outcome, "applied");
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("pinned range reads reject a same-size document update between windows", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-pin-")),
    pathName = "context/pinned.md",
    first = Buffer.from("AAAA1111"),
    second = Buffer.from("BBBB2222"),
    firstDigest = digest(first),
    secondDigest = digest(second);
  let version = { bytes: first, workspaceRevision: 10, blobSha256: firstDigest },
    repositoryRevision = 10;
  try {
    const input = {
      workspaceId: "repo-one",
      rootDir,
      now: () => new Date().toISOString(),
      binding: {
        actor: { principal: { personId: "reader" }, executor: null },
        source: "local" as const,
        executionPrincipal: {
          personId: "reader",
          repoId: "repo-one",
          runtimeSessionId: "runtime-one",
          dispatchId: "dispatch-one",
          taskId: null,
          executionId: null,
          role: "implementation" as const,
          source: "local" as const,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      projection: {
        readDocument: () => ({
          status: "ready",
          document: {
            path: pathName,
            body: version.bytes.toString(),
            blobSha256: version.blobSha256,
            size: 8,
            workspaceRevision: version.workspaceRevision,
          },
          watermark: repositoryRevision,
          sourceRevision: repositoryRevision,
        }),
      } as never,
      store: {
        currentCut: () => ({
          repoId: "repo-one",
          revision: repositoryRevision,
          headDigest: `head-${repositoryRevision}`,
        }),
        readContentBlobRange: (blob: string, offset: number, maxBytes: number) => {
          const bytes = blob === firstDigest ? first : blob === secondDigest ? second : null;
          return bytes?.subarray(offset, offset + maxBytes) ?? null;
        },
      } as never,
    };
    const initial = runDocAction({ ...input, action: { kind: "doc-show", path: pathName, offset: 0, length: 4 } }) as {
      readonly evidenceBlobSha256: string;
      readonly evidenceSourceRevision: number;
      readonly evidenceWorkspaceRevision: number;
    };
    assert.equal(initial.evidenceBlobSha256, firstDigest);
    assert.equal(initial.evidenceWorkspaceRevision, 10);
    assert.equal(initial.evidenceSourceRevision, 10);
    repositoryRevision = 11;
    const afterUnrelatedEvent = runDocAction({
      ...input,
      action: {
        kind: "doc-show",
        path: pathName,
        offset: 4,
        length: 4,
        contentSha256: initial.evidenceBlobSha256,
        contentRevision: initial.evidenceWorkspaceRevision,
      },
    }) as {
      readonly evidence: string;
      readonly evidenceSourceRevision: number;
      readonly evidenceWorkspaceRevision: number;
    };
    assert.deepEqual(Buffer.from(afterUnrelatedEvent.evidence, "base64"), first.subarray(4));
    assert.equal(afterUnrelatedEvent.evidenceSourceRevision, 11);
    assert.equal(afterUnrelatedEvent.evidenceWorkspaceRevision, 10);
    version = { bytes: second, workspaceRevision: 11, blobSha256: secondDigest };
    assert.throws(
      () =>
        runDocAction({
          ...input,
          action: {
            kind: "doc-show",
            path: pathName,
            offset: 4,
            length: 4,
            contentSha256: initial.evidenceBlobSha256,
            contentRevision: initial.evidenceWorkspaceRevision,
          },
        }),
      { code: "content_changed" },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
