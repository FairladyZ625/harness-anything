// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, sha256Text } from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  git,
  initRepo,
  opaqueTextualMediaType,
  rows,
  write,
} from "./doc-sync-slice-a.fixtures.ts";
test("status, dry-run, and submit share the repeatable-path scanner and automatic base", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-scanner-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("scanner"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "scanner-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/a.md", "# A\n\nfirst\n");
    write(rootDir, "context/b.md", "# B\n\nsecond\n");
    write(rootDir, "tasks/task-one/progress.md", "# Progress\n");
    write(rootDir, "tasks/task-one/artifacts/data.json", "{}\n");
    write(rootDir, "context/ignored.json", "{}\n");
    const before = git(rootDir, "rev-parse", "HEAD"),
      status = await cell.run({ kind: "doc-status", paths: [] }, binding),
      statusRows = rows(status.evidence);
    assert.deepEqual(
      statusRows.map((row) => [row.path, row.state]),
      [
        ["context/a.md", "eligible"],
        ["context/b.md", "eligible"],
        ["tasks/task-one/artifacts/data.json", "eligible"],
        ["tasks/task-one/progress.md", "blocked"],
      ],
    );
    assert.equal(
      statusRows.find((row) => row.path.endsWith("artifacts/data.json"))
        ?.mediaType,
      opaqueTextualMediaType,
    );
    assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const dry = await cell.run(
      { kind: "doc-dry-run", paths: ["context/a.md", "context/b.md"] },
      binding,
    );
    assert.equal(dry.outcome, "pending");
    assert.equal(dry.proof?.canonicalVisible, false);
    assert.deepEqual(rows(dry.evidence), statusRows.slice(0, 2));
    assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const submitted = await cell.run(
      { kind: "doc-submit", paths: ["context/a.md"] },
      binding,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(submitted.commitSha, null);
    const event = makeTaskEventStore({ repoId: "scanner", rootDir }).readEvent(
      submitted.opId,
    );
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      assert.deepEqual(
        event.payload.baseLedgerSha,
        (
          JSON.parse(status.evidence!.slice("doc-scan:".length)) as {
            baseLedgerSha: unknown;
          }
        ).baseLedgerSha,
      );
      assert.equal(event.payload.executionId, null);
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        ["context/a.md"],
      );
    }
    assert.deepEqual(
      git(rootDir, "status", "--porcelain", "-uall")
        .split("\n")
        .filter((line) => line.includes(" harness/"))
        .sort(),
      [
        "?? harness/context/a.md",
        "?? harness/context/b.md",
        "?? harness/context/ignored.json",
        "?? harness/tasks/task-one/artifacts/data.json",
        "?? harness/tasks/task-one/progress.md",
      ],
    );
    write(rootDir, "context/a.md", "# Renamed\n\nfirst\n");
    const acceptedCut = git(rootDir, "rev-parse", "HEAD"),
      blocked = await cell.run(
        { kind: "doc-dry-run", paths: ["context/a.md"] },
        binding,
      );
    assert.equal(rows(blocked.evidence)[0]?.state, "blocked");
    assert.match(
      blocked.detail?.nextAction ?? "",
      /listed blocked candidates/u,
    );
    assert.doesNotMatch(
      blocked.detail?.nextAction ?? "",
      /doc retire|conflict scratch/iu,
    );
    const rejected = await cell.run(
      { kind: "doc-submit", paths: ["context/a.md"] },
      binding,
    );
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "preview_blocked");
    assert.equal(git(rootDir, "rev-parse", "HEAD"), acceptedCut);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("selected doc-sync paths are authored-relative candidates and zero-write submit is rejected", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-selection-"));
  initRepo(rootDir);
  const repoId = workspaceId("selection"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "selection-daemon" }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/selected.md", "# Selected\n");
    const authored = await cell.run({ kind: "doc-submit", paths: ["context/selected.md"] }, binding);
    assert.equal(authored.outcome, "applied", JSON.stringify(authored));
    assert.match(String((authored as Record<string, unknown>).summary), /applied count: 1/u);

    const repoRelative = await cell.run({ kind: "doc-submit", paths: ["harness/context/selected.md"] }, binding);
    assert.equal(repoRelative.outcome, "op_rejected", JSON.stringify(repoRelative));
    assert.equal(repoRelative.code, "invalid_command");
    assert.match(repoRelative.nextAction ?? "", /authored-root-relative/u);

    const missing = await cell.run({ kind: "doc-submit", paths: ["context/missing.md"] }, binding);
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    assert.equal(missing.code, "document_not_found");

    const clean = await cell.run({ kind: "doc-submit", paths: ["context/selected.md"] }, binding);
    assert.equal(clean.outcome, "op_rejected", JSON.stringify(clean));
    assert.equal(clean.code, "no_changes");
    assert.match(String((clean as Record<string, unknown>).summary), /applied count: 0/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc retire deletes one projected document and returns an auditable retirement receipt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-retire-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("retire"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "retire-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = "context/temporary.md",
    reason = "superseded temporary evidence";
  try {
    write(rootDir, logical, "# Temporary\n\nRetire me.\n");
    const submitted = await cell.run(
      { kind: "doc-submit", paths: [logical] },
      binding,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    rmSync(path.join(rootDir, "harness", logical));
    const mutation = await cell.run(
      { kind: "doc-status", paths: [logical] },
      binding,
    );
    assert.equal(rows(mutation.evidence)[0]?.state, "deletion");
    assert.match(
      mutation.detail?.nextAction ?? "",
      new RegExp(`ha doc retire --path ${logical}`, "u"),
    );
    assert.doesNotMatch(mutation.detail?.nextAction ?? "", /resolve blocked/iu);
    const retired = await cell.run(
      { kind: "doc-retire", path: logical, reason },
      binding,
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    assert.equal(retired.proof?.canonicalVisible, true);
    assert.equal(retired.proof?.worktreeVisible, true);
    assert.match(retired.evidence ?? "", /^doc-retirement:/u);
    const receipt = JSON.parse(
      (retired.evidence ?? "").slice("doc-retirement:".length),
    ) as {
      readonly schema: string;
      readonly path: string;
      readonly reason: string;
    };
    assert.deepEqual(receipt, {
      schema: "doc-retirement-receipt/v1",
      path: logical,
      baseBlobSha256: sha256Text("# Temporary\n\nRetire me.\n"),
      reason,
    });
    const event = makeTaskEventStore({ repoId: "retire", rootDir }).readEvent(
      retired.opId,
    );
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      assert.equal(event.payload.retirementReason, reason);
      assert.equal(event.payload.changes[0]?.candidate, null);
    }
    const shown = await cell.run({ kind: "doc-show", path: logical }, binding);
    assert.equal(shown.code, "document_not_found");
    assert.equal(
      git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`),
      "",
    );
    assert.equal(
      rows(
        (await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence,
      ).some((row) => row.state === "deletion"),
      false,
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc retire follows status for a Git-tracked document that was never projected", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-retire-tracked-"));
  initRepo(rootDir);
  const logical = "tmp/legacy-tracked.md",
    body = "# Legacy tracked document\n",
    reason = "retire pre-doc-sync ledger debt";
  write(rootDir, logical, body);
  git(rootDir, "add", `harness/${logical}`);
  git(rootDir, "commit", "-qm", "track legacy document");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined =
    await openRepoCell({
      repoId: workspaceId("retire-tracked"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "retire-tracked-daemon",
    });
  const binding = { actor, source: "local" as const };
  try {
    rmSync(path.join(rootDir, "harness", logical));
    const status = await cell.run({ kind: "doc-status", paths: [] }, binding);
    assert.deepEqual(
      rows(status.evidence).map((row) => [row.path, row.state]),
      [[logical, "deletion"]],
    );
    assert.match(
      status.detail?.nextAction ?? "",
      new RegExp(`ha doc retire --path ${logical}`, "u"),
    );

    const retired = await cell.run(
      { kind: "doc-retire", path: logical, reason },
      binding,
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    assert.match(retired.evidence ?? "", /^doc-retirement:/u);
    assert.equal(
      makeTaskEventStore({ repoId: "retire-tracked", rootDir }).readEvent(
        retired.opId,
      )?.schema,
      "doc-event/v1",
    );
    assert.equal(
      rows(
        (await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence,
      ).some((row) => row.state === "deletion"),
      false,
    );
    await cell.close();
    cell = undefined;
    assert.equal(
      git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`),
      "",
    );
    assert.equal(
      git(rootDir, "status", "--porcelain", "--untracked-files=no"),
      "",
    );
    const reopened = await openRepoCell({
      repoId: workspaceId("retire-tracked"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "retire-tracked-reopened",
    });
    try {
      assert.deepEqual(
        rows(
          (await reopened.run({ kind: "doc-status", paths: [] }, binding))
            .evidence,
        ),
        [],
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("new non-textual artifacts are inapplicable while binary replacement of canonical text remains blocked", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-non-textual-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("non-textual"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "non-textual-daemon",
    }),
    binding = { actor, source: "local" as const },
    fresh = "tasks/task-proof/artifacts/screenshots/evidence.png",
    tracked = "tasks/task-proof/artifacts/report.bin";
  try {
    const freshTarget = path.join(rootDir, "harness", fresh);
    mkdirSync(path.dirname(freshTarget), { recursive: true });
    writeFileSync(
      freshTarget,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
    );
    const status = await cell.run(
        { kind: "doc-status", paths: [fresh] },
        binding,
      ),
      row = rows(status.evidence)[0] as
        { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual(
      [row?.state, row?.reason],
      ["inapplicable", "non-textual artifact is outside doc sync"],
    );
    assert.deepEqual(status.detail?.unresolvedTouches, []);
    assert.equal(
      status.detail?.nextAction,
      "no action required; inapplicable candidates are outside doc sync",
    );
    const noOp = (await cell.run(
      { kind: "doc-submit", paths: [fresh] },
      binding,
    )) as Record<string, unknown>;
    assert.equal(noOp.outcome, "op_rejected");
    assert.equal(noOp.code, "no_changes");
    assert.match(String(noOp.summary), /applied count: 0/u);
    assert.match(String(noOp.opId), /^noop:/u);

    write(rootDir, tracked, "textual baseline\n");
    assert.equal(
      (await cell.run({ kind: "doc-submit", paths: [tracked] }, binding))
        .outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "harness", tracked),
      Buffer.from([0xff, 0x00]),
    );
    const blocked = await cell.run(
      { kind: "doc-status", paths: [tracked] },
      binding,
    );
    assert.equal(rows(blocked.evidence)[0]?.state, "blocked");
    assert.equal(
      blocked.detail?.unresolvedTouches[0]?.requiredRoute,
      "typed-binary-content",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("people-registry ownership is inapplicable while typed writable routes remain blocked", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-owned-route-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("owned-route"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "owned-route-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(
      rootDir,
      "people.yaml",
      "schema: harness-people/v1\npeople: []\nroles: []\n",
    );
    write(
      rootDir,
      "harness.yaml",
      "schema: harness-anything/v1\nname: hand-edited\n",
    );
    const people = await cell.run(
        { kind: "doc-status", paths: ["people.yaml"] },
        binding,
      ),
      peopleRow = rows(people.evidence)[0] as
        { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual(
      [peopleRow?.state, peopleRow?.reason],
      [
        "inapplicable",
        "path is owned by people-registry and is outside doc sync",
      ],
    );
    assert.deepEqual(people.detail?.unresolvedTouches, []);
    assert.equal(
      people.detail?.nextAction,
      "no action required; inapplicable candidates are outside doc sync",
    );
    const noOp = await cell.run(
      { kind: "doc-submit", paths: ["people.yaml"] },
      binding,
    );
    assert.equal(noOp.outcome, "op_rejected");
    assert.equal(noOp.code, "no_changes");
    assert.match(String(noOp.summary), /applied count: 0/u);
    assert.match(noOp.opId, /^noop:/u);

    const workspace = await cell.run(
        { kind: "doc-status", paths: ["harness.yaml"] },
        binding,
      ),
      workspaceRow = rows(workspace.evidence)[0] as
        { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual(
      [workspaceRow?.state, workspaceRow?.reason],
      ["blocked", "path is owned by workspace-config"],
    );
    assert.equal(
      workspace.detail?.unresolvedTouches[0]?.requiredRoute,
      "workspace-config",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
