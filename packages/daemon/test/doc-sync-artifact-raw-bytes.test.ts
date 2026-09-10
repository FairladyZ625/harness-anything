// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decideDocWrite,
  documentPath,
  makeTaskEventReader,
  makeTaskEventStore,
  DOC_SYNC_INLINE_MAX_BYTES,
  parseDocWriteIntent,
  RAW_ARTIFACT_MAX_BYTES,
  RAW_ARTIFACT_POLICY_ID,
  sha256Bytes,
} from "../../kernel/src/index.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";

const OPAQUE_TEXTUAL_POLICY_ID = "opaque-textual-whole-file/v1",
  OPAQUE_TEXTUAL_MEDIA_TYPE = "text/x-harness-opaque",
  RAW_ARTIFACT_MEDIA_TYPE = "application/octet-stream";
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

// Byte sequences no UTF-8 decoder accepts: a PNG header, a PDF trailer, and a log line with a lone 0x80.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x0a]),
  pdf = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from([0xff, 0xd8, 0x00, 0x1a, 0x80]),
    Buffer.from("\n%%EOF\n"),
  ]),
  log = Buffer.concat([Buffer.from("2026-09-09 dispatch "), Buffer.from([0x80]), Buffer.from(" 报告\n")]),
  empty = Buffer.alloc(0);

