import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveHarnessLayout,
  taskPackagePath,
  type HarnessLayoutInput,
  type LogicalArtifactV1,
  type PresetCapabilityProvider,
  type PresetEntrypointV3,
  type PresetInputV3,
  type PresetManifestV3
} from "../../../../kernel/src/index.ts";
import type { ResolvedPreset } from "./state.ts";
import type { ResolvedScriptEntry, ScriptEntry } from "./script-host.ts";
import {
  materializeRequirement,
  sourceScopesForRequirement,
  type ScopeCandidate
} from "./preset-capability-providers.ts";
import type { CanonicalScriptStage } from "./script-staging.ts";
import {
  permissionPathsForScope,
  uniquePermissionPaths,
  type ResolvedScopeSet
} from "./script-scope.ts";

type SemanticScriptEntrypoint = Extract<PresetEntrypointV3, { readonly type: "script" }>;
type ResolvedSemanticPreset = Omit<ResolvedPreset, "manifest"> & { readonly manifest: PresetManifestV3 };

export interface SemanticPresetExecution {
  readonly preset: ResolvedSemanticPreset;
  readonly entrypointName: string;
  readonly entrypoint: SemanticScriptEntrypoint;
}

interface WritableRepresentation {
  readonly mediaType: string;
  readonly path: string;
  readonly logicalPath: string;
}

interface WritableArtifact {
  readonly id: string;
  readonly schema: string;
  readonly required: boolean;
  readonly representations: ReadonlyArray<WritableRepresentation>;
}

export interface PreparedSemanticPresetExecution {
  readonly execution: SemanticPresetExecution;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly currentTaskId: string;
  readonly outputRoot: string;
  readonly protectedSourceScopes: ResolvedScopeSet;
  readonly stageEnvelope: ResolvedScopeSet;
  readonly outputs: ReadonlyArray<WritableArtifact>;
  readonly receipt: PresetCapabilityRuntimeReceipt;
}

export interface MaterializedSemanticPresetExecution {
  readonly context: Readonly<Record<string, unknown>>;
  readonly childReadPermissions: ReadonlyArray<string>;
  readonly childWritePermissions: ReadonlyArray<string>;
  readonly writerRoots: ReadonlyArray<string>;
  readonly outputPatterns: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<WritableArtifact>;
}

export interface PresetCapabilityRuntimeReceipt {
  readonly schema: "preset-capability-runtime-receipt/v1";
  readonly presetId: string;
  readonly presetVersion: string;
  readonly entrypoint: string;
  readonly contextSchema: "preset-context/v2";
  readonly semanticFailureFallback: "forbidden";
  readonly bindings: ReadonlyArray<{
    readonly capability: string;
    readonly version: string;
    readonly direction: "requires" | "produces";
    readonly provider: string;
    readonly mappedAs: "immutable-projection" | "staged-writer";
  }>;
}

type PreparationResult =
  | { readonly ok: true; readonly value: PreparedSemanticPresetExecution }
  | { readonly ok: false; readonly hint: string };

type MaterializationResult =
  | { readonly ok: true; readonly value: MaterializedSemanticPresetExecution }
  | { readonly ok: false; readonly hint: string };

const semanticProviderId = "cli-semantic-capability-runtime/v1";

export const registeredSemanticPresetCapabilityProviders: ReadonlyArray<PresetCapabilityProvider> = [
  ...[
    "tasks",
    "decisions",
    "adrs",
    "operating-docs",
    "relation-graph",
    "runtime-events",
    "generated-artifacts",
    "write-journal",
    "docmap",
    "repository-source"
  ].map((capability) => ({ capability, version: "1", direction: "requires" as const })),
  { capability: "task-artifacts", version: "1", direction: "requires" as const },
  { capability: "task-artifacts", version: "1", direction: "produces" as const }
];

export function semanticPresetScriptEntry(
  preset: ResolvedSemanticPreset,
  entrypointName: string,
  entrypoint: SemanticScriptEntrypoint
): ResolvedScriptEntry {
  const entry: ScriptEntry = {
    id: `preset:${preset.manifest.id}:${entrypointName}`,
    source: "preset",
    type: "script",
    command: entrypoint.command,
    reads: [],
    writes: [],
    inputs: entrypoint.inputs,
    metadata: {
      description: `${preset.manifest.title} ${entrypointName}`,
      purpose: semanticPurpose(entrypoint.intent.verb),
      kind: entrypoint.intent.verb === "check" ? "check" : undefined,
      contractVersion: "script-entry/v1",
      produces: []
    }
  };
  return {
    entry,
    verticalId: preset.manifest.vertical,
    manifestRoot: path.dirname(preset.sourcePath),
    owner: {
      id: preset.manifest.id,
      title: preset.manifest.title,
      version: preset.manifest.version,
      layer: preset.layer
    },
    context: {
      presetId: preset.manifest.id,
      presetTitle: preset.manifest.title,
      entrypoint: entrypointName
    },
    semantic: { preset, entrypointName, entrypoint }
  };
}

