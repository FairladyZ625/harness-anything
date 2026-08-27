// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { DOC_COMMAND_FRAME_MAX_BYTES } from "../src/doc-sync-actions.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { type RepoCellBinding } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell, seedSettingsEvent } from "./repo-settings.fixture.ts";

const policyId = "markdown-body-replaceable/v1";
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const assignmentSource = { kind: "assignment", nodeId: "node-one", assignmentId: "assignment-one" } as const;

test("local doc submit rejects the retired selection assembler", async () => {
  const fixture = await docCell("retired-selection");
  try {
    const cut = await startLease(fixture.cell, "local");
    const relativePath = "tasks/task-doc-docs/notes.md";
    writeAuthored(fixture.rootDir, relativePath, "# Notes\n");
    const result = await fixture.cell.run(
      {
        kind: "doc-submit",
        executionId: "execution-doc",
        baseLedgerSha: cut,
        selections: [{ path: relativePath, baseBlobSha256: null }],
      },
      { actor, source: "local" },
    );
    assert.equal(result.outcome, "op_rejected");
    assert.equal(result.code, "invalid_command");
  } finally {
    await fixture.close();
  }
});

test("local selection and assignment claim normalize to the same doc event through RepoCell.run", async () => {
  const local = await docCell("local"),
    remote = await docCell("remote");
  try {
    await startLease(local.cell, "local");
    const remoteCut = await startLease(remote.cell, assignmentSource);
    const body = "# Notes\n\nShared candidate.\n",
      hash = sha(body),
      relativePath = "tasks/task-doc-docs/notes.md";
    writeAuthored(local.rootDir, relativePath, body);
    writeClaim(remote.rootDir, "remote", body);
    const localResult = await local.cell.run(
      { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] },
      { actor, source: "local" },
    );
    const remoteBinding = assignmentBinding("remote", [relativePath]);
    const remoteResult = await remote.cell.run(
      {
        kind: "doc-submit",
        executionId: "execution-doc",
        baseLedgerSha: remoteCut,
        changes: [
          {
            path: relativePath,
            baseBlobSha256: null,
            policyId,
            candidate: {
              ref: "doc-sync-claims/remote",
              sha256: hash,
              size: Buffer.byteLength(body),
              mediaType: "text/markdown",
            },
          },
        ],
      },
      remoteBinding,
    );
    assert.equal(localResult.outcome, "applied", JSON.stringify(localResult));
    assert.equal(remoteResult.outcome, "applied", JSON.stringify(remoteResult));
    const localEvent = makeTaskEventStore({ repoId: "local", rootDir: local.rootDir }).readEvent(localResult.opId);
    const remoteEvent = makeTaskEventStore({ repoId: "remote", rootDir: remote.rootDir }).readEvent(remoteResult.opId);
    assert.equal(localEvent?.schema, "doc-event/v1");
    assert.equal(remoteEvent?.schema, "doc-event/v1");
    if (localEvent?.schema === "doc-event/v1" && remoteEvent?.schema === "doc-event/v1")
      assert.deepEqual(localEvent.payload.changes, remoteEvent.payload.changes);
    assert.deepEqual(remoteResult.proof?.worktreeVisible, null);
    assert.equal("gitCredential" in remoteBinding, false);
  } finally {
    await local.close();
    await remote.close();
  }
});

