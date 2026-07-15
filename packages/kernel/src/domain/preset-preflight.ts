import {
  type PresetManifest,
} from "../schemas/registry.ts";
import { isPresetCapabilityRequestShape } from "../schemas/preset-capability-request-validator.ts";
import {
  presetCapabilityCatalog,
  type PresetInputV3,
  type PresetRawFsEffect
} from "../schemas/preset-manifest-v3.ts";
import type { PresetManifestV3 } from "../schemas/registry.ts";

export type PresetCapabilityDirection = "requires" | "produces";

export interface PresetCapabilityProvider {
  readonly capability: string;
  readonly version: string;
  readonly direction: PresetCapabilityDirection;
}

export interface PresetRawFsGrant {
  readonly policyGrant: string;
  readonly presetId: string;
  readonly presetVersion: string;
  readonly entrypoint: string;
  readonly packageDigest: string;
  readonly sourceTrust: "bundled-signed-digest" | "independent-policy-grant";
  readonly access: "read" | "staged-write";
  readonly scopes: ReadonlyArray<{ readonly root: "project" | "authored" | "local" | "output"; readonly pattern: string }>;
  readonly owner: string;
  readonly decisionRef: string;
  readonly decisionState: "active" | "accepted" | "proposed" | "deferred" | "retired";
  readonly expiresAt: string;
}

export interface PresetRawFsEnforcementEvidence {
  readonly policyGrant: string;
  readonly effectId: string;
  readonly normalizedScopes: ReadonlyArray<string>;
  readonly normalizedPhysicalScopes: ReadonlyArray<string>;
  readonly lexicalContainment: boolean;
  readonly realpathContainment: boolean;
  readonly symlinkLeafSafe: boolean;
  readonly forbiddenRootSafe: boolean;
  readonly toctouProtected: boolean;
  readonly hostEnforced: boolean;
  readonly coordinatorEnforced: boolean;
}

export interface PresetPreflightOptions {
  readonly layer: "project" | "user" | "builtin";
  readonly packageDigest: string;
  readonly now: string;
  readonly providers: ReadonlyArray<PresetCapabilityProvider>;
  readonly rawFsGrants?: ReadonlyArray<PresetRawFsGrant>;
  readonly rawFsEnforcement?: ReadonlyArray<PresetRawFsEnforcementEvidence>;
}

export interface PresetPreflightIssue {
  readonly code:
    | "invalid_input_default"
    | "invalid_input_reference"
    | "duplicate_logical_output"
    | "unknown_capability"
    | "unknown_capability_version"
    | "unsupported_capability_selector"
    | "capability_provider_missing"
    | "raw_fs_grant_missing"
    | "raw_fs_source_untrusted"
    | "raw_fs_grant_mismatch"
    | "raw_fs_approval_invalid"
    | "raw_fs_scope_invalid"
    | "raw_fs_scope_unverified"
    | "raw_fs_host_unenforced"
    | "raw_fs_coordinator_required";
  readonly message: string;
  readonly path: string;
  readonly entrypoint: string;
  readonly hint: string;
}

export interface PresetPreflightWarning {
  readonly code: "legacy-physical-scope" | "broad-capability-selector" | "raw-fs-expiring-soon";
  readonly message: string;
  readonly path: string;
}

export interface PresetPreflightReceipt {
  readonly schema: "preset-preflight-receipt/v1";
  readonly preset: {
    readonly id: string;
    readonly version: string;
    readonly manifestSchema: PresetManifest["schema"];
    readonly layer: PresetPreflightOptions["layer"];
    readonly packageDigest: string;
  };
  readonly valid: boolean;
  readonly runtime: "legacy-scope-adapter/v1" | "semantic-capability-preflight/v1";
  readonly semanticFailureFallback: "forbidden";
  readonly entrypoints: ReadonlyArray<{
    readonly name: string;
    readonly type: "script" | "template";
    readonly valid: boolean;
    readonly capabilities: ReadonlyArray<{
      readonly capability: string;
      readonly version: string;
      readonly direction: PresetCapabilityDirection;
      readonly dataShape: string | null;
      readonly authorityEnvelope: string | null;
      readonly provider: "ready" | "missing";
      readonly admitted: boolean;
    }>;
    readonly logicalOutputs: ReadonlyArray<string>;
    readonly escapeHatches: ReadonlyArray<{
      readonly id: string;
      readonly effect: "raw-fs";
      readonly access: "read" | "staged-write";
      readonly admitted: boolean;
      readonly originalScopes: ReadonlyArray<{ readonly root: string; readonly pattern: string }>;
      readonly normalizedScopeCeiling: ReadonlyArray<string>;
      readonly normalizedPhysicalScopes: ReadonlyArray<string>;
      readonly policyGrant: string;
      readonly decisionRef: string;
      readonly owner: string;
      readonly expiresAt: string;
      readonly enforcementVersion: "protected-scopes/v1";
      readonly denialCodes: ReadonlyArray<PresetPreflightIssue["code"]>;
    }>;
  }>;
  readonly issues: ReadonlyArray<PresetPreflightIssue>;
  readonly warnings: ReadonlyArray<PresetPreflightWarning>;
}

