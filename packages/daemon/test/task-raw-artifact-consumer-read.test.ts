// harness-test-tier: integration
// The read side of the raw artifact policy. Publication was proved in
// doc-sync-artifact-raw-bytes.test.ts; what is proved here is that the consumers a GUI and a CLI
// actually call — repo.tasks.documents.list and repo.tasks.document.read — answer a PDF, a PNG and a
// log with their true media type, byte length and canonical bytes, instead of an empty string that
// is indistinguishable from an empty file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "../../kernel/src/index.ts";
import { canonicalRoot, serializeDaemonDocumentRead, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const,
  RAW_MEDIA_TYPE = "application/octet-stream";

// Byte sequences no UTF-8 decoder accepts, at the real names a task produces them under.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x0a]),
  pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0xff, 0xd8, 0x00, 0x1a, 0x80]), Buffer.from("\n%%EOF")]),
  log = Buffer.concat([Buffer.from("2026-09-09 dispatch "), Buffer.from([0x80]), Buffer.from(" 报告\n")]),
  json = Buffer.from(JSON.stringify({ verdict: "green", 报告: "ok" }, null, 2), "utf8");

interface DocumentRead {
  readonly status: string;
  readonly body: string;
  readonly blobSha256: string | null;
  readonly contentKind: string;
  readonly mediaType: string | null;
  readonly size: number | null;
  readonly bytes: string | null;
  readonly repositoryPath: string;
  readonly worktreeBody: string | null;
  readonly uncommitted: boolean;
}

interface DocumentRow {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly uncommitted: boolean;
}