test("Decision prose is an explicit idempotent doc-sync region in the canonical authored document", async () => {
  const fixture = await docCell("decision-prose");
  try {
    await startLease(fixture.cell, "local");
    const binding = { actor, source: "local" as const };
    const proposed = await fixture.cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Body join",
          question: "Should the body remain doc-sync owned?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "default",
          preset: "default",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Use doc-sync" }],
          rejected: [{ id: "RJ1", text: "Inline body", whyNot: "It duplicates content storage" }],
          claims: [],
          fulfillments: [],
          relations: [],
        }),
      },
      binding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId;
    const relativePath = `decisions/decision-${decisionId}/decision.md`,
      initial = JSON.parse(
        (await fixture.cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence,
      ) as { decision: { body: { body: string } } };
    assert.equal(initial.decision.body.body, "\n# Body join\n");
    const machine = readFileSync(path.join(fixture.rootDir, "harness", relativePath), "utf8").replace(
        /\n# Body join\n$/u,
        "",
      ),
      firstProse = "\n# Body join\n\nFirst paragraph.\n",
      firstBody = `${machine}${firstProse}`,
      firstHash = sha(firstBody);
    writeAuthored(fixture.rootDir, relativePath, firstBody);
    const firstAction = { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] } as const;
    const first = await fixture.cell.run(firstAction, binding);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal(first.authorizationDecision?.policyRef, "default@2");
    assert.equal(first.authorizationDecision?.outcome, "allowed");
    const retried = await fixture.cell.run(firstAction, binding);
    assert.equal(retried.outcome, "no_changes");
    assert.equal(retried.code, "no_changes");
    assert.match(retried.opId, /^noop:/u);
    assert.equal(retried.revision, first.revision);
    const joined = JSON.parse(
      (await fixture.cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence,
    ) as { decision: { body: { body: string; blobSha256: string; size: number; path: string } } };
    assert.deepEqual(joined.decision.body, {
      body: firstProse,
      blobSha256: firstHash,
      size: Buffer.byteLength(firstBody),
      path: relativePath,
      mediaType: "text/markdown",
      workspaceRevision: first.revision,
    });
    const store = makeTaskEventStore({ repoId: "decision-prose", rootDir: fixture.rootDir }),
      event = store.readEvent(first.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      const claim = event.payload.changes[0]!.candidate,
        blob = store.readContentBlob(claim.sha256);
      assert.equal(blob?.byteLength, claim.size);
      assert.equal(sha(Buffer.from(blob!).toString("utf8")), claim.sha256);
    }
    const firstList = JSON.parse(
      (await fixture.cell.run({ kind: "decision-list", search: "paragraph" }, binding)).evidence,
    ) as { decisions: readonly Record<string, unknown>[] };
    assert.deepEqual(
      firstList.decisions.map(({ decisionId: id }) => id),
      [decisionId],
    );
    assert.equal(Object.hasOwn(firstList.decisions[0]!, "body"), false);
    const gui = await fixture.cell.read("repo.decisions.list");
    assert.deepEqual(
      gui.decisions.map(({ decisionId: id }) => id),
      firstList.decisions.map(({ decisionId: id }) => id),
    );
    const secondProse = "\n# Body join\n\nReplacement needle.\n",
      secondBody = `${machine}${secondProse}`;
    writeAuthored(fixture.rootDir, relativePath, secondBody);
    const second = await fixture.cell.run(
      { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] },
      binding,
    );
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const updated = JSON.parse(
      (await fixture.cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence,
    ) as { decision: { body: { body: string; blobSha256: string } } };
    assert.equal(updated.decision.body.body, secondProse);
    assert.equal(updated.decision.body.blobSha256, sha(secondBody));
    assert.equal(
      (
        JSON.parse((await fixture.cell.run({ kind: "decision-list", search: "paragraph" }, binding)).evidence) as {
          decisions: readonly unknown[];
        }
      ).decisions.length,
      0,
    );
    assert.deepEqual(
      (
        JSON.parse((await fixture.cell.run({ kind: "decision-list", search: "Replacement" }, binding)).evidence) as {
          decisions: readonly { decisionId: string }[];
        }
      ).decisions.map(({ decisionId: id }) => id),
      [decisionId],
    );
    writeAuthored(fixture.rootDir, relativePath, `${secondBody}Unsynced.\n`);
    const redacted = JSON.parse(
      (await fixture.cell.run({ kind: "decision-show", decisionId, includeBody: false }, binding)).evidence,
    ) as { decision: { body: unknown } };
    assert.equal(redacted.decision.body, null);
    assert.equal(
      (
        JSON.parse(
          (await fixture.cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence,
        ) as { decision: { body: { body: string } } }
      ).decision.body.body,
      secondProse,
    );
  } finally {
    await fixture.close();
  }
});