export function catalogPresetCapabilityProviders(): ReadonlyArray<PresetCapabilityProvider> {
  return presetCapabilityCatalog.flatMap((capability) => capability.directions.map((direction) => ({
    capability: capability.id,
    version: capability.version,
    direction
  })));
}

export function preflightPresetManifest(
  manifest: PresetManifest,
  options: PresetPreflightOptions
): PresetPreflightReceipt {
  if (manifest.schema !== "preset-manifest/v3") return legacyReceipt(manifest, options);

  const issues: PresetPreflightIssue[] = [];
  const warnings: PresetPreflightWarning[] = [];
  const entrypoints = Object.entries(manifest.entrypoints ?? {}).map(([name, entrypoint]) => {
    const issueStart = issues.length;
    validateInputs(name, entrypoint.inputs, issues);
    const capabilities = [
      ...entrypoint.requires.map((request, index) => validateCapabilityRequest(
        name,
        `entrypoints.${name}.requires[${index}]`,
        "requires",
        request,
        options.providers,
        issues
      )),
      ...entrypoint.produces.map((request, index) => validateCapabilityRequest(
        name,
        `entrypoints.${name}.produces[${index}]`,
        "produces",
        request,
        options.providers,
        issues
      ))
    ];
    validateSelectorInputReferences(name, entrypoint, issues);
    const logicalOutputs = validateLogicalOutputs(name, entrypoint.produces, issues);
    for (const [index, request] of entrypoint.requires.entries()) {
      if (request.capability === "tasks" && "scope" in request.select && request.select.scope === "all") {
        warnings.push({
          code: "broad-capability-selector",
          message: `Entrypoint ${name} requests the broad tasks/v1 scope=all projection.`,
          path: `entrypoints.${name}.requires[${index}].select.scope`
        });
      }
    }
    const escapeHatches = entrypoint.sideEffects.map((effect, index) => admitRawFs(
      manifest,
      name,
      effect,
      `entrypoints.${name}.sideEffects[${index}]`,
      options,
      issues,
      warnings
    ));
    return {
      name,
      type: entrypoint.type,
      valid: issues.length === issueStart,
      capabilities,
      logicalOutputs,
      escapeHatches
    };
  });
  return {
    schema: "preset-preflight-receipt/v1",
    preset: presetIdentity(manifest, options),
    valid: issues.length === 0,
    runtime: "semantic-capability-preflight/v1",
    semanticFailureFallback: "forbidden",
    entrypoints,
    issues,
    warnings
  };
}

function legacyReceipt(manifest: PresetManifest, options: PresetPreflightOptions): PresetPreflightReceipt {
  const warning = legacyPhysicalScopeWarning(manifest.id);
  return {
    schema: "preset-preflight-receipt/v1",
    preset: presetIdentity(manifest, options),
    valid: true,
    runtime: "legacy-scope-adapter/v1",
    semanticFailureFallback: "forbidden",
    entrypoints: Object.entries(manifest.entrypoints ?? {}).map(([name, entrypoint]) => ({
      name,
      type: entrypoint.type,
      valid: true,
      capabilities: [],
      logicalOutputs: [],
      escapeHatches: []
    })),
    issues: [],
    warnings: [warning]
  };
}

export function legacyPhysicalScopeWarning(presetId: string): PresetPreflightWarning {
  return {
    code: "legacy-physical-scope",
    message: `Preset ${presetId} uses the isolated v1/v2 physical-scope adapter; migrate its entrypoints to preset-manifest/v3 semantic capabilities.`,
    path: "schema"
  };
}

