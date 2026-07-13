import {
  validateArchitectureCodeObservation,
  validateArchitectureComparisonResult,
  validateArchitectureProviderObservation
} from "./architecture-adapter-contracts.mjs";
import { javascriptTypeScriptExtractorBoundary } from "./architecture-code-graph.mjs";
import { runJavaScriptTypeScriptCodeGraph } from "./architecture-javascript-typescript-extractor.mjs";
import { compareArchitectureText } from "./architecture-portable-path.mjs";
import {
  architectureFindingsHaveUniqueIds,
  architectureToolIdentitiesAreUnique,
  isArchitectureRecord,
  validArchitectureIssue,
  validArchitectureMissingTool,
  validArchitectureProvenance
} from "./architecture-report-contracts.mjs";

const adapterRegistry = new Map([
  ["javascript-typescript/imports-v1", {
    extract: runJavaScriptTypeScriptCodeGraph,
    run: runMissingJavaScriptTypeScriptAdapter,
    compare: compareMissingJavaScriptTypeScriptAdapter
  }]
]);
const providerRegistry = new Map([
  ["likec4", runMissingLikeC4ProviderAdapter]
]);
const fixedRegistry = { providers: providerRegistry, extractors: adapterRegistry };
const contractDigest = `sha256:${"0".repeat(64)}`;
const likeC4ProviderAdapterId = "likec4/model-v1";
const jsTsExtractorBoundary = javascriptTypeScriptExtractorBoundary();

export async function runDeclaredArchitectureExtractors(options) {
  return runArchitectureAdapterPipeline(options, fixedRegistry);
}

export async function runDeclaredArchitectureCodeGraph(options) {
  const entry = adapterRegistry.get(options.extractor.adapter);
  if (typeof entry?.extract !== "function") {
    return {
      status: "invalid",
      issues: [pipelineIssue(
        "architecture_code_graph_adapter_unknown",
        "extractor.adapter",
        `No fixed code graph extractor is registered for ${options.extractor.adapter}.`
      )]
    };
  }
  return entry.extract(options);
}

export async function runArchitectureAdapterPipeline(options, registry) {
  const state = pipelineState();
  await runProviderStage(options, registry, state);
  for (const extractor of sortedExtractors(options.manifest.extractors)) {
    await runExtractorStage(options, registry, state, extractor);
  }
  if (!architectureToolIdentitiesAreUnique(state.missingTools)) {
    state.issues.push(pipelineIssue(
      "architecture_missing_tool_identity_duplicate",
      "missingTools",
      "Architecture adapter missing-tool identities must be globally unique."
    ));
  }
  const findings = state.comparisons.flatMap((entry) => entry.findings);
  if (!architectureFindingsHaveUniqueIds(findings)) {
    state.issues.push(pipelineIssue(
      "architecture_finding_identity_duplicate",
      "comparisons.findings",
      "Architecture finding IDs must be globally unique across extractor comparisons."
    ));
  }
  if (state.issues.length > 0) {
    return { ok: false, status: "invalid", issues: state.issues, missingTools: [] };
  }
  if (state.missingTools.length > 0) {
    return { ok: false, status: "tool-missing", issues: [], missingTools: state.missingTools };
  }
  return {
    ok: true,
    status: "ok",
    observations: state.observations,
    comparisons: state.comparisons,
    tools: state.tools
  };
}

export function registeredArchitectureAdapterIds() {
  return [
    ...[...providerRegistry.keys()].map((id) => `provider:${id}`),
    ...[...adapterRegistry.keys()].map((id) => `extractor:${id}`)
  ].sort(compareArchitectureText);
}

async function runProviderStage(options, registry, state) {
  const providerId = options.manifest.provider.id;
  const providerRunner = registry?.providers?.get(providerId);
  if (typeof providerRunner !== "function") {
    state.issues.push(pipelineIssue("architecture_provider_adapter_unknown", "provider.id", `No fixed architecture provider adapter is registered for ${providerId}.`));
    return;
  }
  const result = await providerRunner(options);
  if (recordNonSuccessResult(result, {
    role: "provider",
    declarationId: providerId,
    adapter: likeC4ProviderAdapterId
  }, state)) return;
  if (!hasExactKeys(result, ["status", "tool", "observation"]) ||
    !validAdapterTool(result.tool, "provider") ||
    result.tool.declarationId !== providerId ||
    result.tool.adapter !== likeC4ProviderAdapterId) {
    state.issues.push(pipelineIssue("architecture_provider_result_invalid", "provider", "The fixed provider adapter returned an invalid success result."));
    return;
  }
  const validation = validateArchitectureProviderObservation(result.observation);
  if (!validation.ok) {
    state.issues.push(...prefixedIssues(validation.issues, "provider.observation"));
    return;
  }
  if (!providerObservationMatches(result.observation, options)) {
    state.issues.push(pipelineIssue("architecture_provider_observation_mismatch", "provider.observation", "Provider observation identity, model digest, or extractor references do not match the manifest."));
    return;
  }
  state.providerObservation = result.observation;
  state.tools.push(result.tool);
}

