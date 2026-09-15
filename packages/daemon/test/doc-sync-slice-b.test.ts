// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyTextualArtifactPath, documentPath, makeTaskEventReader } from "../../kernel/src/index.ts";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { DOC_COMMAND_FRAME_MAX_BYTES } from "../src/doc-sync-actions.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { type RepoCellBinding } from "../src/repo-cell.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  seedSettingsEvent,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { initRepo, ownerBinding, rows, write } from "./doc-sync-slice-a.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const policyId = "markdown-body-replaceable/v1";
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const assignmentSource = { kind: "assignment", nodeId: "node-one", assignmentId: "assignment-one" } as const;
const localBinding = withRoleBinding({ actor, source: "local" as const }, "repo-write");

// The execution worker rides the held-lease channel like any direct executor; the reviewer is a
// runtime-session actor that must not reach reviewed prose once submit releases the lease.
const workerBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "artifact-worker" },
      },
      source: "local" as const,
    },
    "owner",
  ),
  reviewerBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "runtime-session:runtime-artifact-reviewer" },
      },
      source: "local" as const,
    },
    "owner",
  );

test("local doc submit rejects the retired selection assembler", async () => {
  const fixture = await docCell("retired-selection");
  try {
    const cut = await startLease(fixture.cell, fixture.rootDir, "local");
    const relativePath = "tasks/task-doc-docs/notes.md";
    writeAuthored(fixture.rootDir, relativePath, "# Notes\n");
    const result = await fixture.cell.run(
      {
        kind: "doc-submit",
        executionId: "execution-doc",
        baseLedgerSha: cut,
        selections: [{ path: relativePath, baseBlobSha256: null }],
      },
      localBinding,
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
    await startLease(local.cell, local.rootDir, "local");
    const remoteCut = await startLease(remote.cell, remote.rootDir, assignmentSource);
    const body = "# Notes\n\nShared candidate.\n",
      hash = sha(body),
      relativePath = "tasks/task-doc-docs/notes.md";
    writeAuthored(local.rootDir, relativePath, body);
    writeClaim(remote.rootDir, "remote", body);
    const localResult = await local.cell.run(
      { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] },
      localBinding,
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
    const localEvent = makeTaskEventReader({ repoId: "local", rootDir: local.rootDir }).readEvent(localResult.opId);
    const remoteEvent = makeTaskEventReader({ repoId: "remote", rootDir: remote.rootDir }).readEvent(remoteResult.opId);
    assert.equal(localEvent?.schema, "doc-event/v1");
    assert.equal(remoteEvent?.schema, "doc-event/v1");
    if (localEvent?.schema === "doc-event/v1" && remoteEvent?.schema === "doc-event/v1")
      assert.deepEqual(localEvent.payload.changes, remoteEvent.payload.changes);
    assert.equal(remoteResult.proof?.worktreeVisible, false);
    assert.equal("gitCredential" in remoteBinding, false);
  } finally {
    await local.close();
    await remote.close();
  }
});

test("Decision prose is an explicit idempotent doc-sync region in the canonical authored document", async () => {
  const fixture = await docCell("decision-prose");
  try {
    await startLease(fixture.cell, fixture.rootDir, "local");
    const binding = localBinding;
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
        }),
      },
      binding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    await waitForWorktree(fixture.cell, proposed, binding);
    const decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId;
    const relativePath = `decisions/decision-${decisionId}/decision.md`,
      initial = JSON.parse(
        (await fixture.cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence,
      ) as { decision: { body: { body: string } } },
      initialBody =
        "\n# Body join\n\n## 背景\n\n说明需要裁定的问题与已知事实。\n\n## 权衡\n\n" +
        "说明所选方案、被拒方案与取舍理由。\n\n## 结论\n\n说明最终裁定及其适用范围。\n";
    assert.equal(initial.decision.body.body, initialBody);
    const canonical = readFileSync(path.join(fixture.rootDir, "harness", relativePath), "utf8"),
      machine = canonical.slice(0, -initialBody.length),
      firstProse = "\n# Body join\n\nFirst paragraph.\n",
      firstBody = `${machine}${firstProse}`,
      firstHash = sha(firstBody);
    writeAuthored(fixture.rootDir, relativePath, firstBody);
    const firstAction = { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] } as const;
    const first = await fixture.cell.run(firstAction, binding);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    await waitForWorktree(fixture.cell, first, binding);
    assert.equal(first.authorizationDecision?.policyRef, "default@5");
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
    const store = makeTaskEventReader({ repoId: "decision-prose", rootDir: fixture.rootDir }),
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
    await waitForWorktree(fixture.cell, second, binding);
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
  const authority = openPersistentWriterEpoch({
    stateRoot: path.join(fixture.userRoot, "fleet"),
    holderId: "rbac-seed",
  });
  try {
    const lease = authority.acquire("rbac");
    seedSettingsEvent({
      rootDir: fixture.rootDir,
      repoId: "rbac",
      writerEpochFence: {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: path.join(fixture.userRoot, "fleet"),
        repoId: "rbac",
        holderId: lease.holderId,
        epoch: lease.epoch,
      },
    });
  } finally {
    authority.close();
  }
  const host = await openDaemonHost({ daemonId: "doc-rbac", userRoot: fixture.userRoot });
  await host.attachmentsSettled();
  const auth = (ownerUid: number) =>
    ({
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" },
    }) as const;
  try {
    await host.admin({ kind: "register", rootDir: fixture.rootDir, repoId: "rbac" }, auth(fixture.ids.admin));
    const created = await host.run(
      "rbac",
      { kind: "task-create", taskId: "task-doc", title: "Docs" },
      auth(fixture.ids.writer),
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const createdVisible = await host.run(
      "rbac",
      {
        kind: "receipt-show",
        opId: created.opId,
        waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"],
        timeoutMs: 5_000,
      },
      auth(fixture.ids.writer),
    );
    assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible));
    await realizeTaskPlanFixture(
      fixture.rootDir,
      String((created as Record<string, unknown>).packagePath),
      (planPath) => host.run("rbac", { kind: "doc-submit", paths: [planPath] }, auth(fixture.ids.writer)),
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
    assert.equal(denied.code, "authorization_denied");
    assert.equal(denied.authorizationDecision.outcome, "denied");
    assert.deepEqual(denied.unmetCriteria, []);
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
    const before = await startLease(expired.cell, expired.rootDir, "local", 30 * 60 * 1_000);
    const relativePath = "tasks/task-doc-docs/expired.md",
      body = "# Expired\n";
    writeAuthored(expired.rootDir, relativePath, body);
    now = "2026-08-12T01:00:00.000Z";
    const result = await expired.cell.run(
      { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] },
      localBinding,
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
    const before = await startLease(scoped.cell, scoped.rootDir, assignmentSource);
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
    await startLease(local.cell, local.rootDir, "local");
    const relativePath = "tasks/task-doc-docs/large.md",
      body = `# Large\n${"x".repeat(DOC_COMMAND_FRAME_MAX_BYTES - 1024)}\n`;
    writeAuthored(local.rootDir, relativePath, body);
    const action = { kind: "doc-submit", executionId: "execution-doc", paths: [relativePath] } as const;
    assert.equal(Buffer.byteLength(body) > DOC_COMMAND_FRAME_MAX_BYTES / 2, true);
    assert.equal(Buffer.byteLength(JSON.stringify(action)) < DOC_COMMAND_FRAME_MAX_BYTES, true);
    assert.equal(JSON.stringify(action).includes(body), false);
    const result = await local.cell.run(action, localBinding);
    assert.equal(result.outcome, "applied", JSON.stringify(result));
    const event = makeTaskEventReader({ repoId: "large", rootDir: local.rootDir }).readEvent(result.opId);
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
    const before = await startLease(remote.cell, remote.rootDir, assignmentSource);
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

test("task artifact json and log files ride doc sync under the held task lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-reviewer-artifacts-"));
  initRepo(rootDir);
  const repoId = workspaceId("reviewer-artifacts"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "reviewer-artifacts-daemon",
    });
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId: "task-artifact-text", title: "Artifact text channel" },
        ownerBinding,
      )) as { packagePath?: string },
      packagePath = created.packagePath!;
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, ownerBinding),
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-start", taskId: "task-artifact-text", executionId: "exec-artifact-text" },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    const submission = `${packagePath}/artifacts/closeout-submission.json`,
      log = `${packagePath}/artifacts/evidence/run.log`,
      packetOutsideArtifacts = `${packagePath}/review-input.json`;
    write(
      rootDir,
      submission,
      JSON.stringify({ completionClaim: "delivered", deliverables: [], verificationNotes: [] }, null, 2) + "\n",
    );
    write(rootDir, log, "2026-09-14T00:00:00Z evidence line one\n2026-09-14T00:01:00Z evidence line two\n");
    write(rootDir, packetOutsideArtifacts, "{}\n");
    const status = await cell.run(
      { kind: "doc-status", paths: [submission, log, packetOutsideArtifacts] },
      workerBinding,
    );
    assert.deepEqual(
      rows(status.evidence).map((row) => [row.path, row.state]),
      [
        [submission, "eligible"],
        [log, "eligible"],
        // The artifacts subtree is the unified textual subset; a textual JSON file elsewhere
        // in the package is now a doc-sync candidate under the byte-probed textual rule.
        [packetOutsideArtifacts, "eligible"],
      ],
      JSON.stringify(status.evidence),
    );
    const submitted = (await cell.run({ kind: "doc-submit", paths: [submission, log] }, workerBinding)) as Record<
      string,
      unknown
    >;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, String(submitted.opId), workerBinding);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(
        event.payload.changes.map((change) => [change.path, change.candidate?.mediaType]),
        [
          [submission, "application/json"],
          [log, "text/x-harness-opaque"],
        ],
      );
    // Negative control: a textual-format artifact whose bytes are not UTF-8 stays out of doc sync.
    const undecodable = `${packagePath}/artifacts/binary.json`;
    write(rootDir, undecodable, Buffer.from([0x7b, 0xff, 0x7d]));
    const refused = await cell.run({ kind: "doc-submit", paths: [undecodable] }, workerBinding);
    assert.notEqual(refused.outcome, "applied");
    assert.match(String((refused as { summary?: string }).summary ?? JSON.stringify(refused)), /task artifact add/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a runtime reviewer cannot publish reviewed task prose after submit releases the lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-reviewer-prose-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("reviewer-prose"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "reviewer-prose-daemon",
  });
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId: "task-reviewer-prose", title: "Reviewer prose boundary" },
        ownerBinding,
      )) as { packagePath?: string },
      packagePath = created.packagePath!;
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, ownerBinding),
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-start", taskId: "task-reviewer-prose", executionId: "exec-reviewer-prose" },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    const proseArtifact = `${packagePath}/artifacts/report.md`;
    write(rootDir, proseArtifact, "# Evidence\n\nProse boundary fixture delivery.\n");
    const proseSync = (await cell.run({ kind: "doc-submit", paths: [proseArtifact] }, workerBinding)) as Record<
      string,
      unknown
    >;
    assert.equal(proseSync.outcome, "applied", JSON.stringify(proseSync));
    write(
      rootDir,
      `${packagePath}/closeout.md`,
      `## Summary\nDelivered artifact:${proseArtifact}@${String(proseSync.revision)} for this round.\n\n## Verification\nFixture.\n\n## Residual Risk\nNone.\n\n## Same Mechanism Elsewhere\nCovered by the other tests in this file.\n`,
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-submit", taskId: "task-reviewer-prose", executionId: "exec-reviewer-prose" },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    // The reviewer rewrites reviewed prose and tries to publish it while the task lease is
    // released by submit: doc sync must refuse the prose edit.
    write(
      rootDir,
      `${packagePath}/closeout.md`,
      "## Summary\nReviewer rewrite.\n\n## Verification\nFixture.\n\n## Residual Risk\nNone.\n",
    );
    const refused = (await cell.run(
      { kind: "doc-submit", paths: [`${packagePath}/closeout.md`] },
      reviewerBinding,
    )) as { outcome?: string; code?: string };
    assert.equal(refused.outcome, "op_rejected");
    assert.equal(refused.code, "lease_conflict");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the authored walls manifest can be created and edited through doc sync", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-governance-doc-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("governance-doc"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "governance-doc-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = documentPath("governance/walls/walls.json");
  try {
    for (const walls of [[], [{ id: "retired-preset", expect: "exit==0" }]]) {
      const body = `${JSON.stringify({ schema: "walls/v1", walls }, null, 2)}\n`;
      write(rootDir, logical, body);
      const status = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
      assert.equal(rows(status.evidence)[0]?.state, "eligible", JSON.stringify(status));
      const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      await waitForFixturePublication(cell, submitted.opId, binding);
      const read = await cell.run({ kind: "doc-show", path: logical }, binding);
      assert.equal(read.evidence, body);
      // --raw rides the same read; the flag only switches CLI rendering to verbatim body output.
      const rawRead = await cell.run({ kind: "doc-show", path: logical, raw: true }, binding);
      assert.equal(rawRead.evidence, body);
      const rawFalse = await cell.run({ kind: "doc-show", path: logical, raw: false }, binding);
      assert.equal(rawFalse.code, "invalid_command");
      const clean = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
      assert.equal(rows(clean.evidence)[0]?.state, "clean", JSON.stringify(clean));
    }
    assert.equal(classifyTextualArtifactPath("governance/arbitrary.json"), null);
    assert.equal(classifyTextualArtifactPath("tasks/task-owner/task-contract.json"), null);
    assert.deepEqual(classifyTextualArtifactPath("tasks/task-owner/artifacts/dispatch.json"), {
      kind: "opaque-textual",
      mediaType: "application/json",
      policyId: OPAQUE_TEXTUAL_POLICY_ID,
    });
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function docCell(repoId: string, now?: () => string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-doc-b-${repoId}-`));
  initBaseRepo(rootDir);
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
  rootDir: string,
  source: RepoCellBinding["source"],
  ttlMs?: number,
): Promise<unknown> {
  const roleBinding = withRoleBinding({ actor, source }, "repo-write");
  const created = await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, roleBinding);
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForWorktree(cell, created, roleBinding);
  await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, localBinding),
  );
  const started = await cell.run(
    { kind: "task-start", taskId: "task-doc", executionId: "execution-doc", ...(ttlMs === undefined ? {} : { ttlMs }) },
    roleBinding,
  );
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  return ledgerCut(started.cut);
}
async function waitForWorktree(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  receipt: { readonly opId: string },
  binding: RepoCellBinding,
) {
  const shown = await cell.run(
    {
      kind: "receipt-show",
      opId: receipt.opId,
      waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"],
      timeoutMs: 5_000,
    },
    binding,
  );
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
  return shown;
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
function initBaseRepo(rootDir: string): void {
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
  initBaseRepo(rootDir);
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const people = Object.entries(ids).map(([role, uid]) => ({
    personId: role,
    displayName: role,
    roles: [role === "writer" || role === "otherWriter" ? "repo-write" : role],
    credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
  }));
  const roles = [
    { roleId: "reader", commandClasses: ["repo-read"] },
    { roleId: "repo-write", commandClasses: ["repo-write", "repo-read"] },
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