function validateInputs(
  entrypoint: string,
  inputs: Readonly<Record<string, PresetInputV3>>,
  issues: PresetPreflightIssue[]
): void {
  for (const [name, input] of Object.entries(inputs)) {
    const path = `entrypoints.${entrypoint}.inputs.${name}`;
    if ("default" in input && "defaultFrom" in input) {
      issues.push(preflightIssue("invalid_input_default", entrypoint, path, `Input ${name} cannot declare both default and defaultFrom.`, "Remove one default source, then rerun preset validation."));
    }
    if ((input.type === "enum" || input.type === "enum-list") && "default" in input && input.default !== undefined) {
      const defaults = Array.isArray(input.default) ? input.default : [input.default];
      if (defaults.some((value) => !input.values.includes(value))) {
        issues.push(preflightIssue("invalid_input_default", entrypoint, `${path}.default`, `Input ${name} has a default outside its declared values.`, "Choose only values declared by the input, then rerun preset validation."));
      }
    }
  }
}

function validateCapabilityRequest(
  entrypoint: string,
  path: string,
  direction: PresetCapabilityDirection,
  request: { readonly capability: string; readonly version: string },
  providers: ReadonlyArray<PresetCapabilityProvider>,
  issues: PresetPreflightIssue[]
): PresetPreflightReceipt["entrypoints"][number]["capabilities"][number] {
  const issueStart = issues.length;
  const catalogById = presetCapabilityCatalog.filter((candidate) => candidate.id === request.capability);
  if (catalogById.length === 0) {
    issues.push(preflightIssue("unknown_capability", entrypoint, `${path}.capability`, `Capability ${request.capability} is not present in the v3 catalog.`, "Use a catalog capability id; semantic failures never fall back to raw-fs."));
  } else if (!catalogById.some((candidate) => candidate.version === request.version)) {
    issues.push(preflightIssue("unknown_capability_version", entrypoint, `${path}.version`, `Capability ${request.capability}@${request.version} is not present in the v3 catalog.`, "Use an explicitly published capability version."));
  } else if (!catalogById.some((candidate) => candidate.version === request.version && candidate.directions.includes(direction as never))) {
    issues.push(preflightIssue("unknown_capability", entrypoint, path, `Capability ${request.capability}@${request.version} does not support ${direction}.`, "Choose a capability that supports this request direction."));
  } else {
    if (!isPresetCapabilityRequestShape(direction, request)) {
      issues.push(preflightIssue("unsupported_capability_selector", entrypoint, path, `Capability ${request.capability}@${request.version} has an unsupported ${direction} selector.`, "Use the selector shape frozen by this capability version."));
    }
  }
  const providerReady = providers.some((provider) => (
    provider.capability === request.capability && provider.version === request.version && provider.direction === direction
  ));
  if (!providerReady) {
    issues.push(preflightIssue("capability_provider_missing", entrypoint, path, `No runtime provider is registered for ${request.capability}@${request.version} ${direction}.`, "Install or register the exact provider before running this preset; raw-fs is not an automatic fallback."));
  }
  const catalogEntry = catalogById.find((candidate) => candidate.version === request.version);
  return {
    capability: request.capability,
    version: request.version,
    direction,
    dataShape: catalogEntry?.dataShape ?? null,
    authorityEnvelope: catalogEntry?.authorityEnvelope ?? null,
    provider: providerReady ? "ready" : "missing",
    admitted: issues.length === issueStart
  };
}