export function prepareSemanticPresetExecution(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly execution: SemanticPresetExecution;
  readonly taskId?: string;
  readonly runtimeInputs?: Readonly<Record<string, string>>;
  readonly fallbackOutputRoot: string;
  readonly dryRun?: boolean;
}): PreparationResult {
  const { execution } = options;
  if (execution.entrypoint.sideEffects.length > 0) {
    return runtimeUnavailable("Semantic execution does not admit raw-fs or any other side effect without its independent grant and enforcement binding.");
  }
  const currentTaskId = options.taskId?.trim() ?? "";
  if (!currentTaskId) return runtimeUnavailable("preset-context/v2 requires a current task binding.");
  const inputs = bindSemanticInputs(execution.entrypoint.inputs, options.runtimeInputs ?? {}, currentTaskId);
  if (!inputs.ok) return inputs;

  const layout = resolveHarnessLayout(options.rootInput);
  const sourceCandidates: ScopeCandidate[] = [];
  for (const request of execution.entrypoint.requires) {
    if (!providerRegistered(request.capability, "requires")) {
      return runtimeUnavailable(`No semantic execution provider is registered for ${request.capability}@${request.version} requires; raw-fs fallback is forbidden.`);
    }
    const sources = sourceScopesForRequirement(layout, request, inputs.value, currentTaskId, options.dryRun === true);
    if (!sources.ok) return sources;
    sourceCandidates.push(...sources.value);
  }

  let targetTaskId: string | undefined;
  const outputs: WritableArtifact[] = [];
  for (const request of execution.entrypoint.produces) {
    if (!providerRegistered(request.capability, "produces")) {
      return runtimeUnavailable(`No semantic execution provider is registered for ${request.capability}@${request.version} produces; raw-fs fallback is forbidden.`);
    }
    if (request.capability !== "task-artifacts") {
      return runtimeUnavailable(`The Phase 1 runtime has no staged writer for ${request.capability}@${request.version}.`);
    }
    const resolvedTarget = taskFrom(request.target.taskFrom, inputs.value, currentTaskId);
    if (!resolvedTarget.ok) return resolvedTarget;
    if (targetTaskId !== undefined && targetTaskId !== resolvedTarget.value) {
      return runtimeUnavailable("One semantic execution cannot bind task-artifacts/v1 writers for multiple target tasks.");
    }
    targetTaskId = resolvedTarget.value;
  }

  const outputRoot = targetTaskId ? taskPackagePath(options.rootInput, targetTaskId) : options.fallbackOutputRoot;
  for (const request of execution.entrypoint.produces) {
    if (request.capability !== "task-artifacts") continue;
    for (const artifact of request.artifacts) {
      const writable = writableArtifact(layout.rootDir, outputRoot, artifact);
      if (!writable.ok) return writable;
      outputs.push(writable.value);
    }
  }
  const writerRoots = outputs.length > 0 ? [{ root: path.join(outputRoot, "artifacts"), recursive: true }] : [];
  const bindings = [
    ...execution.entrypoint.requires.map((request) => ({
      capability: request.capability,
      version: request.version,
      direction: "requires" as const,
      provider: semanticProviderId,
      mappedAs: "immutable-projection" as const
    })),
    ...execution.entrypoint.produces.map((request) => ({
      capability: request.capability,
      version: request.version,
      direction: "produces" as const,
      provider: semanticProviderId,
      mappedAs: "staged-writer" as const
    }))
  ];
  return {
    ok: true,
    value: {
      execution,
      inputs: inputs.value,
      currentTaskId,
      outputRoot,
      protectedSourceScopes: resolvedSemanticScope(sourceCandidates),
      stageEnvelope: resolvedSemanticScope(writerRoots),
      outputs,
      receipt: {
        schema: "preset-capability-runtime-receipt/v1",
        presetId: execution.preset.manifest.id,
        presetVersion: execution.preset.manifest.version,
        entrypoint: execution.entrypointName,
        contextSchema: "preset-context/v2",
        semanticFailureFallback: "forbidden",
        bindings
      }
    }
  };
}