async function runExtractorStage(options, registry, state, extractor) {
  const entry = registry?.extractors?.get(extractor.adapter);
  if (!validExtractorEntry(entry)) {
    state.issues.push(pipelineIssue("architecture_extractor_adapter_unknown", `extractors.${extractor.id}.adapter`, `No fixed architecture adapter and comparator are registered for ${extractor.adapter}.`));
    return;
  }
  const result = await entry.run({ ...options, extractor, providerObservation: state.providerObservation });
  if (recordNonSuccessResult(result, {
    role: "extractor",
    declarationId: extractor.id,
    adapter: extractor.adapter
  }, state)) return;
  if (!hasExactKeys(result, ["status", "observation"])) {
    state.issues.push(pipelineIssue("architecture_extractor_result_invalid", `extractors.${extractor.id}`, "The fixed extractor adapter returned an invalid success result."));
    return;
  }
  const validation = validateArchitectureCodeObservation(result.observation);
  if (!validation.ok || !codeObservationMatches(result.observation, extractor, state.providerObservation)) {
    state.issues.push(...(validation.ok
      ? [pipelineIssue("architecture_code_observation_mismatch", `extractors.${extractor.id}`, "Code observation identity does not match its manifest extractor declaration.")]
      : prefixedIssues(validation.issues, `extractors.${extractor.id}.observation`)));
    return;
  }
  state.observations.push(result.observation);
  if (state.providerObservation === null) return;
  const comparison = await entry.compare({
    manifest: options.manifest,
    providerObservation: state.providerObservation,
    codeObservation: result.observation
  });
  const comparisonValidation = validateArchitectureComparisonResult(comparison);
  if (!comparisonValidation.ok || !comparisonMatches(
    comparison,
    extractor,
    result.observation.extractor.toolRef,
    state.providerObservation,
    result.observation
  )) {
    state.issues.push(...(comparisonValidation.ok
      ? [pipelineIssue("architecture_comparison_mismatch", `extractors.${extractor.id}.comparison`, "Comparator findings must bind to current provider intent, extractor provenance, and code evidence.")]
      : prefixedIssues(comparisonValidation.issues, `extractors.${extractor.id}.comparison`)));
    return;
  }
  state.comparisons.push(comparison);
}

function recordNonSuccessResult(result, expectedIdentity, state) {
  if (result?.status === "tool-missing") {
    if (hasExactKeys(result, ["status", "tool"]) &&
      validArchitectureMissingTool(result.tool) &&
      result.tool.role === expectedIdentity.role &&
      result.tool.declarationId === expectedIdentity.declarationId &&
      result.tool.adapter === expectedIdentity.adapter) {
      state.missingTools.push(result.tool);
    } else {
      state.issues.push(pipelineIssue("architecture_adapter_missing_tool_invalid", expectedIdentity.role, "A fixed architecture adapter returned an invalid or unbound missing-tool result."));
    }
    return true;
  }
  if (result?.status === "invalid") {
    if (hasExactKeys(result, ["status", "issues"]) && Array.isArray(result.issues) && result.issues.length > 0 && result.issues.every(validArchitectureIssue)) {
      state.issues.push(...result.issues);
    } else {
      state.issues.push(pipelineIssue("architecture_adapter_invalid_result", expectedIdentity.role, "A fixed architecture adapter returned an invalid failure result."));
    }
    return true;
  }
  if (result?.status !== "ok") {
    state.issues.push(pipelineIssue("architecture_adapter_result_unknown", expectedIdentity.role, "A fixed architecture adapter returned an unknown status."));
    return true;
  }
  return false;
}

function providerObservationMatches(observation, options) {
  const extractorIds = new Set(options.manifest.extractors.map((entry) => entry.id));
  return observation.providerId === options.manifest.provider.id &&
    observation.modelDigest === options.configuration?.modelDigest &&
    observation.relationships.every((relationship) => relationship.extractorIds.every((id) => extractorIds.has(id)));
}

function codeObservationMatches(observation, extractor, providerObservation) {
  const providerNodeIds = new Set(providerObservation?.nodes ?? []);
  return observation.extractor.id === extractor.id &&
    observation.extractor.adapter === extractor.adapter &&
    sameSortedValues(observation.extractor.sourceScopeIds, extractor.sourceScopeIds) &&
    (providerObservation === null || observation.mappings.every((mapping) => providerNodeIds.has(mapping.nodeId)));
}