test("raw task artifacts publish their original bytes, filename, and owner through task-artifact-add", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-raw"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-raw" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-raw", title: "Raw Bytes" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-raw-raw-bytes",
      reader = makeTaskEventReader({ repoId, rootDir }),
      // A zero-byte file decodes as UTF-8, so it is not raw. It is listed here to pin that boundary and to
      // prove the empty artifact still survives publication and restore with exactly zero bytes.
      cases = [
        { source: "logo.png", destination: "screenshots/logo.png", bytes: png, policyId: RAW_ARTIFACT_POLICY_ID },
        { source: "dossier.pdf", destination: "reports/dossier.pdf", bytes: pdf, policyId: RAW_ARTIFACT_POLICY_ID },
        { source: "dispatch.log", destination: "logs/dispatch.log", bytes: log, policyId: RAW_ARTIFACT_POLICY_ID },
        { source: "empty.bin", destination: "reports/empty.bin", bytes: empty, policyId: OPAQUE_TEXTUAL_POLICY_ID },
      ];
    for (const { source, destination, bytes, policyId } of cases) {
      const raw = policyId === RAW_ARTIFACT_POLICY_ID;
      writeFileSync(path.join(rootDir, source), bytes);
      const added = (await cell.run(
        { kind: "task-artifact-add", taskId: "task-raw", source, destination },
        binding,
      )) as Record<string, unknown>;
      assert.equal(added.outcome, "applied", `${destination}: ${JSON.stringify(added)}`);
      const logical = String(added.destination);
      assert.equal(logical, `${packagePath}/artifacts/${destination}`, "the artifact keeps its real filename");
      const event = reader.readEvent(String(added.opId));
      assert.equal(event?.schema, "doc-event/v1", `${destination}: no doc event`);
      if (event?.schema !== "doc-event/v1") continue;
      const change = event.payload.changes[0]!;
      assert.deepEqual(
        [change.path, change.policyId, change.candidate.mediaType, change.regionProofs],
        [logical, policyId, raw ? RAW_ARTIFACT_MEDIA_TYPE : OPAQUE_TEXTUAL_MEDIA_TYPE, []],
        `${destination}: claim shape`,
      );
      assert.deepEqual(
        [change.candidate.sha256, change.candidate.size],
        [sha256Bytes(bytes), bytes.byteLength],
        `${destination}: the claim addresses the original bytes`,
      );
      assert.deepEqual(event.actor, actor, `${destination}: the doc event carries the real owner`);
      assert.equal(event.source, "local", `${destination}: the doc event carries the real write source`);
      // Durability order: the content object is readable at the accepted cut that carries the claim.
      assert.deepEqual(
        Buffer.from(reader.readContentBlob(change.candidate.sha256)!),
        bytes,
        `${destination}: accepted bytes are durable and unmodified`,
      );
      await waitForFixturePublication(cell, String(added.opId), binding);
      assert.deepEqual(
        readFileSync(path.join(rootDir, "harness", ...logical.split("/"))),
        bytes,
        `${destination}: authored bytes equal source bytes`,
      );
      assert.deepEqual(
        gitBytes(rootDir, `harness/${logical}`),
        bytes,
        `${destination}: the ledger Git cut holds the same bytes`,
      );
      // Discovery names the route instead of printing an empty body or claiming the file is missing.
      const shown = (await cell.run({ kind: "doc-show", path: logical }, binding)) as Record<string, unknown>;
      if (raw) {
        assert.equal(shown.outcome, "op_rejected", `${destination}: ${JSON.stringify(shown)}`);
        assert.equal(shown.code, "document_not_text");
        assert.match(String(shown.evidence), /raw task artifact/u);
        assert.match(String(shown.evidence), new RegExp(change.candidate.sha256, "u"));
      } else {
        assert.equal(shown.outcome, "applied", `${destination}: ${JSON.stringify(shown)}`);
        assert.deepEqual(Buffer.from(String(shown.evidence), "utf8"), bytes);
      }
    }
    const beforeMaterialize = reader.readHead();
    rmSync(path.join(rootDir, "harness", "tasks"), { recursive: true, force: true });
    const materialized = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(materialized.outcome, "applied", JSON.stringify(materialized));
    assert.deepEqual(reader.readHead(), beforeMaterialize, "restore must not admit a new command");
    for (const { destination, bytes } of cases)
      assert.deepEqual(
        readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", ...destination.split("/"))),
        bytes,
        `${destination}: restore reproduces the original bytes`,
      );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("two executions producing the same raw report basename keep both artifacts and their own bytes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-basename-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-raw-basename"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-raw-basename" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-basename", title: "Basename" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-basename-basename",
      reader = makeTaskEventReader({ repoId, rootDir }),
      first = Buffer.concat([Buffer.from([0xff, 0x01]), Buffer.from("execution one\n")]),
      second = Buffer.concat([Buffer.from([0xff, 0x02]), Buffer.from("execution two\n")]);
    writeFileSync(path.join(rootDir, "one.bin"), first);
    writeFileSync(path.join(rootDir, "two.bin"), second);
    const left = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-basename", source: "one.bin", destination: "exec-a/result.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(left.outcome, "applied", JSON.stringify(left));
    await waitForFixturePublication(cell, String(left.opId), binding);
    const right = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-basename", source: "two.bin", destination: "exec-b/result.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(right.outcome, "applied", JSON.stringify(right));
    await waitForFixturePublication(cell, String(right.opId), binding);
    assert.notEqual(String(left.destination), String(right.destination));
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", "exec-a", "result.bin")),
      first,
      "the first execution still owns its own bytes",
    );
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", "exec-b", "result.bin")),
      second,
      "the second execution owns different bytes under the same basename",
    );
    for (const [opId, bytes] of [
      [String(left.opId), first],
      [String(right.opId), second],
    ] as const) {
      const event = reader.readEvent(opId);
      assert.equal(event?.schema, "doc-event/v1");
      if (event?.schema !== "doc-event/v1") continue;
      assert.equal(event.payload.changes[0]!.candidate!.sha256, sha256Bytes(bytes), "each claim keeps its own digest");
    }
    // The same destination twice is a collision, not an overwrite: the first bytes survive untouched.
    const collided = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-basename", source: "two.bin", destination: "exec-a/result.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(collided.code, "artifact_collision", JSON.stringify(collided));
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", "exec-a", "result.bin")),
      first,
      "a rejected second write must not replace the accepted bytes",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a raw publication that fails leaves no accepted artifact and no raw claim outside a task subtree", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-failure-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-raw-failure"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-raw-failure" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-fail", title: "Fail" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-fail-fail",
      reader = makeTaskEventReader({ repoId, rootDir }),
      before = reader.readHead(),
      oversized = path.join(rootDir, "huge.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, RAW_ARTIFACT_MAX_BYTES + 1);
    const rejected = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-fail", source: "huge.bin", destination: "reports/huge.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(rejected.code, "artifact_too_large", JSON.stringify(rejected));
    assert.notEqual(rejected.outcome, "applied");
    assert.equal(
      existsSync(path.join(rootDir, "harness", packagePath, "artifacts", "reports", "huge.bin")),
      false,
      "a refused required publication must not appear as a materialized artifact",
    );
    assert.deepEqual(reader.readHead(), before, "a refused publication must not advance the accepted cut");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
  const confinementRoot = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-confine-"));
  initRepo(confinementRoot);
  try {
    const store = makeTaskEventStore({ repoId: workspaceId("artifact-raw-confine"), rootDir: confinementRoot }),
      bytes = png,
      sha = sha256Bytes(bytes),
      target = documentPath("context/architecture/logo.png"),
      decision = decideDocWrite({
        intent: parseDocWriteIntent(
          {
            schema: "doc-write-intent/v1",
            executionId: null,
            baseLedgerSha: store.currentCut(),
            changes: [
              {
                path: target,
                baseBlobSha256: null,
                policyId: RAW_ARTIFACT_POLICY_ID,
                candidate: {
                  ref: `doc-sync-claims/${sha}`,
                  sha256: sha,
                  size: bytes.byteLength,
                  mediaType: RAW_ARTIFACT_MEDIA_TYPE,
                },
              },
            ],
          },
          workspaceId("artifact-raw-confine"),
        ),
        opId: "confine",
        eventId: "confine",
        workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
        actor,
        source: "local",
        occurredAt: new Date().toISOString(),
        currentLedgerSha: store.currentCut(),
        lease: null,
        authorizationDecision: null,
        documents: [null],
        claims: [bytes],
      });
    assert.equal(decision.accepted, false, "raw bytes outside a task artifacts subtree must not be accepted");
    if (decision.accepted) return;
    assert.equal(decision.code, "unresolved_touch");
    assert.equal(decision.detail.unresolvedTouches[0]?.requiredRoute, "task-artifact-add");
  } finally {
    rmSync(confinementRoot, { recursive: true, force: true });
  }
});

