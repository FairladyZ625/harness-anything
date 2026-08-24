// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  type DocEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import {
  compileDecisionWrite,
  decisionWritePlan,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
} from "../../src/domain/decision-event.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  serializeTaskEvent,
  type TaskCreatedEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import {
  freezeDeclaredWritePlan,
  serializeEventHead,
} from "../../src/domain/write-chain.contract.ts";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "../../src/domain/migration-import-event.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  contentObjectRelativePath,
  eventObjectRelativePath,
} from "../../src/layout/ledger-object-layout.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import {
  CANONICAL_EVENT_REF,
  makeTaskEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

import {
  bundle,
  decisionProposal,
  docBundle,
  event,
  eventAt,
  flatLedgerFixture,
  git,
  incrementalObjectBytes,
  initRepo,
  median,
  mixedLedgerFixture,
  repoFileBundle,
  repoLinkBundle,
  snapshot,
} from "./task-event-store.fixtures.ts";
test("Decision bundle publishes one canonical document, enforces base CAS, and preserves a hand-edit conflict", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "decision-store", rootDir }),
      proposal = decisionProposal(),
      compiled = compileDecisionWrite({
        event: proposal,
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      }),
      missing = { ...compiled, blobs: [] },
      invalidPlan = freezeDeclaredWritePlan(
        {
          commandType: "DecisionWrite",
          targets: compiled.plan.targets.filter(
            (target) =>
              target.kind !== "content_blob" &&
              target.kind !== "local_wal_file",
          ),
        },
        ["DecisionWrite"],
      ),
      before = store.currentCommit();
    assert.throws(
      () => store.append({ ...compiled, plan: invalidPlan }),
      /decision write plan/u,
    );
    assert.throws(() => store.append(missing), /content inputs/u);
    assert.deepEqual(store.currentCommit(), before);
    const receipt = store.append(compiled),
      documentTarget = `harness/${compiled.path}`,
      objectTarget = `harness/${contentObjectRelativePath(compiled.event.payload.decisionDocumentClaim.sha256)}`;
    assert.deepEqual(
      receipt.metrics.changedPaths,
      [
        documentTarget,
        `harness/${eventObjectRelativePath(proposal.opId)}`,
        "harness/events/head.json",
        objectTarget,
      ].sort(),
    );
    assert.equal(
      git(rootDir, "show", `${receipt.commitSha.sha}:${documentTarget}`),
      compiled.body.trimEnd(),
    );
    assert.equal(
      git(rootDir, "show", `${receipt.commitSha.sha}:${objectTarget}`),
      compiled.body.trimEnd(),
    );
    const local = "# hand-edited Decision\n";
    writeFileSync(path.join(rootDir, documentTarget), local);
    const materialized = store.materialize();
    assert.deepEqual(materialized.changed, [compiled.path]);
    assert.equal(materialized.conflicts.length, 1);
    assert.equal(
      readFileSync(path.join(rootDir, materialized.conflicts[0]!), "utf8"),
      local,
    );
    assert.equal(
      readFileSync(path.join(rootDir, documentTarget), "utf8"),
      compiled.body,
    );
    assert.equal(
      readdirSync(path.dirname(path.join(rootDir, documentTarget))).some(
        (name) => name.includes(".conflict-"),
      ),
      true,
    );
    const current: Omit<DecisionDocumentState, "relations"> = {
        decisionId: proposal.decisionId,
        state: "proposed",
        title: proposal.payload.title,
        question: proposal.payload.question,
        riskTier: proposal.payload.riskTier,
        urgency: proposal.payload.urgency,
        vertical: proposal.payload.vertical,
        preset: proposal.payload.preset,
        decisionClass: proposal.payload.decisionClass,
        appliesTo: proposal.payload.appliesTo,
        proposer: proposal.actor,
        arbiter: null,
        proposedAt: proposal.occurredAt,
        decidedAt: null,
        workspaceRevision: 1,
        chosen: proposal.payload.chosen,
        rejected: proposal.payload.rejected,
        claims: [],
        provenance: proposal.payload.provenance,
        judgmentConsents: [],
      },
      acceptedDraft: DecisionEventDraftV1 = {
        ...proposal,
        eventId: "event-decision-store-2",
        workspaceRevision: 2,
        opId: "op-decision-store-2",
        type: "decision_accepted",
        actor: { principal: { personId: "person-arbiter" }, executor: null },
        occurredAt: "2026-08-14T00:00:01.000Z",
        payload: {
          rationale: "Independent approval.",
          judgmentOnlyRationale: "Explicit judgment-only approval.",
        },
      },
      accepted = compileDecisionWrite({
        event: acceptedDraft,
        currentDecision: current,
        currentRelations: [],
        currentDocument: {
          blobSha256: compiled.event.payload.decisionDocumentClaim.sha256,
          body: compiled.body,
        },
      }),
      stale = {
        ...accepted.event,
        payload: {
          ...accepted.event.payload,
          baseDocumentSha256: "0".repeat(64),
        },
      };
    assert.throws(
      () =>
        store.append({
          ...accepted,
          event: stale,
          plan: decisionWritePlan(stale),
        }),
      /document base changed/u,
    );
    assert.equal(store.read().revision, 1);
    const second = store.append(accepted);
    assert.equal(store.read().revision, 2);
    assert.equal(
      readFileSync(path.join(rootDir, documentTarget), "utf8"),
      accepted.body,
    );
    assert.equal(git(rootDir, "rev-parse", "HEAD"), second.commitSha.sha);
  });
});