function validateSelectorInputReferences(
  entrypointName: string,
  entrypoint: PresetManifestV3["entrypoints"] extends infer _ ? NonNullable<PresetManifestV3["entrypoints"]>[string] : never,
  issues: PresetPreflightIssue[]
): void {
  const expected = new Map<string, PresetInputV3["type"]>();
  for (const request of entrypoint.requires) {
    const select = request.select as Readonly<Record<string, unknown>>;
    if (typeof select.taskFrom === "string" && select.taskFrom !== "current-task") expected.set(select.taskFrom, "task-ref");
    if (typeof select.relatedToTaskFrom === "string") expected.set(select.relatedToTaskFrom, "task-ref");
    if (typeof select.decisionFrom === "string") expected.set(select.decisionFrom, "decision-ref");
    if (typeof select.familiesFrom === "string") expected.set(select.familiesFrom, "enum-list");
    if (typeof select.packFrom === "string") expected.set(select.packFrom, "string");
  }
  for (const request of entrypoint.produces) {
    if (request.target.taskFrom !== "current-task") expected.set(request.target.taskFrom, "task-ref");
  }
  for (const [inputName, expectedType] of expected) {
    const actual = entrypoint.inputs[inputName];
    if (!actual || actual.type !== expectedType) {
      issues.push(preflightIssue("invalid_input_reference", entrypointName, `entrypoints.${entrypointName}.inputs.${inputName}`, `Capability selector references ${inputName} as ${expectedType}, but that typed input is not declared.`, "Declare the referenced typed input or correct the selector."));
    }
  }
}

function validateLogicalOutputs(
  entrypoint: string,
  requests: PresetManifestV3["entrypoints"] extends infer _ ? NonNullable<PresetManifestV3["entrypoints"]>[string]["produces"] : never,
  issues: PresetPreflightIssue[]
): ReadonlyArray<string> {
  const outputs: string[] = [];
  const seen = new Set<string>();
  for (const [requestIndex, request] of requests.entries()) {
    const values = request.capability === "task-documents" ? request.documents : request.artifacts;
    for (const [outputIndex, output] of values.entries()) {
      const key = `${request.capability}:${output.id}`;
      if (seen.has(key)) {
        issues.push(preflightIssue("duplicate_logical_output", entrypoint, `entrypoints.${entrypoint}.produces[${requestIndex}].${request.capability === "task-documents" ? "documents" : "artifacts"}[${outputIndex}].id`, `Logical output ${key} is declared more than once.`, "Give each logical output a unique id per capability."));
      }
      seen.add(key);
      outputs.push(key);
    }
  }
  return outputs;
}

