import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  SETTINGS_ID,
  attributeEntityActionCriterion,
  gateWitnessMappingIssues,
  isSettingsEvent,
  readGateSettings,
  resolveHarnessLayout,
  writeGatesFacet,
  type EntityActionCompileInput,
  type GateWitnessMappingV1,
  type RepositorySettingsV1,
  type SettingsActionDraft,
  type SettingsV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { runPresetAction } from "@harness-anything/preset";
import { SETTINGS_DECLARATION_RUNTIME, SettingsDeclarationError, type LocalSettingsV1 } from "@harness-anything/kernel";
import {
  settingsLastChanged,
  settingsPrincipalRefusal,
  settingsSingletonRevision,
} from "./repo-cell-settings-state.ts";
import type {
  AuthoredSettingsInitialization,
  RepoCellRuntimeContext,
  RepoCellSettingsState,
} from "./repo-cell-action-context.ts";
import type { EntityActionCatalogRunner } from "./entity-action-catalog-executor.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";

const repositoryEffect = "settings-event/settings_changed";
const localEffect = "settings-local/locale_changed";

export function makeSettingsActionRuntime(
  cell: RepoCellRuntimeContext,
  settingsState: RepoCellSettingsState,
): EntityActionCatalogRunner {
  return (contract, action, binding, catalogOpId): WriteReceipt | Promise<WriteReceipt> => {
    // A read must complete inside its caller's synchronous read session, so it never enters the
    // asynchronous tail below: the only `await` on the write path is the catalog-selection lookup.
    if (contract.execution.read) return readSettings(cell, settingsState, action, binding);
    if (binding.authorizationDecision?.outcome !== "allowed")
      throw cell.cellCodedError("actor_unauthorized", "Settings Action execution requires AuthorizationPort approval.");
    // Repository settings are principal-owned: a runtime executor (agent or runtime-session actor)
    // must not mutate the repository-wide constraints that govern it, so the write is refused with
    // an escalation path instead of reaching the event compiler. Reads stay open to every actor.
    // The rule lives in the settings state so the mint itself asks the same question.
    const refused = settingsPrincipalRefusal(binding.actor);
    if (refused !== null) throw cell.cellCodedError(refused.code, refused.message);
    // A write is the one entry that can mint a missing Settings entity, because the authored
    // harness.yaml is the only declaration surface: a repository whose ledger never minted Settings
    // can otherwise never be repaired through the command that is supposed to repair it. The mint is
    // resolved here but not written: it is a canonical event, and a request that turns out to be
    // rejected must leave nothing behind (2026-10-23, brain-os-frontend: an `invalid_command` still
    // appended a settings_changed event and reset this machine's preferences).
    const row = cell.projection.getEntity("settings", SETTINGS_ID),
      revision = settingsSingletonRevision(cell.projection),
      opId = settingsOperationId(cell, action, binding, revision, catalogOpId),
      targetRef = contract.target.refTemplate.replace("{id}", SETTINGS_ID),
      local = localSettingsFromAction(cell, action, settingsState),
      existing = cell.store.readEvent(opId);
    if (existing) {
      if (!isSettingsEvent(existing))
        throw cell.cellCodedError("revision_conflict", `Operation ${opId} belongs to a non-Settings event.`);
      const localChanged = local === null ? false : settingsState.writeLocal(local),
        receipt = cell.receiptForOperation(opId, binding);
      return replayReceipt(receipt, settingsState.read(), localChanged, targetRef);
    }
    // Resolved only after the replay check and the local-field parse: a replayed or syntactically
    // invalid request must not touch the authored document at all.
    const initialization = settingsState.authoredInitialization(),
      document = cell.projection.readDocument("harness.yaml"),
      compile = contract.execution.compile;
    if (!compile) throw cell.cellCodedError("invalid_command", `${action.kind} has no Settings event compiler.`);
    if (action.gatesFromDocument === true && action.gatesDraft !== undefined)
      throw cell.cellCodedError(
        "invalid_command",
        "gatesFromDocument and gatesDraft are alternative ways to declare the authored " +
          "settings.gates facet; supply one, not both.",
      );
    // The authored harness.yaml on disk is the user-facing declaration surface: `--gates-from-document`
    // mints the entity value from it instead of trusting a caller-supplied `gates` array, and the compiler
    // may base the rewritten document on its bytes when they carry the same settings. `gatesDraft` is a
    // structured draft of that same facet (the GUI gate editor): the ingress splices it into the authored
    // document and mints `gates` from the result, so the document stays the only declaration surface.
    // When a mint is pending, the bytes that will exist are the mint's normalized candidate: basing the
    // request on the pre-mint file instead would pit two different bases of the same path against each
    // other and surface as a revision_conflict.
    const authoredDocumentBody = initialization?.candidateDocumentBody ?? readAuthoredDocument(cell),
      // The value this request will be judged against. With a mint pending that is the value the mint
      // is about to project — judging against the absent row instead would reject the very request
      // that unblocks the repository (a repository-change request needs a harness.yaml document,
      // which only the mint can publish).
      currentEntity = initialization?.repository ?? row?.value,
      currentDocumentBody = initialization?.candidateDocumentBody ?? document.document?.body,
      gates =
        action.gatesFromDocument === true
          ? authoredGateMappings(cell, authoredDocumentBody)
          : draftedGateMappings(cell, action.gatesDraft, authoredDocumentBody ?? currentDocumentBody),
      // The mint takes the next revision, so a draft published on top of it lands one later.
      compiled = compile({
        action: { ...action, ...(gates === undefined ? {} : { gates }), authoredDocumentBody },
        actor: binding.actor,
        source: binding.source,
        session: resolveWriteSessionIdentity(binding, cell.projection),
        opId,
        occurredAt: cell.now(),
        workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1 + (initialization === null ? 0 : 1),
        currentEntity,
        entityRevision: revision,
        ...(currentDocumentBody === undefined ? {} : { currentDocumentBody }),
      } satisfies EntityActionCompileInput);
    if (compiled.kind !== "settings")
      throw cell.cellCodedError("invalid_store", `${action.kind} compiled a non-Settings action draft.`);
    // A request that changes nothing needs no catalog judgment, so it stays on the synchronous path.
    if (compiled.result.kind === "no-changes")
      return settleWithoutDraft(cell, settingsState, binding, opId, revision, initialization, local);
    // Narrowed once, outside the callback: the closure below must not widen it back to the union.
    const event = compiled.result;
    // The catalog selection is the last rejection a valid-looking request can still hit, and it is
    // asynchronous. Judging it before the mint is what keeps a rejected request from leaving a write
    // behind, so the mint waits on this promise rather than running ahead of it.
    return assertCatalogSelection(
      cell.rootDir,
      mergedSettings(event.bundle.event.payload.settings, local, settingsState),
    ).then(() => {
      // The mint goes first: it publishes the harness.yaml the compiled draft is based on.
      if (initialization !== null) settingsState.initializeAuthored(initialization, binding);
      return publishSettingsDraft(cell, settingsState, opId, event, local, targetRef);
    });
  };
}

