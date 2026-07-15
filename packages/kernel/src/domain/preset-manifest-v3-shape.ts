export interface PresetManifestV3ShapeIssue {
  readonly code: "unknown_extension_field";
  readonly message: string;
  readonly path: string;
}

export function validatePresetEntrypointsV3Shape(
  input: unknown,
  path: string
): ReadonlyArray<PresetManifestV3ShapeIssue> {
  const issues: PresetManifestV3ShapeIssue[] = [];
  if (!isV3Record(input)) return issues;
  for (const [entrypointName, entrypoint] of Object.entries(input)) {
    if (!isV3Record(entrypoint)) continue;
    const entrypointPath = `${path}.${entrypointName}`;
    const payloadKeys = entrypoint.type === "script" ? ["command"] : entrypoint.type === "template" ? ["templates"] : [];
    validateV3ObjectKeys(entrypoint, entrypointPath, ["type", ...payloadKeys, "intent", "inputs", "requires", "produces", "sideEffects"], issues);
    validateV3ObjectKeys(entrypoint.intent, `${entrypointPath}.intent`, ["verb", "subject"], issues);
    if (isV3Record(entrypoint.inputs)) {
      for (const [inputName, inputDefinition] of Object.entries(entrypoint.inputs)) {
        validateV3ObjectKeys(inputDefinition, `${entrypointPath}.inputs.${inputName}`, ["type", "required", "default", "defaultFrom", "values"], issues);
      }
    }
    validateCapabilityRequests(entrypoint.requires, `${entrypointPath}.requires`, "requires", issues);
    validateCapabilityRequests(entrypoint.produces, `${entrypointPath}.produces`, "produces", issues);
    validateSideEffects(entrypoint.sideEffects, `${entrypointPath}.sideEffects`, issues);
  }
  return issues;
}

function validateCapabilityRequests(
  input: unknown,
  path: string,
  direction: "requires" | "produces",
  issues: PresetManifestV3ShapeIssue[]
): void {
  if (!Array.isArray(input)) return;
  for (const [index, request] of input.entries()) {
    const requestPath = `${path}[${index}]`;
    if (!isV3Record(request)) continue;
    if (direction === "requires") {
      validateV3ObjectKeys(request, requestPath, ["capability", "version", "select"], issues);
      validateV3ObjectKeys(request.select, `${requestPath}.select`, selectorKeys[String(request.capability)] ?? [], issues);
      continue;
    }
    const collectionKey = request.capability === "task-documents" ? "documents" : "artifacts";
    validateV3ObjectKeys(request, requestPath, ["capability", "version", "target", collectionKey], issues);
    validateV3ObjectKeys(request.target, `${requestPath}.target`, ["taskFrom"], issues);
    const logicalOutputs = request[collectionKey];
    if (Array.isArray(logicalOutputs)) {
      for (const [outputIndex, output] of logicalOutputs.entries()) {
        validateV3ObjectKeys(output, `${requestPath}.${collectionKey}[${outputIndex}]`, ["id", "schema", "mediaTypes", "cardinality", "required"], issues);
      }
    }
  }
}

function validateSideEffects(input: unknown, path: string, issues: PresetManifestV3ShapeIssue[]): void {
  if (!Array.isArray(input)) return;
  for (const [index, sideEffect] of input.entries()) {
    const effectPath = `${path}[${index}]`;
    validateV3ObjectKeys(sideEffect, effectPath, ["effect", "id", "access", "scopes", "justification", "approval"], issues);
    if (!isV3Record(sideEffect)) continue;
    if (Array.isArray(sideEffect.scopes)) {
      for (const [scopeIndex, scope] of sideEffect.scopes.entries()) {
        validateV3ObjectKeys(scope, `${effectPath}.scopes[${scopeIndex}]`, ["root", "pattern"], issues);
      }
    }
    validateV3ObjectKeys(sideEffect.approval, `${effectPath}.approval`, ["owner", "decisionRef", "policyGrant", "expiresAt"], issues);
  }
}

function validateV3ObjectKeys(
  input: unknown,
  path: string,
  allowedKeys: ReadonlyArray<string>,
  issues: PresetManifestV3ShapeIssue[]
): void {
  if (!isV3Record(input)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push({ code: "unknown_extension_field", message: `Unknown extension field ${key}.`, path: `${path}.${key}` });
    }
  }
}

function isV3Record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

const selectorKeys: Readonly<Record<string, ReadonlyArray<string>>> = {
  tasks: ["scope", "view", "taskFrom"],
  decisions: ["states", "view", "relatedToTaskFrom"],
  adrs: ["states", "view"],
  "operating-docs": ["collections", "view"],
  "task-artifacts": ["scope", "artifactIds", "taskFrom"],
  "relation-graph": ["scope", "decisionFrom", "view"],
  "runtime-events": ["view"],
  "generated-artifacts": ["view", "familiesFrom"],
  "write-journal": ["view"],
  docmap: ["view"],
  "external-source-pack": ["packFrom", "view"],
  "repository-source": ["collections", "view"]
};
