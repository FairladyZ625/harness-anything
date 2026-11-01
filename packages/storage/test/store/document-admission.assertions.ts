import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileDecisionWrite,
  decisionWritePlan,
  reduceDecisionDocument,
  type DecisionEventDraftV1,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { docSyncWritePlan, type DocEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { compileSettingsChangedEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import {
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "@harness-anything/kernel/internal/domain/migration-import-event.ts";
import {
  readSettingsFacet,
  repositorySettings,
  writeRepositorySettingsFacet,
} from "@harness-anything/kernel/internal/domain/settings.ts";
import type { CanonicalWriteBundle } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { decisionProposal, docBundle, repoFileBundle } from "./task-event-store.fixtures.ts";

export const admissionSettingsBase =
  "schema: harness-anything/v1\nname: fixture\nsettings:\n  defaultPreset: standard-task\n";

/** Both adapters run these exact candidates; snapshots include their durable replication position. */
export async function assertDocumentAdmission(input: {
  readonly rootDir: string;
  readonly append: (bundle: CanonicalWriteBundle) => unknown | Promise<unknown>;
  readonly snapshot: () => unknown | Promise<unknown>;
  readonly docStore: Parameters<typeof docBundle>[0];
}): Promise<void> {
  const { append, snapshot, rootDir } = input;
  const refused = async (candidate: CanonicalWriteBundle, code: string, message: RegExp) => {
    const before = await snapshot();
    await assert.rejects(
      async () => append(candidate),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, code);
        assert.match((error as Error).message, message);
        return true;
      },
    );
    assert.deepEqual(await snapshot(), before, "refusal changes no head, event, outcome, document head or position");
    process.stdout.write(
      `DOCUMENT_ADMISSION_REFUSED opId=${candidate.event.opId} code=${code} durable_state=unchanged\n`,
    );
  };
  const proposal = decisionProposal(),
    proposed = compileDecisionWrite({
      event: proposal,
      currentDecision: null,
      currentDocument: null,
      currentRelations: [],
      decisionReviewRequirement: "off",
    }),
    draft: DecisionEventDraftV1 = {
      ...proposal,
      eventId: "admission-accepted",
      opId: "admission-accepted",
      workspaceRevision: 2,
      type: "decision_accepted",
      actor: { principal: { personId: "person-arbiter" }, executor: null },
      payload: { rationale: "Independent approval", judgmentOnlyRationale: "Explicit judgment-only approval" },
    },
    accepted = compileDecisionWrite({
      event: draft,
      currentDecision: reduceDecisionDocument(null, proposal),
      currentDocument: { blobSha256: proposed.event.payload.decisionDocumentClaim.sha256, body: proposed.body },
      currentRelations: [],
      decisionReviewRequirement: "off",
    }),
    staleDecision = { ...accepted.event, payload: { ...accepted.event.payload, baseDocumentSha256: "0".repeat(64) } };
  // A failed final member must not publish its valid preceding proposal either.
  await refused(
    { ...accepted, preceding: [proposed], event: staleDecision, plan: decisionWritePlan(staleDecision) },
    "revision_conflict",
    /document base changed/u,
  );
  await append({ ...accepted, preceding: [proposed] });
  const afterDecision = await snapshot();
  await append({ ...accepted, preceding: [proposed] });
  assert.deepEqual(
    await snapshot(),
    afterDecision,
    "exact replay bypasses obsolete document bases without a new position",
  );
  await refused(
    { ...accepted, preceding: [proposed], event: staleDecision, plan: decisionWritePlan(staleDecision) },
    "op_conflict",
    /another command intent/u,
  );
  const stalePersistedDecision = {
    ...staleDecision,
    eventId: "decision-stale-current",
    opId: "decision-stale-current",
    workspaceRevision: 3,
  };
  await refused(
    { ...accepted, event: stalePersistedDecision, plan: decisionWritePlan(stalePersistedDecision) },
    "revision_conflict",
    /document base changed/u,
  );

  const settings = { ...repositorySettings(readSettingsFacet(admissionSettingsBase)), reviewReturnBudget: 5 },
    settingsBundle = (
      base: string,
      revision: number,
      opId: string,
      candidate = writeRepositorySettingsFacet(base, { ...settings, reviewReturnBudget: revision + 2 }),
    ) =>
      compileSettingsChangedEvent({
        settings: { ...settings, reviewReturnBudget: revision + 2 },
        baseDocumentBody: base,
        candidateDocumentBody: candidate,
        eventId: opId,
        opId,
        workspaceRevision: revision,
        actor: proposal.actor,
        source: "local",
        occurredAt: proposal.occurredAt,
      }),
    firstSettings = settingsBundle(admissionSettingsBase, 3, "admission-settings"),
    candidate = firstSettings.blobs[0]!.body as string;
  await refused(
    settingsBundle("schema: harness-anything/v1\nname: stale\n", 3, "settings-stale"),
    "revision_conflict",
    /harness.yaml changed/u,
  );
  await refused(
    settingsBundle(admissionSettingsBase, 3, "settings-trespass", candidate.replace("name: fixture", "name: trespass")),
    "invalid_write_plan",
    /only their owned/u,
  );
  await append(firstSettings);
  // The canonical base is authoritative even while the worktree still contains the old bytes.
  const secondSettings = settingsBundle(candidate, 4, "settings-next"),
    thirdSettings = settingsBundle(secondSettings.blobs[0]!.body as string, 5, "settings-third");
  await append({ ...thirdSettings, preceding: [secondSettings] });
  const afterSettings = await snapshot();
  await append(firstSettings);
  assert.deepEqual(await snapshot(), afterSettings);
  const liveBase = admissionSettingsBase.replace("name: fixture", "name: live-authored");
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), liveBase);
  await append(settingsBundle(liveBase, 6, "settings-live-authored"));
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), admissionSettingsBase);
  await refused(
    settingsBundle(candidate, 7, "settings-obsolete-canonical"),
    "revision_conflict",
    /harness.yaml changed/u,
  );

  const document = docBundle(input.docStore, "# Temporary\n", 7, "admission-document", "context/temporary.md");
  await append(document);
  const retire = (base: string, revision: number, opId: string): CanonicalWriteBundle => {
    const event: DocEventV1 = {
      ...(document.event as DocEventV1),
      eventId: opId,
      opId,
      workspaceRevision: revision,
      payload: {
        ...(document.event as DocEventV1).payload,
        retirementReason: "superseded",
        executionId: null,
        changes: [
          {
            ...(document.event as DocEventV1).payload.changes[0]!,
            candidate: null,
            baseBlobSha256: base,
            regionProofs: [],
          },
        ],
      },
    };
    return { event, plan: docSyncWritePlan(event), blobs: [] };
  };
  await refused(retire("0".repeat(64), 8, "retire-stale"), "revision_conflict", /retirement base changed/u);
  await append(retire(document.blobs[0]!.sha256, 8, "retire-valid"));
  await refused(retire(document.blobs[0]!.sha256, 9, "retire-twice"), "revision_conflict", /retirement base changed/u);

  const migrationPath = "context/destination.md",
    baseline = "# Destination\n",
    edited = "# Edited after classification\n";
  mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", migrationPath), baseline);
  const migration = repoFileBundle(migrationPath, "# Imported\n", baseline),
    migrationEvent = { ...migration.event, workspaceRevision: 9 } as MigrationImportEventV1,
    replacement = { ...migration, event: migrationEvent, plan: migrationImportWritePlan(migrationEvent) };
  writeFileSync(path.join(rootDir, "harness", migrationPath), edited);
  await refused(replacement, "revision_conflict", /destination changed after conflict classification/u);
  writeFileSync(path.join(rootDir, "harness", migrationPath), baseline);
  await append(replacement);
  // A matching local preimage cannot override a different canonical head.
  const staleMigrationEvent = {
    ...migrationEvent,
    eventId: "migration-stale-current",
    opId: "migration-stale-current",
    workspaceRevision: 10,
  } as MigrationImportEventV1;
  await refused(
    { ...migration, event: staleMigrationEvent, plan: migrationImportWritePlan(staleMigrationEvent) },
    "revision_conflict",
    /destination changed after conflict classification/u,
  );
}