/**
 * A request that changes no repository value. The local half may still land, and a pending mint must
 * still be written because this request is the one that repairs the repository. Neither needs the
 * asynchronous catalog lookup, so this path stays synchronous.
 */
function settleWithoutDraft(
  cell: RepoCellRuntimeContext,
  settingsState: RepoCellSettingsState,
  binding: RepoCellBinding,
  opId: string,
  revision: number,
  initialization: AuthoredSettingsInitialization | null,
  local: LocalSettingsV1 | null,
): WriteReceipt {
  if (initialization !== null) {
    const initialized = settingsState.initializeAuthored(initialization, binding),
      localChanged = local === null ? false : settingsState.writeLocal(local),
      receipt = initialized === null ? null : cell.receiptForOperation(initialized.event.opId, binding);
    if (receipt !== null)
      return localChanged
        ? ({
            ...receipt,
            effects: [repositoryEffect, localEffect],
            summary: "Initialized repository settings from harness.yaml and updated local settings.",
          } as WriteReceipt)
        : receipt;
  }
  const localChanged = local === null ? false : settingsState.writeLocal(local);
  return {
    outcome: localChanged ? "applied" : "no_changes",
    opId,
    revision,
    evidence: JSON.stringify({ schema: "settings-update/v1", settings: settingsState.read() }),
    visibility: "center",
    effects: localChanged ? [localEffect] : [],
    updatedProjection: null,
    summary: localChanged ? "Updated local settings." : "Settings already match the requested values.",
    ...(localChanged ? {} : { code: "no_changes", origin: "daemon" }),
  } as WriteReceipt;
}