function admitRawFs(
  manifest: PresetManifestV3,
  entrypoint: string,
  effect: PresetRawFsEffect,
  path: string,
  options: PresetPreflightOptions,
  issues: PresetPreflightIssue[],
  warnings: PresetPreflightWarning[]
): PresetPreflightReceipt["entrypoints"][number]["escapeHatches"][number] {
  const issueStart = issues.length;
  const grant = options.rawFsGrants?.find((candidate) => candidate.policyGrant === effect.approval.policyGrant);
  const enforcement = options.rawFsEnforcement?.find((candidate) => candidate.policyGrant === effect.approval.policyGrant && candidate.effectId === effect.id);
  const normalizedScopes = normalizeRawFsScopes(effect, entrypoint, path, issues);
  if (!grant) {
    issues.push(preflightIssue("raw_fs_grant_missing", entrypoint, `${path}.approval.policyGrant`, `Raw-fs effect ${effect.id} has no independent policy grant.`, "Create an external grant bound to this exact preset package and entrypoint."));
  } else {
    const expectedTrust = options.layer === "builtin" ? "bundled-signed-digest" : "independent-policy-grant";
    if (grant.sourceTrust !== expectedTrust || grant.packageDigest !== options.packageDigest) {
      issues.push(preflightIssue("raw_fs_source_untrusted", entrypoint, path, `Raw-fs effect ${effect.id} is not bound to a trusted source digest.`, "Bind the external grant to the current package digest and source trust class."));
    }
    const grantScopes = grant.scopes.map((scope) => `${scope.root}:${scope.pattern}`).sort();
    if (
      grant.presetId !== manifest.id || grant.presetVersion !== manifest.version || grant.entrypoint !== entrypoint ||
      grant.access !== effect.access || JSON.stringify(grantScopes) !== JSON.stringify(normalizedScopes)
    ) {
      issues.push(preflightIssue("raw_fs_grant_mismatch", entrypoint, path, `Raw-fs grant ${grant.policyGrant} does not exactly match the preset, entrypoint, access, and normalized scope ceiling.`, "Issue a digest-bound grant whose scope ceiling exactly matches the declaration."));
    }
    const expiresAt = Date.parse(effect.approval.expiresAt);
    const now = Date.parse(options.now);
    if (
      grant.owner !== effect.approval.owner || grant.decisionRef !== effect.approval.decisionRef ||
      grant.expiresAt !== effect.approval.expiresAt || !["active", "accepted"].includes(grant.decisionState) ||
      !Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now
    ) {
      issues.push(preflightIssue("raw_fs_approval_invalid", entrypoint, `${path}.approval`, `Raw-fs approval for ${effect.id} is inactive, expired, or does not match its external grant.`, "Renew an active/accepted owner-matched decision and expiry before validation."));
    } else if (expiresAt - now <= 7 * 24 * 60 * 60 * 1000) {
      warnings.push({ code: "raw-fs-expiring-soon", message: `Raw-fs effect ${effect.id} expires at ${effect.approval.expiresAt}.`, path: `${path}.approval.expiresAt` });
    }
  }
  if (
    !enforcement || !sameStrings(enforcement.normalizedScopes, normalizedScopes) ||
    enforcement.normalizedPhysicalScopes.length === 0 || !enforcement.lexicalContainment ||
    !enforcement.realpathContainment || !enforcement.symlinkLeafSafe ||
    !enforcement.forbiddenRootSafe || !enforcement.toctouProtected
  ) {
    issues.push(preflightIssue("raw_fs_scope_unverified", entrypoint, `${path}.scopes`, `Raw-fs effect ${effect.id} lacks complete lexical/realpath/symlink/forbidden-root/TOCTOU enforcement evidence.`, "Resolve and verify every scope through the protected physical-scope resolver."));
  }
  if (!enforcement?.hostEnforced) {
    issues.push(preflightIssue("raw_fs_host_unenforced", entrypoint, path, `The host cannot enforce raw-fs effect ${effect.id}.`, "Register a host enforcement binding before running the preset."));
  }
  if (effect.access === "staged-write" && !enforcement?.coordinatorEnforced) {
    issues.push(preflightIssue("raw_fs_coordinator_required", entrypoint, path, `Staged-write effect ${effect.id} is not bound to staged writer verification and coordinator ingest.`, "Route staged writes through output boundary verification and the WriteCoordinator."));
  }
  return {
    id: effect.id,
    effect: "raw-fs",
    access: effect.access,
    admitted: issues.length === issueStart,
    originalScopes: effect.scopes,
    normalizedScopeCeiling: normalizedScopes,
    normalizedPhysicalScopes: enforcement?.normalizedPhysicalScopes ?? [],
    policyGrant: effect.approval.policyGrant,
    decisionRef: effect.approval.decisionRef,
    owner: effect.approval.owner,
    expiresAt: effect.approval.expiresAt,
    enforcementVersion: "protected-scopes/v1",
    denialCodes: issues.slice(issueStart).map((issue) => issue.code)
  };
}

function normalizeRawFsScopes(
  effect: PresetRawFsEffect,
  entrypoint: string,
  path: string,
  issues: PresetPreflightIssue[]
): ReadonlyArray<string> {
  const normalized: string[] = [];
  for (const [index, scope] of effect.scopes.entries()) {
    const pattern = scope.pattern.replace(/\/+/gu, "/").replace(/^\.\//u, "");
    const invalid = pattern.length === 0 || pattern === "**" || pattern.startsWith("/") || pattern.includes("\\") || pattern.includes("\0") || pattern.split("/").includes("..") || pattern.includes("//");
    const invalidWriteRoot = effect.access === "staged-write" && !["authored", "output"].includes(scope.root);
    if (invalid || invalidWriteRoot) {
      issues.push(preflightIssue("raw_fs_scope_invalid", entrypoint, `${path}.scopes[${index}]`, `Raw-fs scope ${scope.root}:${scope.pattern} is not a safe ${effect.access} scope.`, "Use a contained POSIX pattern; staged-write is limited to authored/output staging roots and root-wide ** is forbidden."));
    }
    normalized.push(`${scope.root}:${pattern}`);
  }
  return normalized.sort();
}

function presetIdentity(manifest: PresetManifest, options: PresetPreflightOptions): PresetPreflightReceipt["preset"] {
  return { id: manifest.id, version: manifest.version, manifestSchema: manifest.schema, layer: options.layer, packageDigest: options.packageDigest };
}

function preflightIssue(
  code: PresetPreflightIssue["code"],
  entrypoint: string,
  path: string,
  message: string,
  hint: string
): PresetPreflightIssue {
  return { code, entrypoint, path, message, hint };
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