export function materializeSemanticPresetExecution(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly preparation: PreparedSemanticPresetExecution;
  readonly stage?: CanonicalScriptStage;
  readonly runDir: string;
  readonly runId: string;
  readonly resultPath: string;
}): MaterializationResult {
  const executionRootInput = options.stage?.rootInput ?? options.rootInput;
  const capabilitiesRoot = path.join(options.runDir, "capabilities");
  mkdirSync(capabilitiesRoot, { recursive: true });
  const readBindings: Record<string, unknown[]> = {};
  const childReadPermissions: string[] = [];

  for (const [index, request] of options.preparation.execution.entrypoint.requires.entries()) {
    const projection = materializeRequirement({
      request,
      index,
      executionRootInput,
      realRootInput: options.rootInput,
      inputs: options.preparation.inputs,
      currentTaskId: options.preparation.currentTaskId,
      capabilitiesRoot
    });
    if (!projection.ok) return projection;
    const existing = readBindings[request.capability] ?? [];
    existing.push({
      schema: "preset-capability-handle/v1",
      capability: request.capability,
      version: request.version,
      provider: semanticProviderId,
      path: projection.value.path
    });
    readBindings[request.capability] = existing;
    childReadPermissions.push(projection.value.path, ...projection.value.extraReadPermissions);
  }

  const stagedOutputs = options.stage
    ? remapWritableArtifacts(options.preparation.outputs, options.stage)
    : options.preparation.outputs;
  const writerRoots = uniquePermissionPaths(stagedOutputs.flatMap((artifact) => artifact.representations.map((entry) => path.dirname(entry.path))));
  for (const root of writerRoots) mkdirSync(root, { recursive: true });
  const writeBindings = stagedOutputs.length === 0 ? {} : {
    "task-artifacts": [{
      schema: "preset-capability-writer/v1",
      capability: "task-artifacts",
      version: "1",
      provider: semanticProviderId,
      artifacts: Object.fromEntries(stagedOutputs.map((artifact) => [artifact.id, {
        schema: artifact.schema,
        required: artifact.required,
        representations: artifact.representations
      }]))
    }]
  };
  return {
    ok: true,
    value: {
      context: {
        schema: "preset-context/v2",
        preset: {
          id: options.preparation.execution.preset.manifest.id,
          version: options.preparation.execution.preset.manifest.version,
          entrypoint: options.preparation.execution.entrypointName
        },
        run: { id: options.runId, taskId: options.preparation.currentTaskId },
        inputs: options.preparation.inputs,
        capabilities: { reads: readBindings, writes: writeBindings },
        result: { schema: "script-result/v1", path: options.resultPath },
        receipt: options.preparation.receipt
      },
      childReadPermissions: uniquePermissionPaths(childReadPermissions),
      childWritePermissions: writerRoots.flatMap((root) => permissionPathsForScope(root, true)),
      writerRoots,
      outputPatterns: stagedOutputs.flatMap((artifact) => artifact.representations.map((entry) => entry.path)),
      outputs: stagedOutputs
    }
  };
}

export function verifySemanticPresetOutputs(
  outputs: ReadonlyArray<WritableArtifact>
): { readonly ok: true } | { readonly ok: false; readonly hint: string } {
  for (const output of outputs) {
    for (const representation of output.representations) {
      if (!existsSync(representation.path)) {
        if (output.required) return runtimeUnavailable(`Required logical artifact ${output.id} was not produced for ${representation.mediaType}.`);
        continue;
      }
      const body = readFileSync(representation.path, "utf8");
      if (body.trim().length === 0) return runtimeUnavailable(`Logical artifact ${output.id} produced an empty ${representation.mediaType} representation.`);
      if (representation.mediaType === "application/json") {
        try {
          const parsed = JSON.parse(body) as unknown;
          if (!isRuntimeRecord(parsed) || parsed.schema !== output.schema) {
            return runtimeUnavailable(`Logical artifact ${output.id} must declare schema ${output.schema}.`);
          }
        } catch {
          return runtimeUnavailable(`Logical artifact ${output.id} produced malformed application/json.`);
        }
      }
    }
  }
  return { ok: true };
}

function bindSemanticInputs(
  definitions: Readonly<Record<string, PresetInputV3>>,
  runtime: Readonly<Record<string, string>>,
  currentTaskId: string
): { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly hint: string } {
  for (const name of Object.keys(runtime)) {
    if (!(name in definitions)) return runtimeUnavailable(`Runtime input ${name} is not declared by the v3 entrypoint.`);
  }
  const values: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    let value: unknown = runtime[name];
    if (value === undefined && "defaultFrom" in definition && definition.defaultFrom === "current-task") value = currentTaskId;
    if (value === undefined && "default" in definition) value = definition.default;
    if (value === undefined) {
      if (definition.required) return runtimeUnavailable(`Required runtime input ${name} is missing.`);
      continue;
    }
    const decoded = decodeRuntimeInput(name, definition, value);
    if (!decoded.ok) return decoded;
    values[name] = decoded.value;
  }
  return { ok: true, value: values };
}