/** Repository settings overlaid with this machine's local fields, as the catalog judges them. */
function mergedSettings(
  repository: RepositorySettingsV1,
  local: LocalSettingsV1 | null,
  settingsState: Pick<RepoCellSettingsState, "readLocal">,
): SettingsV1 {
  // The local file's schema marker is dropped: the merged view keeps the repository settings schema.
  const { schema: _localSchema, ...localValue } = local ?? settingsState.readLocal();
  return { ...repository, ...localValue };
}

/** The action's local-only fields (locale, GUI deadlines) applied onto this machine's local settings; null when it names none. */
function localSettingsFromAction(
  cell: RepoCellRuntimeContext,
  action: RepoTaskAction,
  settingsState: Pick<RepoCellSettingsState, "readLocal">,
): LocalSettingsV1 | null {
  try {
    const applied = SETTINGS_DECLARATION_RUNTIME.applyLocalAction(
      settingsState.readLocal() as unknown as Readonly<Record<string, unknown>>,
      action as unknown as Readonly<Record<string, unknown>>,
    );
    return applied === undefined ? null : (applied as unknown as LocalSettingsV1);
  } catch (error: unknown) {
    if (error instanceof SettingsDeclarationError) throw cell.cellCodedError("invalid_command", error.message);
    throw error;
  }
}

function readAuthoredDocument(cell: RepoCellRuntimeContext): string | undefined {
  const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml");
  return existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
}

