import { isArchitectureStableId } from "./architecture-manifest.mjs";
import { compareArchitectureText, portablePathKey } from "./architecture-portable-path.mjs";
import {
  isArchitectureDigest,
  isArchitectureRecord,
  validArchitectureDriftFinding,
  validArchitectureWarning
} from "./architecture-report-contracts.mjs";
import {
  architectureSourceDigest,
  buildArchitectureSnapshot,
  validateArchitectureSnapshot
} from "./architecture-runtime.mjs";

const providerObservationKeys = ["schema", "providerId", "modelDigest", "nodes", "relationships"];
const providerRelationshipKeys = ["id", "sourceNodeId", "targetNodeId", "expectation", "extractorIds"];
const codeObservationKeys = ["schema", "extractor", "tool", "mappings", "nodeEdges", "unmapped", "stats"];
const codeObservationStatsKeys = ["sourceFiles"];
const comparisonResultKeys = ["schema", "findings", "warnings"];
const contractDigest = `sha256:${"0".repeat(64)}`;

export function validateArchitectureProviderObservation(value) {
  const issues = [];
  if (!hasExactKeys(value, providerObservationKeys)) {
    return invalid("$", "Provider observations must use the closed architecture-provider-observation/v1 shape.");
  }
  if (value.schema !== "architecture-provider-observation/v1") {
    issues.push(issue("schema", "Provider observation schema must be architecture-provider-observation/v1."));
  }
  if (!isArchitectureStableId(value.providerId)) {
    issues.push(issue("providerId", "Provider observations require a stable provider ID."));
  }
  if (!isArchitectureDigest(value.modelDigest)) {
    issues.push(issue("modelDigest", "Provider observations require a reproducible model digest."));
  }
  if (!sortedUniqueStableIds(value.nodes, true)) {
    issues.push(issue("nodes", "Provider node IDs must be a non-empty, sorted, unique list of stable IDs."));
  }
  if (!Array.isArray(value.relationships)) {
    issues.push(issue("relationships", "Provider relationships must be an array."));
  } else {
    const nodeIds = new Set(Array.isArray(value.nodes) ? value.nodes : []);
    const relationshipIds = [];
    for (const [index, relationship] of value.relationships.entries()) {
      if (!validProviderRelationship(relationship, nodeIds)) {
        issues.push(issue(`relationships[${index}]`, "Provider relationships require closed stable endpoints, expectations, and extractor IDs."));
      } else {
        relationshipIds.push(relationship.id);
      }
    }
    if (!sameValues(relationshipIds, sortedUnique(relationshipIds))) {
      issues.push(issue("relationships", "Provider relationships must be sorted by unique stable relationship ID."));
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

export function validateArchitectureCodeObservation(value) {
  if (!hasExactKeys(value, codeObservationKeys)) {
    return invalid("$", "Code observations must use the closed architecture-code-observation/v1 shape.");
  }
  const issues = [];
  if (value.schema !== "architecture-code-observation/v1") {
    issues.push(issue("schema", "Code observation schema must be architecture-code-observation/v1."));
  }
  if (!isArchitectureRecord(value.extractor) ||
    !isArchitectureRecord(value.tool) ||
    !Array.isArray(value.mappings) ||
    !Array.isArray(value.nodeEdges) ||
    !Array.isArray(value.unmapped) ||
    !hasExactKeys(value.stats, codeObservationStatsKeys) ||
    !Number.isInteger(value.stats.sourceFiles) ||
    value.stats.sourceFiles < 0) {
    issues.push(issue("$", "Code observations require one extractor tool, graph arrays, and a non-negative source file count."));
    return { ok: false, issues };
  }

  const snapshot = buildArchitectureSnapshot({
    manifest: { path: "architecture-manifest.json", digest: contractDigest },
    provenance: {
      commit: { sha: null, verification: "unverified" },
      sourceDigest: architectureSourceDigest([value.extractor]),
      modelDigest: contractDigest,
      tools: [contractProviderTool(), value.tool]
    },
    extractors: [value.extractor],
    mappings: value.mappings,
    nodeEdges: value.nodeEdges,
    unmapped: value.unmapped,
    stats: {
      sourceFiles: value.stats.sourceFiles,
      mappedFiles: mappedPhysicalPathCount(value.mappings),
      nodeEdges: value.nodeEdges.length,
      evidenceEdges: value.nodeEdges.reduce((total, edge) => total + (Array.isArray(edge?.evidence) ? edge.evidence.length : 0), 0),
      unmappedPaths: value.unmapped.length
    }
  });
  const validation = validateArchitectureSnapshot(snapshot);
  if (!validation.ok) {
    issues.push(...validation.issues.map((entry) => issue(entry.path, entry.message)));
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

export function validateArchitectureComparisonResult(value) {
  if (!hasExactKeys(value, comparisonResultKeys)) {
    return invalid("$", "Comparison results must use the closed architecture-comparison/v1 shape.");
  }
  const issues = [];
  if (value.schema !== "architecture-comparison/v1") {
    issues.push(issue("schema", "Comparison result schema must be architecture-comparison/v1."));
  }
  if (!Array.isArray(value.findings) || value.findings.some((entry) => !validArchitectureDriftFinding(entry))) {
    issues.push(issue("findings", "Comparison findings must satisfy architecture-drift-finding/v1."));
  } else if (new Set(value.findings.map((entry) => entry.id)).size !== value.findings.length) {
    issues.push(issue("findings", "Comparison finding IDs must be unique."));
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((entry) => !validArchitectureWarning(entry))) {
    issues.push(issue("warnings", "Comparison warnings must be non-empty strings."));
  } else if (new Set(value.warnings).size !== value.warnings.length) {
    issues.push(issue("warnings", "Comparison warnings must be unique."));
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function validProviderRelationship(value, nodeIds) {
  return hasExactKeys(value, providerRelationshipKeys) &&
    isArchitectureStableId(value.id) &&
    isArchitectureStableId(value.sourceNodeId) &&
    isArchitectureStableId(value.targetNodeId) &&
    nodeIds.has(value.sourceNodeId) &&
    nodeIds.has(value.targetNodeId) &&
    ["allowed", "required", "forbidden"].includes(value.expectation) &&
    sortedUniqueStableIds(value.extractorIds, false);
}

function contractProviderTool() {
  return {
    role: "provider",
    declarationId: "contract-provider",
    adapter: "architecture-provider/contract-v1",
    tool: "architecture-provider-contract",
    version: "1"
  };
}

function mappedPhysicalPathCount(mappings) {
  return new Set(mappings.flatMap((mapping) => typeof mapping?.path === "string" ? [portablePathKey(mapping.path)] : [])).size;
}

function sortedUniqueStableIds(value, requireNonEmpty) {
  return Array.isArray(value) &&
    (!requireNonEmpty || value.length > 0) &&
    value.every(isArchitectureStableId) &&
    sameValues(value, sortedUnique(value));
}

function sortedUnique(value) {
  return [...new Set(value)].sort(compareArchitectureText);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasExactKeys(value, keys) {
  if (!isArchitectureRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function issue(path, message) {
  return { code: "architecture_adapter_contract_invalid", path, message };
}

function invalid(path, message) {
  return { ok: false, issues: [issue(path, message)] };
}