test("raw task artifacts read back with true metadata and canonical bytes, never as an empty document", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-raw-consumer-"));
  initRepo(rootDir);
  const repoId = workspaceId("raw-consumer"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "raw-consumer" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-consumer", title: "Consumer" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String(created.packagePath),
      cases = [
        { source: "verdict.json", destination: "verdict.json", bytes: json, mediaType: "application/json" },
        { source: "dispatch.log", destination: "logs/dispatch.log", bytes: log, mediaType: RAW_MEDIA_TYPE },
        { source: "logo.png", destination: "screenshots/logo.png", bytes: png, mediaType: RAW_MEDIA_TYPE },
        { source: "dossier.pdf", destination: "reports/dossier.pdf", bytes: pdf, mediaType: RAW_MEDIA_TYPE },
      ];
    for (const { source, destination, bytes } of cases) {
      writeFileSync(path.join(rootDir, source), bytes);
      const added = (await cell.run(
        { kind: "task-artifact-add", taskId: "task-consumer", source, destination },
        binding,
      )) as Record<string, unknown>;
      assert.equal(added.outcome, "applied", `${destination}: ${JSON.stringify(added)}`);
      await waitForFixturePublication(cell, String(added.opId), binding);
    }

    // 1. The list a file tree is built from: every artifact keeps its real name, and its row states
    //    the media type, byte length and digest of the bytes that were accepted.
    const listed = (await cell.read("repo.tasks.documents.list", { taskId: "task-consumer" })) as {
      readonly documents: readonly DocumentRow[];
    };
    for (const { destination, bytes, mediaType } of cases) {
      const row = listed.documents.find((candidate) => candidate.path === `artifacts/${destination}`);
      assert.ok(row, `${destination}: missing from the task document list`);
      assert.deepEqual(
        [row.mediaType, row.size, row.blobSha256, row.uncommitted],
        [mediaType, bytes.byteLength, sha256Bytes(bytes), false],
        `${destination}: the list row must state the real content facts`,
      );
    }

    // 2. The read a document surface calls. A raw artifact answers binary + canonical bytes; the JSON
    //    artifact is untouched text. Every result is checked against the real wire contract.
    for (const { destination, bytes, mediaType } of cases) {
      const raw = mediaType === RAW_MEDIA_TYPE,
        read = (await cell.read("repo.tasks.document.read", {
          taskId: "task-consumer",
          path: `artifacts/${destination}`,
        })) as DocumentRead;
      serializeDaemonDocumentRead(read);
      assert.equal(read.status, "ready", `${destination}: projection not ready`);
      assert.deepEqual(
        [read.contentKind, read.mediaType, read.size, read.blobSha256],
        [raw ? "binary" : "text", mediaType, bytes.byteLength, sha256Bytes(bytes)],
        `${destination}: content facts`,
      );
      assert.equal(
        read.repositoryPath,
        `harness/${packagePath}/artifacts/${destination}`,
        `${destination}: the read must name where its bytes materialize`,
      );
      if (!raw) {
        // The text reader is unchanged: same body, same live worktree view.
        assert.equal(read.body, bytes.toString("utf8"), `${destination}: text body`);
        assert.equal(read.worktreeBody, bytes.toString("utf8"), `${destination}: text worktree body`);
        assert.equal(read.bytes, null, `${destination}: a text document carries no byte channel`);
        continue;
      }
      // The defect this test exists for: an empty body must never be the whole answer for a binary
      // document. It is empty *and* declared binary *and* accompanied by the canonical bytes.
      assert.equal(read.body, "", `${destination}: a binary document has no text body`);
      assert.notEqual(read.contentKind, "text", `${destination}: an empty body must not read as empty text`);
      assert.equal(read.worktreeBody, null, `${destination}: binary bytes must not be coerced into a string`);
      assert.ok(read.bytes !== null, `${destination}: the canonical bytes must be readable`);
      assert.deepEqual(
        Buffer.from(read.bytes, "base64"),
        bytes,
        `${destination}: the read returns the original bytes, unmodified`,
      );
    }

    // 3. Same bytes in the ledger Git cut, and the same read after the working copy is destroyed and
    //    rebuilt: the read source is the canonical content object, not the file on disk.
    for (const { destination, bytes } of cases)
      assert.deepEqual(
        gitBytes(rootDir, `harness/${packagePath}/artifacts/${destination}`),
        bytes,
        `${destination}: the ledger Git cut holds the same bytes`,
      );
    rmSync(path.join(rootDir, "harness", "tasks"), { recursive: true, force: true });
    const beforeRestore = (await cell.read("repo.tasks.document.read", {
      taskId: "task-consumer",
      path: "artifacts/reports/dossier.pdf",
    })) as DocumentRead;
    assert.deepEqual(
      Buffer.from(String(beforeRestore.bytes), "base64"),
      pdf,
      "the canonical bytes survive the working copy being deleted",
    );
    assert.equal(beforeRestore.worktreeBody, null);
    assert.equal((await cell.run({ kind: "doc-materialize" }, binding)).outcome, "applied");
    for (const { destination, bytes, mediaType } of cases) {
      const read = (await cell.read("repo.tasks.document.read", {
        taskId: "task-consumer",
        path: `artifacts/${destination}`,
      })) as DocumentRead;
      assert.deepEqual(
        [read.contentKind, read.mediaType, read.size, read.uncommitted],
        [mediaType === RAW_MEDIA_TYPE ? "binary" : "text", mediaType, bytes.byteLength, false],
        `${destination}: rebuild keeps the same content facts`,
      );
      assert.deepEqual(
        readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", ...destination.split("/"))),
        bytes,
        `${destination}: rebuild reproduces the original bytes`,
      );
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a binary file in a task's artifacts tree is listed and routed, not hidden from the reader", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-raw-consumer-worktree-"));
  initRepo(rootDir);
  const repoId = workspaceId("raw-consumer-wt"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "raw-consumer-wt" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run({ kind: "task-create", taskId: "task-loose", title: "Loose" }, binding)) as Record<
      string,
      unknown
    >;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String(created.packagePath),
      artifacts = path.join(rootDir, "harness", packagePath, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, "capture.png"), png);

    const listed = (await cell.read("repo.tasks.documents.list", { taskId: "task-loose" })) as {
      readonly documents: readonly DocumentRow[];
    };
    const row = listed.documents.find((candidate) => candidate.path === "artifacts/capture.png");
    assert.ok(row, "a binary output sitting in artifacts/ must be visible, not silently dropped");
    assert.deepEqual(
      [row.mediaType, row.size, row.blobSha256, row.uncommitted],
      [RAW_MEDIA_TYPE, png.byteLength, sha256Bytes(png), true],
      "the row states what the file is and that it is not committed",
    );

    const read = (await cell.read("repo.tasks.document.read", {
      taskId: "task-loose",
      path: "artifacts/capture.png",
    })) as DocumentRead;
    serializeDaemonDocumentRead(read);
    assert.deepEqual(
      [read.contentKind, read.body, read.worktreeBody, read.bytes, read.blobSha256, read.uncommitted],
      ["binary", "", null, null, null, true],
      "an unpublished binary is declared binary with no bytes to serve, not shown as empty text",
    );
    assert.deepEqual([read.mediaType, read.size], [RAW_MEDIA_TYPE, png.byteLength]);
    assert.equal(read.repositoryPath, `harness/${packagePath}/artifacts/capture.png`);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function gitBytes(rootDir: string, target: string): Buffer {
  return execFileSync("git", ["-C", rootDir, "show", `HEAD:${target}`], { maxBuffer: 64 * 1024 * 1024 });
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Raw Consumer Test");
  git(rootDir, "config", "user.email", "raw-consumer@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
