import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digestJson } from "./architecture-digests.mjs";
import { isArchitectureStableId } from "./architecture-manifest.mjs";
import { compareArchitectureText } from "./architecture-portable-path.mjs";

const toolName = "likec4";
const toolVersion = "1.58.0";
const adapterId = "likec4/model-v1";
const defaultTimeoutMs = 10_000;
const maxOutputBytes = 64 * 1024 * 1024;
const require = createRequire(import.meta.url);

export async function runLikeC4ProviderAdapter(options) {
  const execute = options.executeLikeC4 ?? executeLikeC4;
  const execution = await execute({
    cwd: options.configuration.modelRoot,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs
  });
  if (execution.status === "tool-missing") {
    return {
      status: "tool-missing",
      tool: {
        role: "provider",
        declarationId: options.manifest.provider.id,
        adapter: adapterId,
        tool: toolName,
        version: null,
        reason: "not-installed",
        hint: "Install the pinned LikeC4 1.58.0 development dependency in this workspace."
      }
    };
  }
  if (execution.status !== "ok") {
    return invalid("architecture_provider_process_failed", "provider", `LikeC4 failed closed: ${execution.reason}.`);
  }
  if (execution.version !== toolVersion) {
    return invalid("architecture_provider_version_mismatch", "provider.tool.version", `Expected LikeC4 ${toolVersion}.`);
  }
  const decoded = decodeLikeC4ProviderObservation({
    raw: execution.raw,
    manifest: options.manifest,
    modelDigest: options.configuration.modelDigest
  });
  if (decoded.status !== "ok") return decoded;
  return {
    status: "ok",
    tool: {
      role: "provider",
      declarationId: options.manifest.provider.id,
      adapter: adapterId,
      tool: toolName,
      version: toolVersion
    },
    observation: decoded.observation
  };
}

export function decodeLikeC4ProviderObservation({ raw, manifest, modelDigest }) {
  const project = selectProject(raw);
  if (!project.ok) return project.result;
  if (!isRecord(project.value.elements) || !isRecord(project.value.relations)) {
    return invalid("architecture_provider_output_invalid", "provider.output", "LikeC4 JSON must expose element and relation records.");
  }

  const modelNodeIds = new Map();
  const nodeIds = [];
  for (const [modelId, element] of Object.entries(project.value.elements)) {
    const archId = element?.metadata?.archId;
    if (!isArchitectureStableId(archId)) {
      return invalid("architecture_provider_node_identity_invalid", `provider.elements.${modelId}.metadata.archId`, "Every LikeC4 element requires a stable archId.");
    }
    if (nodeIds.includes(archId)) {
      return invalid("architecture_provider_node_identity_duplicate", `provider.elements.${modelId}.metadata.archId`, `Architecture node ID ${archId} is not model-global unique.`);
    }
    modelNodeIds.set(modelId, archId);
    nodeIds.push(archId);
  }

  const manifestExtractorIds = new Set(manifest.extractors.map((entry) => entry.id));
  const relationships = [];
  const relationshipIds = new Set();
  const extractorEdges = new Set();
  for (const [modelRelationId, relation] of Object.entries(project.value.relations)) {
    const metadata = relation?.metadata;
    const archId = metadata?.archId;
    const expectation = metadata?.expectation;
    if (!isArchitectureStableId(archId)) {
      return invalid("architecture_provider_relationship_identity_invalid", `provider.relations.${modelRelationId}.metadata.archId`, "Every LikeC4 relationship requires a stable archId.");
    }
    if (!["allowed", "required", "forbidden"].includes(expectation)) {
      return invalid("architecture_provider_expectation_invalid", `provider.relations.${modelRelationId}.metadata.expectation`, "Every LikeC4 relationship requires an allowed, required, or forbidden expectation.");
    }
    if (relationshipIds.has(archId)) {
      return invalid("architecture_provider_relationship_identity_duplicate", `provider.relations.${modelRelationId}.metadata.archId`, `Architecture relationship ID ${archId} is not model-global unique.`);
    }
    relationshipIds.add(archId);
    const extractorIds = metadataList(metadata?.extractorIds);
    if (extractorIds === null) {
      return invalid("architecture_provider_extractor_reference_invalid", `provider.relations.${modelRelationId}.metadata.extractorIds`, "Relationship extractorIds must be a non-empty string or string list when present.");
    }
    if (extractorIds.length === 0) continue;
    if (extractorIds.some((id) => !isArchitectureStableId(id) || !manifestExtractorIds.has(id)) ||
      new Set(extractorIds).size !== extractorIds.length) {
      return invalid("architecture_provider_extractor_reference_invalid", `provider.relations.${modelRelationId}.metadata.extractorIds`, "Relationship extractorIds must be unique manifest extractor IDs.");
    }
    const sourceNodeId = modelNodeIds.get(relation?.source?.model);
    const targetNodeId = modelNodeIds.get(relation?.target?.model);
    if (sourceNodeId === undefined || targetNodeId === undefined) {
      return invalid("architecture_provider_relationship_endpoint_invalid", `provider.relations.${modelRelationId}`, "Relationship endpoints must resolve to architecture nodes in the exported model.");
    }
    for (const extractorId of extractorIds) {
      const extractorEdge = `${extractorId}\0${sourceNodeId}\0${targetNodeId}`;
      if (extractorEdges.has(extractorEdge)) {
        return invalid("architecture_provider_relationship_ambiguous", `provider.relations.${modelRelationId}`, "An extractor may bind at most one authored relationship to the same ordered architecture-node pair.");
      }
      extractorEdges.add(extractorEdge);
    }
    relationships.push({
      id: archId,
      sourceNodeId,
      targetNodeId,
      expectation,
      extractorIds: extractorIds.sort(compareArchitectureText)
    });
  }

  return {
    status: "ok",
    observation: {
      schema: "architecture-provider-observation/v1",
      providerId: manifest.provider.id,
      modelDigest,
      nodes: nodeIds.sort(compareArchitectureText),
      relationships: relationships.sort((left, right) => compareArchitectureText(left.id, right.id))
    }
  };
}