test("doc submit returns holder and scope detail for wrong role, another holder, expiry, and assignment scope", async () => {
  const fixture = rbacFixture();
  const host = await openDaemonHost({ daemonId: "doc-rbac", userRoot: fixture.userRoot });
  await host.attachmentsSettled();
  const auth = (ownerUid: number) =>
    ({
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" },
    }) as const;
  try {
    seedSettingsEvent({ rootDir: fixture.rootDir, repoId: "rbac" });
    await host.admin({ kind: "register", rootDir: fixture.rootDir, repoId: "rbac" }, auth(fixture.ids.admin));
    assert.equal(
      (await host.run("rbac", { kind: "task-create", taskId: "task-doc", title: "Docs" }, auth(fixture.ids.writer)))
        .outcome,
      "applied",
    );
    const started = await host.run(
      "rbac",
      { kind: "task-start", taskId: "task-doc", executionId: "execution-doc" },
      auth(fixture.ids.writer),
    );
    assert.equal(started.outcome, "applied");
    const relativePath = "tasks/task-doc-docs/notes.md",
      body = "# Notes\n",
      action = { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] } as const;
    writeAuthored(fixture.rootDir, relativePath, body);
    const before = ledgerCut(started.cut);
    const denied = await host.run("rbac", action, auth(fixture.ids.reader));
    assert.equal(denied.code, "rbac_forbidden");
    assert.equal(denied.detail?.holder?.personId, "writer");
    assert.equal(denied.detail?.unresolvedTouches[0]?.requiredRoute, "repo-write");
    assert.deepEqual(denied.detail?.currentLedgerSha, before);
    assert.equal(existsSync(claimPath(fixture.rootDir, sha(body))), false);
    const other = await host.run("rbac", action, auth(fixture.ids.otherWriter));
    assert.equal(other.code, "lease_conflict");
    assert.equal(other.detail?.holder?.personId, "writer");
    assert.deepEqual(other.detail?.currentLedgerSha, before);
    assert.equal((await host.run("rbac", action, auth(fixture.ids.writer))).outcome, "applied");
    const shown = await host.run("rbac", { kind: "doc-show", path: relativePath }, auth(fixture.ids.reader));
    assert.equal(shown.outcome, "applied");
    assert.equal(shown.evidence, body);
  } finally {
    await host.close();
    fixture.close();
  }

  let now = "2026-08-12T00:00:00.000Z";
  const expired = await docCell("expired", () => now);
  try {
    const before = await startLease(expired.cell, "local", 30 * 60 * 1_000);
    const relativePath = "tasks/task-doc-docs/expired.md",
      body = "# Expired\n";
    writeAuthored(expired.rootDir, relativePath, body);
    now = "2026-08-12T01:00:00.000Z";
    const result = await expired.cell.run(
      { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] },
      { actor, source: "local" },
    );
    assert.equal(result.code, "lease_conflict");
    assert.equal(result.detail?.holder?.executionId, "execution-doc");
    assert.equal(result.detail?.holder?.expiresAt, "2026-08-12T00:30:00.000Z");
    assert.deepEqual(result.detail?.currentLedgerSha, before);
  } finally {
    await expired.close();
  }

  const scoped = await docCell("scoped");
  try {
    const before = await startLease(scoped.cell, assignmentSource);
    const body = "# Scoped\n",
      relativePath = "tasks/task-doc-docs/outside.md";
    writeClaim(scoped.rootDir, "scoped", body);
    const result = await scoped.cell.run(
      remoteAction(before, relativePath, "scoped", body),
      assignmentBinding("scoped", ["tasks/task-doc-docs/inside.md"]),
    );
    assert.equal(result.code, "assignment_scope_mismatch");
    assert.equal(result.detail?.holder?.personId, "person-owner");
    assert.match(result.detail?.unresolvedTouches[0]?.requiredRoute ?? "", /assignment-one.*inside\.md/u);
    assert.deepEqual(result.detail?.currentLedgerSha, before);
    assert.equal(existsSync(path.join(scoped.rootDir, ".harness/doc-sync-claims/scoped")), false);
    writeClaim(scoped.rootDir, "identity", body);
    const identityBinding = assignmentBinding("scoped", [relativePath]);
    // W3-C: the assignment's static taskId/executionId labels no longer veto a
    // task-document write — design-v2 §3 makes the dynamically acquired lease
    // the task-context authority (decideDocWrite arbitrates holder, execution,
    // and write channel), and a node-level roster cannot name every task a
    // W3-B automatic lease will grant. Path scope plus lease arbitration fully
    // bind this write, so the mislabeled scope no longer rejects it.
    const identity = await scoped.cell.run(remoteAction(before, relativePath, "identity", body), {
      ...identityBinding,
      assignmentScope: {
        ...identityBinding.assignmentScope!,
        scope: { ...identityBinding.assignmentScope!.scope, taskId: "task-other" },
      },
    });
    assert.equal(identity.outcome, "applied", JSON.stringify(identity).slice(0, 400));
    assert.equal(existsSync(path.join(scoped.rootDir, ".harness/doc-sync-claims/identity")), false);
  } finally {
    await scoped.close();
  }
});

