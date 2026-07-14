import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseTaskContractSnapshot } from "../../../application/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { profileIssue, type ProfileValidationIssue } from "./check-profile-types.ts";
import { isInvalidPreset, materializePresetTaskDocuments, resolvePresetEntry } from "./extensions/state.ts";
import type { ProjectHarnessSettings } from "./settings.ts";

export interface TaskContractDocumentRequirement {
  readonly materializeAs: string;
  readonly requiredAnchors: ReadonlyArray<string>;
  readonly fallbackUsed: boolean;
  readonly locale: string;
}

export type TaskContractDocumentResolution = {
  readonly ok: true;
  readonly documents: ReadonlyArray<TaskContractDocumentRequirement>;
} | {
  readonly ok: false;
  readonly issues: ReadonlyArray<ProfileValidationIssue>;
};

export function resolveTaskContractDocuments(
  rootInput: HarnessLayoutInput,
  taskDir: string,
  relativeTaskDir: string,
  vertical: string,
  presetId: string,
  profile: string | undefined,
  settings?: ProjectHarnessSettings
): TaskContractDocumentResolution {
  const snapshotPath = path.join(taskDir, "task-contract.json");
  if (existsSync(snapshotPath)) {
    let snapshot;
    try {
      snapshot = parseTaskContractSnapshot(readFileSync(snapshotPath, "utf8"));
    } catch (error) {
      return { ok: false, issues: [profileIssue(
        "metadata-contract",
        "task_contract_snapshot_invalid",
        "hard-fail",
        `${relativeTaskDir}/task-contract.json is invalid: ${error instanceof Error ? error.message : String(error)}.`,
        "Restore the immutable snapshot from creation evidence or run the explicit task contract migration/upgrade command."
      )] };
    }
    if (snapshot.vertical !== vertical || snapshot.preset.id !== presetId || (profile && snapshot.profile.id !== profile)) {
      return { ok: false, issues: [profileIssue(
        "metadata-contract",
        "task_contract_snapshot_metadata_mismatch",
        "hard-fail",
        `${relativeTaskDir}/task-contract.json does not match INDEX.md vertical/preset/profile metadata.`,
        "Use an explicit task contract upgrade instead of editing either representation by hand."
      )] };
    }
    return {
      ok: true,
      documents: snapshot.documents.map((document) => ({
        materializeAs: document.materializeAs,
        requiredAnchors: document.requiredAnchors,
        fallbackUsed: false,
        locale: document.locale
      }))
    };
  }

  const preset = resolvePresetEntry(rootInput, presetId, vertical);
  if (!preset) {
    return { ok: false, issues: [profileIssue(
      "metadata-preset",
      "metadata_preset_not_found",
      "hard-fail",
      `${relativeTaskDir}/INDEX.md references unknown preset ${presetId}.`,
      "Install the preset or migrate the legacy Task to an immutable contract snapshot."
    )] };
  }
  if (isInvalidPreset(preset)) {
    return {
      ok: false,
      issues: preset.issues.map((issue) => profileIssue(
        "metadata-preset",
        issue.code,
        "hard-fail",
        `${relativeTaskDir}/INDEX.md preset ${presetId} is blocked by active ${preset.layer} preset validation: ${issue.message}`,
        "Fix/remove the active preset override or migrate the legacy Task to an immutable contract snapshot."
      ))
    };
  }

  const materialized = materializePresetTaskDocuments(preset.manifest, {
    profileId: profile,
    locale: settings?.locale ?? "zh-CN"
  });
  if (!materialized.ok) {
    return {
      ok: false,
      issues: materialized.issues.map((issue) => profileIssue(
        "metadata-template",
        issue.code,
        "hard-fail",
        `${relativeTaskDir}/INDEX.md preset ${presetId} cannot materialize required template metadata: ${issue.message}`,
        "Fix the preset/template metadata or migrate the legacy Task to an immutable contract snapshot."
      ))
    };
  }
  return { ok: true, documents: materialized.documents };
}