test("doc status routes a new JSON task artifact to artifact add and accepts same-path takeover", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-json-route-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-json-route"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-json-route" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run({ kind: "task-create", taskId: "task-json", title: "JSON Artifact" }, binding)) as {
      readonly outcome: string;
      readonly packagePath: string;
    };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const logical = `${created.packagePath}/artifacts/report.json`,
      target = path.join(rootDir, "harness", ...logical.split("/")),
      bytes = Buffer.from('{"schema":"report/v1","ok":true}\n');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as Record<string, unknown>,
      rows = JSON.parse(String(status.evidence).slice("doc-scan:".length)) as {
        readonly rows: readonly { readonly state: string; readonly reason: string | null }[];
      };
    assert.deepEqual(
      [rows.rows[0]?.state, rows.rows[0]?.reason],
      [
        "inapplicable",
        `task artifact is outside doc sync; publish it with ha task artifact add task-json ` +
          `--source harness/${logical} --destination artifacts/report.json`,
      ],
    );
    assert.match(
      String((status.detail as { readonly nextAction?: string }).nextAction),
      /^ha task artifact add task-json/u,
    );
    const added = (await cell.run(
      {
        kind: "task-artifact-add",
        taskId: "task-json",
        source: `harness/${logical}`,
        destination: "artifacts/report.json",
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    assert.deepEqual(readFileSync(target), bytes, "same-path takeover preserves the original bytes");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc status uses the configured authored root and quotes artifact source paths", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-configured-root-"));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: ledger\n  localRoot: .harness\n",
  );
  const repoId = workspaceId("artifact-configured-root"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-configured-root" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-configured", title: "Configured Root" },
      binding,
    )) as { readonly outcome: string; readonly packagePath: string };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const logical = `${created.packagePath}/artifacts/report (final).pdf`,
      target = path.join(rootDir, "ledger", ...logical.split("/")),
      bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(DOC_SYNC_INLINE_MAX_BYTES + 1, 0xff)]);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as Record<string, unknown>;
    const rows = JSON.parse(String(status.evidence).slice("doc-scan:".length)) as {
      readonly rows: readonly {
        readonly state: string;
        readonly reason: string | null;
        readonly size: number | null;
        readonly candidateBlobSha256: string | null;
      }[];
    };
    assert.deepEqual(
      [rows.rows[0]?.state, rows.rows[0]?.size, rows.rows[0]?.candidateBlobSha256],
      ["inapplicable", bytes.byteLength, null],
      JSON.stringify(rows),
    );
    assert.match(
      rows.rows[0]?.reason ?? "",
      /'ledger\/tasks\/task-configured-configured-root\/artifacts\/report \(final\)\.pdf'/u,
    );
    assert.equal(
      (status.detail as { readonly nextAction?: string }).nextAction,
      "ha task artifact add task-configured --source 'ledger/tasks/task-configured-configured-root/artifacts/report (final).pdf' " +
        "--destination 'artifacts/report (final).pdf'",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc status nextAction round-trips when the authored root is its own nested Git repository", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-nested-ledger-"));
  initRepo(rootDir);
  // Canonical layout: the authored root is an independent Git repository nested inside the
  // product repository. The prefix relative to the ledger Git top level is then empty, so the
  // artifact add source must be derived from the product root, not from the ledger prefix.
  const ledgerRoot = path.join(rootDir, "harness");
  mkdirSync(ledgerRoot, { recursive: true });
  git(ledgerRoot, "init", "-q");
  git(ledgerRoot, "config", "user.name", "Doc Raw Test");
  git(ledgerRoot, "config", "user.email", "doc-raw@example.invalid");
  git(ledgerRoot, "config", "gc.auto", "0");
  writeFileSync(path.join(ledgerRoot, ".gitkeep"), "");
  git(ledgerRoot, "add", ".gitkeep");
  git(ledgerRoot, "commit", "-qm", "ledger base");
  const repoId = workspaceId("artifact-nested-ledger"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-nested-ledger" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-nested", title: "Nested Ledger" },
      binding,
    )) as { readonly outcome: string; readonly packagePath: string };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const logical = `${created.packagePath}/artifacts/report.json`,
      target = path.join(ledgerRoot, ...logical.split("/")),
      bytes = Buffer.from('{"schema":"report/v1","nested":true}\n');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as Record<string, unknown>,
      nextAction = String((status.detail as { readonly nextAction?: string }).nextAction),
      routed = /^ha task artifact add (\S+) --source ('[^']*'|\S+) --destination ('[^']*'|\S+)$/u.exec(nextAction),
      unquote = (token: string): string => token.replace(/^'(.*)'$/u, "$1");
    assert.ok(routed, nextAction);
    assert.equal(unquote(routed[2]!), `harness/${logical}`, nextAction);
    assert.equal(unquote(routed[3]!), "artifacts/report.json", nextAction);
    const added = (await cell.run(
      {
        kind: "task-artifact-add",
        taskId: routed[1]!,
        source: unquote(routed[2]!),
        destination: unquote(routed[3]!),
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    assert.equal(added.source, `harness/${logical}`);
    assert.deepEqual(readFileSync(target), bytes, "same-path takeover preserves the original bytes");
    await waitForFixturePublication(cell, String(added.opId), binding);
    assert.deepEqual(gitBytes(ledgerRoot, logical), bytes, "the nested ledger Git cut holds the same bytes");
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
  git(rootDir, "config", "user.name", "Doc Raw Test");
  git(rootDir, "config", "user.email", "doc-raw@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
