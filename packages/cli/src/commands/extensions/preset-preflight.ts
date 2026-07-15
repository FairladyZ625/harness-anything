import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  preflightPresetManifest,
  type HarnessLayoutInput,
  type PresetCapabilityProvider,
  type PresetPreflightIssue,
  type PresetPreflightReceipt,
  type PresetRawFsEnforcementEvidence,
  type PresetRawFsGrant
} from "../../../../kernel/src/index.ts";
import { presetRuntimeRepairHint, smokePresetEntrypoints, type PresetEntrypointSmokeIssue } from "./preset-smoke.ts";
import { registeredSemanticPresetCapabilityProviders } from "./preset-capability-runtime.ts";
import type { ResolvedPreset } from "./state.ts";

export interface PresetPackagePreflightReceipt extends PresetPreflightReceipt {
  readonly runtimeSmoke: {
    readonly ok: boolean;
    readonly entrypoints: ReturnType<typeof smokePresetEntrypoints>["entrypoints"];
  };
}

export interface PresetPackagePreflightResult {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<PresetPreflightIssue | PresetEntrypointSmokeIssue>;
  readonly warnings: PresetPreflightReceipt["warnings"];
  readonly receipt: PresetPackagePreflightReceipt;
  readonly hint: string;
}

interface PresetPackageAdmissionOptions {
  readonly providers?: ReadonlyArray<PresetCapabilityProvider>;
  readonly rawFsGrants?: ReadonlyArray<PresetRawFsGrant>;
  readonly rawFsEnforcement?: ReadonlyArray<PresetRawFsEnforcementEvidence>;
  readonly now?: string;
}

export function preflightPresetPackage(
  rootInput: HarnessLayoutInput,
  preset: ResolvedPreset,
  admission: PresetPackageAdmissionOptions = {}
): PresetPackagePreflightResult {
  const semantic = preflightPresetManifest(preset.manifest, {
    layer: preset.layer,
    packageDigest: digestPresetPackage(preset.sourcePath),
    now: admission.now ?? new Date().toISOString(),
    providers: admission.providers ?? registeredSemanticPresetCapabilityProviders,
    rawFsGrants: admission.rawFsGrants ?? [],
    rawFsEnforcement: admission.rawFsEnforcement ?? []
  });
  const smoke = semantic.valid
    ? smokePresetEntrypoints(rootInput, preset)
    : { ok: false as const, issues: [], entrypoints: [] };
  const issues = [...semantic.issues, ...smoke.issues];
  const receipt: PresetPackagePreflightReceipt = {
    ...semantic,
    valid: issues.length === 0,
    entrypoints: semantic.entrypoints.map((entrypoint) => ({
      ...entrypoint,
      valid: entrypoint.valid && !smoke.issues.some((issue) => issue.entrypoint === entrypoint.name)
    })),
    runtimeSmoke: { ok: smoke.ok, entrypoints: smoke.entrypoints }
  };
  return {
    ok: issues.length === 0,
    issues,
    warnings: semantic.warnings,
    receipt,
    hint: preflightRepairHint(preset, semantic.issues, smoke.issues)
  };
}

function preflightRepairHint(
  preset: ResolvedPreset,
  semanticIssues: ReadonlyArray<PresetPreflightIssue>,
  smokeIssues: ReadonlyArray<PresetEntrypointSmokeIssue>
): string {
  const semantic = semanticIssues[0];
  if (semantic) return `Preset ${preset.manifest.id} is not runnable: ${semantic.message} Next: ${semantic.hint}`;
  return presetRuntimeRepairHint(preset, smokeIssues);
}

function digestPresetPackage(sourcePath: string): string {
  const root = path.dirname(path.resolve(sourcePath));
  const hash = createHash("sha256");
  updatePresetPackageDigest(root, "", hash);
  return `sha256:${hash.digest("hex")}`;
}

function updatePresetPackageDigest(root: string, relative: string, hash: ReturnType<typeof createHash>): void {
  const directory = path.join(root, relative);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryRelative = relative ? path.posix.join(relative.split(path.sep).join("/"), entry.name) : entry.name;
    const absolute = path.join(root, ...entryRelative.split("/"));
    hash.update(entryRelative);
    hash.update("\0");
    if (entry.isDirectory()) {
      hash.update("directory\0");
      updatePresetPackageDigest(root, entryRelative, hash);
    } else if (entry.isFile()) {
      hash.update("file\0");
      hash.update(readFileSync(absolute));
    } else {
      const stat = lstatSync(absolute);
      hash.update(`unsupported:${stat.mode}\0`);
    }
  }
}