test("authored branch advancement outside the daemon fails closed", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      canonical = store.currentCommit().sha;
    git(rootDir, "commit", "--allow-empty", "-qm", "external advance");
    assert.throws(
      () => store.append(bundle(event)),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "publication_indeterminate",
        );
        const text = String(error);
        assert.ok(
          text.includes(canonical),
          `recovery guidance must name the target commit: ${text}`,
        );
        assert.ok(
          text.includes(`update-ref refs/heads/master ${canonical}`),
          `recovery guidance must give an executable command: ${text}`,
        );
        return true;
      },
    );
    assert.equal(git(rootDir, "rev-parse", CANONICAL_EVENT_REF), canonical);
    assert.equal(store.readHead(), null);
  });
});

for (const killpoint of [
  "before_event_write",
  "after_event_write",
  "after_head_write",
  "after_git_commit",
  "before_worktree_rename",
  "after_worktree_rename",
] as const) {
  test(`Decision authored recovery handles ${killpoint} without duplicate publication`, async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const decision = compileDecisionWrite({
          event: decisionProposal(),
          currentDecision: null,
          currentRelations: [],
          currentDocument: null,
        }),
        interrupted = makeTaskEventStore({
          repoId: "test-repo",
          rootDir,
          killpoint: (point) => {
            if (point === killpoint) throw new Error(`crash:${point}`);
          },
        });
      assert.throws(
        () => interrupted.append(decision),
        new RegExp(`crash:${killpoint}`, "u"),
      );
      const recovery = makeTaskEventStore({
        repoId: "test-repo",
        rootDir,
      }).recover();
      if (killpoint === "after_head_write")
        assert.equal(recovery.status, "committed");
      else if (
        [
          "after_git_commit",
          "before_worktree_rename",
          "after_worktree_rename",
        ].includes(killpoint)
      )
        assert.equal(recovery.status, "already_committed");
      else assert.equal(recovery.status, "none");
      const resumed = makeTaskEventStore({ repoId: "test-repo", rootDir });
      resumed.append(decision);
      assert.equal(resumed.read().revision, 1);
      assert.equal(resumed.read().events[0]?.schema, "decision-event/v1");
      assert.equal(
        git(rootDir, "rev-list", "--count", CANONICAL_EVENT_REF),
        "2",
      );
      assert.equal(
        git(
          rootDir,
          "for-each-ref",
          "--format=%(refname)",
          "refs/ha-event-prepared/",
        ),
        "",
      );
    });
  });
}

for (const killpoint of [
  "before_event_write",
  "after_event_write",
  "after_head_write",
  "after_git_commit",
  "before_worktree_rename",
  "after_worktree_rename",
] as const) {
  test(
    `SIGKILL recovery handles ${killpoint} without duplicate publication`,
    {
      skip:
        process.platform === "win32"
          ? "requires POSIX SIGKILL kill-point semantics"
          : false,
    },
    async () => {
      await withTempStoreAsync(async (rootDir) => {
        initRepo(rootDir);
        const moduleUrl = new URL(
            "../../src/store/task-event-store.ts",
            import.meta.url,
          ).href,
          child = spawnSync(
            process.execPath,
            [
              "--experimental-strip-types",
              "--input-type=module",
              "-e",
              [
                `import { makeTaskEventStore } from ${JSON.stringify(moduleUrl)};`,
                `import { taskLifecycleWritePlan } from ${JSON.stringify(new URL("../../src/domain/task-lifecycle-publication.ts", import.meta.url).href)};`,
                "const event = JSON.parse(process.env.HA_KILL_EVENT);",
                "makeTaskEventStore({ repoId: 'test-repo', rootDir: process.env.HA_KILL_ROOT, killpoint: (point) => { if (point === process.env.HA_KILL_POINT) process.kill(process.pid, 'SIGKILL'); } }).append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });",
              ].join("\n"),
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                HA_KILL_EVENT: JSON.stringify(event),
                HA_KILL_POINT: killpoint,
                HA_KILL_ROOT: rootDir,
              },
            },
          );
        assert.equal(child.signal, "SIGKILL", child.stderr);
        const recovery = makeTaskEventStore({
          repoId: "test-repo",
          rootDir,
        }).recover();
        if (killpoint === "after_head_write")
          assert.equal(recovery.status, "committed");
        else if (
          [
            "after_git_commit",
            "before_worktree_rename",
            "after_worktree_rename",
          ].includes(killpoint)
        )
          assert.equal(recovery.status, "already_committed");
        else assert.equal(recovery.status, "none");
        const resumed = makeTaskEventStore({ repoId: "test-repo", rootDir });
        resumed.append(bundle(event));
        assert.equal(resumed.read().revision, 1);
        assert.equal(
          git(
            rootDir,
            "for-each-ref",
            "--format=%(refname)",
            "refs/ha-event-prepared/",
          ),
          "",
        );
        assert.equal(
          git(rootDir, "rev-parse", CANONICAL_EVENT_REF),
          git(rootDir, "rev-parse", "HEAD"),
        );
      });
    },
  );
}