export function likeC4Invocation() {
  return {
    executable: toolName,
    versionArgv: ["--version"],
    api: "LikeC4.fromWorkspace",
    cwd: "modelRoot",
    writes: false,
    shell: false
  };
}

async function executeLikeC4({ cwd, timeoutMs }) {
  void timeoutMs;
  const module = likeC4Module();
  if (module === null) return { status: "tool-missing" };
  if (module.version !== toolVersion) return { status: "ok", version: module.version, raw: null };
  let likec4;
  try {
    const { LikeC4 } = await import(module.url);
    likec4 = await LikeC4.fromWorkspace(cwd);
    if (likec4.hasErrors()) return { status: "failed", reason: "model-invalid" };
    const model = await likec4.computedModel();
    const raw = {
      projectId: model.projectId,
      elements: Object.fromEntries([...model.elements()].map((element) => [element.id, {
        id: element.id,
        metadata: element.metadata
      }])),
      relations: Object.fromEntries([...model.relationships()].map((relationship) => [relationship.id, {
        id: relationship.id,
        source: { model: relationship.source.id },
        target: { model: relationship.target.id },
        metadata: relationship.metadata
      }]))
    };
    if (Buffer.byteLength(JSON.stringify(raw)) > maxOutputBytes) return { status: "failed", reason: "output-limit" };
    return { status: "ok", version: module.version, raw };
  } catch {
    return { status: "failed", reason: "output-invalid" };
  } finally {
    likec4?.dispose();
  }
}

function likeC4Module() {
  try {
    const packageJsonPath = require.resolve("likec4/package.json");
    const packageRoot = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson.name !== toolName || typeof packageJson.version !== "string") return null;
    const modulePath = packageJson.exports?.["."]?.default?.import ?? packageJson.module;
    if (typeof modulePath !== "string") return null;
    return { url: pathToFileURL(path.resolve(packageRoot, modulePath)).href, version: packageJson.version };
  } catch {
    return null;
  }
}

function selectProject(raw) {
  const projects = Array.isArray(raw) ? raw : [raw];
  if (projects.length === 0 || projects.some((entry) => !isRecord(entry))) {
    return { ok: false, result: invalid("architecture_provider_output_invalid", "provider.output", "LikeC4 JSON must contain at least one project model.") };
  }
  const byDigest = new Map(projects.map((entry) => [digestJson(entry), entry]));
  if (byDigest.size !== 1) {
    return { ok: false, result: invalid("architecture_provider_project_ambiguous", "provider.output", "LikeC4 exported multiple distinct project models; the architecture modelRoot must resolve unambiguously.") };
  }
  return { ok: true, value: byDigest.values().next().value };
}

function metadataList(value) {
  if (value === undefined) return [];
  if (typeof value === "string") return value.length > 0 ? [value] : null;
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)
    ? [...value]
    : null;
}

function invalid(code, pathName, message) {
  return { status: "invalid", issues: [{ code, path: pathName, message }] };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