test("claim-check keeps large bodies out of commands and recycles missing, hash, size, and rejected claims", async () => {
  const local = await docCell("large");
  try {
    await startLease(local.cell, "local");
    const relativePath = "tasks/task-doc-docs/large.md",
      body = `# Large\n${"x".repeat(DOC_COMMAND_FRAME_MAX_BYTES + 1)}\n`;
    writeAuthored(local.rootDir, relativePath, body);
    const action = { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] } as const;
    assert.equal(Buffer.byteLength(JSON.stringify(action)) < DOC_COMMAND_FRAME_MAX_BYTES, true);
    assert.equal(JSON.stringify(action).includes(body), false);
    const result = await local.cell.run(action, { actor, source: "local" });
    assert.equal(result.outcome, "applied", JSON.stringify(result));
    const event = makeTaskEventStore({ repoId: "large", rootDir: local.rootDir }).readEvent(result.opId);
    assert.equal(JSON.stringify(event).includes(body), false);
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(event.payload.changes[0]?.candidate, {
        sha256: sha(body),
        size: Buffer.byteLength(body),
        mediaType: "text/markdown",
      });
    assert.equal(existsSync(claimPath(local.rootDir, sha(body))), false);
  } finally {
    await local.close();
  }

  const remote = await docCell("claims");
  try {
    const before = await startLease(remote.cell, assignmentSource);
    const relativePath = "tasks/task-doc-docs/claim.md",
      body = "# Claim\n";
    const missing = await remote.cell.run(
      remoteAction(before, relativePath, "missing", body),
      assignmentBinding("claims", [relativePath]),
    );
    assert.equal(missing.code, "content_claim_mismatch");
    assert.deepEqual(missing.detail?.currentLedgerSha, before);
    writeClaim(remote.rootDir, "bad-hash", body);
    const badHash = remoteAction(before, relativePath, "bad-hash", body);
    const hashResult = await remote.cell.run(
      {
        ...badHash,
        changes: [{ ...badHash.changes[0]!, candidate: { ...badHash.changes[0]!.candidate!, sha256: "f".repeat(64) } }],
      },
      assignmentBinding("claims", [relativePath]),
    );
    assert.equal(hashResult.code, "content_claim_mismatch");
    assert.equal(existsSync(path.join(remote.rootDir, ".harness/doc-sync-claims/bad-hash")), false);
    writeClaim(remote.rootDir, "bad-size", body);
    const badSize = remoteAction(before, relativePath, "bad-size", body);
    const sizeResult = await remote.cell.run(
      {
        ...badSize,
        changes: [
          {
            ...badSize.changes[0]!,
            candidate: { ...badSize.changes[0]!.candidate!, size: Buffer.byteLength(body) + 1 },
          },
        ],
      },
      assignmentBinding("claims", [relativePath]),
    );
    assert.equal(sizeResult.code, "content_claim_mismatch");
    assert.equal(existsSync(path.join(remote.rootDir, ".harness/doc-sync-claims/bad-size")), false);
    assert.deepEqual(sizeResult.detail?.currentLedgerSha, before);
  } finally {
    await remote.close();
  }
});

async function docCell(repoId: string, now?: () => string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-doc-b-${repoId}-`));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: `daemon-${repoId}`,
    ...(now ? { now } : {}),
  });
  return {
    rootDir,
    cell,
    close: async () => {
      await cell.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
async function startLease(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  source: RepoCellBinding["source"],
  ttlMs?: number,
): Promise<unknown> {
  assert.equal(
    (await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, { actor, source })).outcome,
    "applied",
  );
  const started = await cell.run(
    { kind: "task-start", taskId: "task-doc", executionId: "execution-doc", ...(ttlMs === undefined ? {} : { ttlMs }) },
    { actor, source },
  );
  assert.equal(started.outcome, "applied");
  return ledgerCut(started.cut);
}
function assignmentBinding(repoId: string, paths: readonly string[]): RepoCellBinding {
  return {
    actor,
    source: assignmentSource,
    assignmentScope: {
      repoId,
      scope: { kind: "task", taskId: "task-doc", executionId: "execution-doc", paths },
    },
  };
}
function remoteAction(baseLedgerSha: unknown, relativePath: string, ref: string, body: string) {
  return {
    kind: "doc-submit",
    executionId: "execution-doc",
    baseLedgerSha,
    changes: [
      {
        path: relativePath,
        baseBlobSha256: null,
        policyId,
        candidate: {
          ref: `doc-sync-claims/${ref}`,
          sha256: sha(body),
          size: Buffer.byteLength(body),
          mediaType: "text/markdown",
        },
      },
    ],
  } as const;
}
function writeAuthored(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, "harness", relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}
function writeClaim(rootDir: string, ref: string, body: string): void {
  const target = path.join(rootDir, ".harness/doc-sync-claims", ref);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}
function claimPath(rootDir: string, hash: string): string {
  return path.join(rootDir, ".harness/doc-sync-claims", hash);
}
function sha(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
function ledgerCut(value: unknown) {
  const cut = value as { repoId: string; revision: number; headDigest: string };
  return { repoId: cut.repoId, revision: cut.revision, headDigest: cut.headDigest };
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Doc B Test");
  git(rootDir, "config", "user.email", "doc-b@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
function rbacFixture() {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-doc-b-rbac-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  const ids = { reader: 5101, writer: 5102, otherWriter: 5103, admin: 5104 };
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  initRepo(rootDir);
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const people = Object.entries(ids).map(([role, uid]) => ({
    personId: role,
    displayName: role,
    roles: [role === "otherWriter" ? "writer" : role],
    credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
  }));
  const roles = [
    { roleId: "reader", commandClasses: ["repo-read"] },
    { roleId: "writer", commandClasses: ["repo-write", "repo-read"] },
    { roleId: "admin", commandClasses: ["admin"] },
  ];
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`,
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "rbac");
  return { rootDir, userRoot, ids, close: () => rmSync(parent, { recursive: true, force: true }) };
}