function authoredGateMappings(
  cell: RepoCellRuntimeContext,
  authoredDocumentBody: string | undefined,
): readonly GateWitnessMappingV1[] {
  if (authoredDocumentBody === undefined)
    throw cell.cellCodedError(
      "invalid_command",
      "gatesFromDocument requires the authored harness.yaml document to exist.",
    );
  try {
    return readGateSettings(authoredDocumentBody);
  } catch (error) {
    throw cell.cellCodedError(
      "invalid_command",
      `harness.yaml settings.gates is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A caller-declared draft of the authored `settings.gates` facet: spliced into the authored
 * document with the kernel's serializer, then minted by reading the document back — the same
 * provenance as `--gates-from-document`, with the facet bytes supplied instead of edited on
 * disk. Semantics (adapter field sets, governance modifiers) are judged downstream by
 * `validateRepositorySettings`; anything the document cannot express fails the round-trip.
 */
function draftedGateMappings(
  cell: RepoCellRuntimeContext,
  draft: unknown,
  documentBody: string | undefined,
): readonly GateWitnessMappingV1[] | undefined {
  if (draft === undefined) return undefined;
  if (!Array.isArray(draft) || draft.some((mapping) => typeof mapping !== "object" || mapping === null))
    throw cell.cellCodedError("invalid_command", "gatesDraft must be an array of gate witness mappings.");
  if (documentBody === undefined)
    throw cell.cellCodedError("invalid_command", "gatesDraft requires the authored harness.yaml document to exist.");
  // Judge the draft before splicing: a `none` mapping renders inline and would silently drop
  // option fields the adapter cannot carry.
  const issues = gateWitnessMappingIssues(draft as readonly GateWitnessMappingV1[]);
  if (issues.length) throw cell.cellCodedError("invalid_command", issues.join("; "));
  try {
    return readGateSettings(writeGatesFacet(documentBody, draft as readonly GateWitnessMappingV1[]));
  } catch (error) {
    throw cell.cellCodedError(
      "invalid_command",
      `gatesDraft cannot be expressed in settings.gates: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readSettings(
  cell: RepoCellRuntimeContext,
  settingsState: RepoCellSettingsState,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const row = cell.projection.getEntity("settings", SETTINGS_ID),
    settings = settingsState.read(),
    revision = settingsSingletonRevision(cell.projection),
    cut = cell.projection.readCut(),
    visible = row !== undefined && cut.status === "ready",
    base = {
      opId: cell.operationId(action, binding, cell.input.repoId, revision),
      revision,
      evidence: JSON.stringify({
        schema: "settings-action-read/v1",
        settings,
        entityRevision: revision,
        status: cut.status,
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: cut.sourceRevision,
        appliedCut: cut.watermark,
        durable: true,
        canonicalVisible: visible,
        worktreeVisible: null,
      },
      settingsId: SETTINGS_ID,
      settings,
      lastChanged: settingsLastChanged(cell.projection),
      effects: [] as readonly string[],
      updatedProjection: null,
    };
  return visible
    ? ({ outcome: "applied", ...base } as WriteReceipt)
    : ({
        outcome: "pending",
        ...base,
      } as WriteReceipt);
}

function publishSettingsDraft(
  cell: RepoCellRuntimeContext,
  settingsState: RepoCellSettingsState,
  opId: string,
  draft: Extract<SettingsActionDraft, { readonly kind: "event" }>,
  local: LocalSettingsV1 | null,
  targetRef: string,
): WriteReceipt {
  // The catalog selection was judged against this same value before the mint, so the write surface
  // is reached with nothing left to reject: the only writes below are the accepted request's.
  const appended = cell.store.append(draft.bundle),
    publication = cell.publicPublication(appended);
  cell.projection.apply(draft.bundle.event, draft.bundle.plan);
  const localChanged = local === null ? false : settingsState.writeLocal(local),
    applied = cell.projection.readOperation(draft.bundle.event.opId),
    canonicalVisible = applied !== null && applied.watermark >= appended.revision,
    receipt = {
      opId: draft.bundle.event.opId,
      revision: appended.revision,
      evidence: JSON.stringify({ schema: "settings-update/v1", settings: settingsState.read() }),
      visibility: "center" as const,
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible,
        worktreeVisible: true,
      },
      ...publication,
      effects: localChanged ? [repositoryEffect, localEffect] : [repositoryEffect],
      updatedProjection: { kind: "settings", ref: targetRef, revision: appended.revision },
      summary: localChanged ? "Updated repository and local settings." : "Updated repository settings.",
    };
  return canonicalVisible
    ? ({ outcome: "applied", ...receipt } as WriteReceipt)
    : ({
        outcome: "pending",
        ...receipt,
      } as WriteReceipt);
}

function replayReceipt(
  receipt: WriteReceipt,
  settings: SettingsV1,
  localChanged: boolean,
  targetRef: string,
): WriteReceipt {
  return {
    ...receipt,
    evidence: JSON.stringify({ schema: "settings-update/v1", settings, replay: true }),
    proof: receipt.proof ? { ...receipt.proof, worktreeVisible: true } : receipt.proof,
    effects: localChanged ? [repositoryEffect, localEffect] : [repositoryEffect],
    updatedProjection: { kind: "settings", ref: targetRef, revision: receipt.revision ?? null },
    summary: localChanged
      ? "Replayed repository settings and repaired local settings."
      : "Replayed repository settings.",
  } as WriteReceipt;
}

function settingsOperationId(
  cell: RepoCellRuntimeContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  revision: number,
  catalogOpId: string,
): string {
  if (typeof action.idempotencyKey === "string" && action.idempotencyKey.trim())
    return cell.operationId(action, binding, cell.input.repoId, 0);
  const version = action.expectedVersion === undefined ? revision : Number(action.expectedVersion);
  return Number.isSafeInteger(version) ? cell.operationId(action, binding, cell.input.repoId, version) : catalogOpId;
}

async function assertCatalogSelection(rootDir: string, settings: SettingsV1): Promise<void> {
  const presets = (await runPresetAction({
      rootDir,
      action: { kind: "preset-list", verticalId: settings.defaultVertical },
      settings,
    })) as readonly SettingsCatalogPreset[],
    preset = presets.find((row) => row.id === settings.defaultPreset && row.verticalId === settings.defaultVertical),
    selection = [settings.defaultVertical, settings.defaultPreset, settings.defaultProfile].join("/");
  if (preset?.validity !== "valid" || !preset.profiles?.some((profile) => profile.id === settings.defaultProfile))
    throw attributeEntityActionCriterion(
      Object.assign(new Error(`Settings selection ${selection} is not a valid catalog preset profile.`), {
        code: "invalid_settings_catalog_selection",
      }),
      "update",
      "settings/catalog-selection",
    );
}

interface SettingsCatalogPreset {
  readonly id: string;
  readonly verticalId: string;
  readonly validity: "valid" | "unavailable" | "blocked";
  readonly profiles?: ReadonlyArray<{ readonly id: string }>;
}
