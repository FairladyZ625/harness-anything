import { planTemplateMaterialization, type HarnessLayoutInput, type MaterializedTemplatePlan } from "@harness-anything/kernel";
import { profileIssue, type ProfileValidationIssue } from "./check-profile-types.ts";
import type { TaskContractDocumentRequirement } from "./check-task-contract.ts";
import { bundledTemplateCatalog } from "./extensions/bundled.ts";
import { isInvalidPreset, materializePresetTaskDocuments, resolvePresetEntry } from "./extensions/state.ts";
import { resolveTemplateCatalogBody } from "./extensions/template-catalog-loader.ts";

export function resolveLiveTaskSectionPolicies(
  rootInput: HarnessLayoutInput,
  relativeTaskDir: string,
  vertical: string,
  presetId: string,
  profile: string | undefined,
  contractDocuments: ReadonlyArray<TaskContractDocumentRequirement>
): { readonly ok: true; readonly documents: ReadonlyMap<string, MaterializedTemplatePlan> }
  | { readonly ok: false; readonly issues: ReadonlyArray<ProfileValidationIssue> } {
  const preset = resolvePresetEntry(rootInput, presetId, vertical);
  if (!preset || isInvalidPreset(preset)) {
    return materializePinnedPolicies(vertical, relativeTaskDir, presetId, contractDocuments);
  }
  const documents: MaterializedTemplatePlan[] = [];
  for (const locale of new Set(contractDocuments.map((document) => document.locale))) {
    const materialized = materializePresetTaskDocuments(preset.manifest, { profileId: profile, locale });
    if (!materialized.ok) return { ok: false, issues: materialized.issues.map((issue) => profileIssue(
      "metadata-template",
      issue.code,
      "hard-fail",
      `${relativeTaskDir}/INDEX.md preset ${presetId} cannot materialize active section policy: ${issue.message}`,
      "Fix the active template metadata so current section write permissions can be evaluated."
    )) };
    const pathsAtLocale = new Set(contractDocuments.filter((document) => document.locale === locale).map((document) => document.materializeAs));
    documents.push(...materialized.documents.filter((document) => pathsAtLocale.has(document.materializeAs)));
  }
  return { ok: true, documents: new Map(documents.map((document) => [document.materializeAs, document])) };
}

function materializePinnedPolicies(
  vertical: string,
  relativeTaskDir: string,
  presetId: string,
  contractDocuments: ReadonlyArray<TaskContractDocumentRequirement>
): { readonly ok: true; readonly documents: ReadonlyMap<string, MaterializedTemplatePlan> }
  | { readonly ok: false; readonly issues: ReadonlyArray<ProfileValidationIssue> } {
  const catalog = bundledTemplateCatalog(vertical);
  const documents: MaterializedTemplatePlan[] = [];
  if (catalog) {
    for (const contractDocument of contractDocuments) {
      const materialized = planTemplateMaterialization({
        catalog,
        locale: contractDocument.locale,
        resolveBody: resolveTemplateCatalogBody(catalog),
        selections: [{
          slot: contractDocument.slot,
          templateRef: contractDocument.templateRef,
          materializeAs: contractDocument.materializeAs,
          localePolicy: { prefer: "explicit", fallback: contractDocument.locale }
        }]
      });
      if (materialized.ok) documents.push(...materialized.documents);
    }
  }
  if (documents.length !== contractDocuments.length) return { ok: false, issues: [profileIssue(
    "metadata-template",
    "metadata_section_permission_missing",
    "hard-fail",
    `${relativeTaskDir}/INDEX.md preset ${presetId} has no resolvable current section policy.`,
    "Restore the active preset or a current bundled declaration for every frozen template reference."
  )] };
  return { ok: true, documents: new Map(documents.map((document) => [document.materializeAs, document])) };
}