function decodeRuntimeInput(
  name: string,
  definition: PresetInputV3,
  value: unknown
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly hint: string } {
  if (definition.type === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true" || value === "false") return { ok: true, value: value === "true" };
    return runtimeUnavailable(`Runtime input ${name} must be boolean.`);
  }
  if (definition.type === "integer") {
    const integer = typeof value === "number" ? value : /^-?\d+$/u.test(String(value)) ? Number(value) : Number.NaN;
    return Number.isInteger(integer) ? { ok: true, value: integer } : runtimeUnavailable(`Runtime input ${name} must be an integer.`);
  }
  if (["enum-list", "preset-ref-list", "artifact-ref-list"].includes(definition.type)) {
    const list = Array.isArray(value) ? value.map(String) : String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
    if (definition.type === "enum-list" && list.some((entry) => !definition.values.includes(entry))) {
      return runtimeUnavailable(`Runtime input ${name} contains a value outside its declared enum.`);
    }
    return { ok: true, value: list };
  }
  const scalarValue = String(value);
  if (definition.type === "enum" && !definition.values.includes(scalarValue)) {
    return runtimeUnavailable(`Runtime input ${name} is outside its declared enum.`);
  }
  if ((definition.type === "task-ref" || definition.type === "decision-ref") && scalarValue.trim().length === 0) {
    return runtimeUnavailable(`Runtime input ${name} must be a non-empty ${definition.type}.`);
  }
  return { ok: true, value: scalarValue };
}

function taskFrom(
  selector: string,
  inputs: Readonly<Record<string, unknown>>,
  currentTaskId: string
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly hint: string } {
  const value = selector === "current-task" ? currentTaskId : inputs[selector];
  return typeof value === "string" && value.length > 0
    ? { ok: true, value }
    : runtimeUnavailable(`Task target ${selector} could not be resolved from bound inputs.`);
}

function writableArtifact(
  rootDir: string,
  outputRoot: string,
  artifact: LogicalArtifactV1
): { readonly ok: true; readonly value: WritableArtifact } | { readonly ok: false; readonly hint: string } {
  const representations: WritableRepresentation[] = [];
  for (const mediaType of artifact.mediaTypes) {
    const extension = mediaType === "application/json" ? ".json" : mediaType === "text/markdown" ? ".md" : undefined;
    if (!extension) return runtimeUnavailable(`task-artifacts/v1 has no representation mapping for media type ${mediaType}.`);
    const representationPath = path.join(outputRoot, "artifacts", `${artifactBasename(artifact.id)}${extension}`);
    representations.push({
      mediaType,
      path: representationPath,
      logicalPath: path.relative(rootDir, representationPath).split(path.sep).join("/")
    });
  }
  return { ok: true, value: { id: artifact.id, schema: artifact.schema, required: artifact.required, representations } };
}

function artifactBasename(id: string): string {
  if (id === "milestone-dossier-data") return "dossier.data";
  if (id === "dogfood-utilization-report") return "dogfood-utilization-audit";
  if (id === "gate-retro-snapshot") return "gate-retro.snapshot";
  return id;
}

function remapWritableArtifacts(outputs: ReadonlyArray<WritableArtifact>, stage: CanonicalScriptStage): ReadonlyArray<WritableArtifact> {
  return outputs.map((output) => ({
    ...output,
    representations: output.representations.map((entry) => ({
      ...entry,
      path: path.join(stage.outputRoot, path.relative(stage.realOutputRoot, entry.path))
    }))
  }));
}

function resolvedSemanticScope(candidates: ReadonlyArray<ScopeCandidate>): ResolvedScopeSet {
  const byRoot = new Map<string, ScopeCandidate>();
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate.root);
    const existing = byRoot.get(absolute);
    byRoot.set(absolute, { root: absolute, recursive: existing?.recursive === true || candidate.recursive });
  }
  const values = [...byRoot.values()];
  return {
    roots: values.map((candidate) => candidate.root),
    permissions: uniquePermissionPaths(values.flatMap((candidate) => permissionPathsForScope(candidate.root, candidate.recursive)))
  };
}

function providerRegistered(capability: string, direction: "requires" | "produces"): boolean {
  return registeredSemanticPresetCapabilityProviders.some((provider) => provider.capability === capability && provider.version === "1" && provider.direction === direction);
}

function semanticPurpose(verb: SemanticScriptEntrypoint["intent"]["verb"]): ScriptEntry["metadata"]["purpose"] {
  if (verb === "audit" || verb === "check") return "audit";
  if (verb === "capture" || verb === "scaffold") return "scaffold";
  if (verb === "transform") return "transform";
  return "generate";
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeUnavailable(hint: string): { readonly ok: false; readonly hint: string } {
  return { ok: false, hint };
}