function comparisonMatches(comparison, extractor, toolRef, providerObservation, codeObservation) {
  const nodeIds = new Set(providerObservation.nodes);
  const relationships = new Map(providerObservation.relationships.map((entry) => [entry.id, entry]));
  const observedEvidence = architectureObservedEvidence(codeObservation);
  return comparison.findings.every((finding) => {
    const relationship = finding.relationshipId === null ? null : relationships.get(finding.relationshipId);
    return finding.extractorId === extractor.id &&
      finding.toolRef === toolRef &&
      (finding.sourceNodeId === null || nodeIds.has(finding.sourceNodeId)) &&
      (finding.targetNodeId === null || nodeIds.has(finding.targetNodeId)) &&
      (finding.relationshipId === null ||
        relationship?.extractorIds.includes(extractor.id) &&
        finding.sourceNodeId === relationship.sourceNodeId &&
        finding.targetNodeId === relationship.targetNodeId) &&
      finding.evidence.every((evidence) => evidence.line === null && observedEvidence.some((observed) =>
        evidence.sourcePath === observed.sourcePath &&
        evidence.targetPath === observed.targetPath &&
        finding.sourceNodeId === observed.sourceNodeId &&
        finding.targetNodeId === observed.targetNodeId));
  });
}

function architectureObservedEvidence(observation) {
  const mappedNodes = new Map(observation.mappings.map((mapping) => [mapping.path, mapping.nodeId]));
  return [
    ...observation.nodeEdges.flatMap((edge) => edge.evidence.map((evidence) => ({
      sourcePath: evidence.sourcePath,
      targetPath: evidence.targetPath,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId
    }))),
    ...observation.unmapped.flatMap((entry) => entry.evidence.map((evidence) => ({
      sourcePath: evidence.sourcePath,
      targetPath: evidence.targetPath,
      sourceNodeId: mappedNodes.get(evidence.sourcePath) ?? null,
      targetNodeId: mappedNodes.get(evidence.targetPath) ?? null
    })))
  ];
}

function validExtractorEntry(value) {
  return isArchitectureRecord(value) &&
    (hasExactKeys(value, ["run", "compare"]) || hasExactKeys(value, ["extract", "run", "compare"])) &&
    (value.extract === undefined || typeof value.extract === "function") &&
    typeof value.run === "function" &&
    typeof value.compare === "function";
}

function validAdapterTool(tool, expectedRole) {
  return tool?.role === expectedRole && validArchitectureProvenance({
    commit: { sha: null, verification: "unverified" },
    sourceDigest: contractDigest,
    modelDigest: contractDigest,
    tools: [tool]
  });
}

function pipelineState() {
  return {
    observations: [],
    comparisons: [],
    tools: [],
    missingTools: [],
    issues: [],
    providerObservation: null
  };
}

function sortedExtractors(extractors) {
  return [...extractors].sort((left, right) => compareArchitectureText(left.id, right.id));
}

function sameSortedValues(left, right) {
  const sortedLeft = [...left].sort(compareArchitectureText);
  const sortedRight = [...right].sort(compareArchitectureText);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

function prefixedIssues(issues, prefix) {
  return issues.map((entry) => ({ ...entry, path: `${prefix}.${entry.path}` }));
}

function pipelineIssue(code, path, message) {
  return { code, path, message };
}

function hasExactKeys(value, keys) {
  if (!isArchitectureRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

async function runMissingLikeC4ProviderAdapter({ manifest }) {
  return {
    status: "tool-missing",
    tool: {
      role: "provider",
      declarationId: manifest.provider.id,
      adapter: likeC4ProviderAdapterId,
      tool: "likec4",
      version: null,
      reason: "fixed-adapter-capability-unavailable",
      hint: "The fixed LikeC4 provider adapter capability is not connected in this release; no local setup action can enable it."
    }
  };
}

async function runMissingJavaScriptTypeScriptAdapter({ extractor }) {
  return {
    status: "tool-missing",
    tool: {
      role: "extractor",
      declarationId: extractor.id,
      adapter: extractor.adapter,
      tool: jsTsExtractorBoundary.tool,
      version: null,
      reason: "fixed-adapter-capability-unavailable",
      hint: "The fixed JavaScript/TypeScript extractor adapter capability is not connected in this release; no local setup action can enable it."
    }
  };
}

async function compareMissingJavaScriptTypeScriptAdapter() {
  return { schema: "architecture-comparison/v1", findings: [], warnings: [] };
}
