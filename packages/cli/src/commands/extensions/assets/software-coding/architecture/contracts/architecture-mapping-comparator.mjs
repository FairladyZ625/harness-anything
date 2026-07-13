import { createHash } from "node:crypto";
import { compareArchitectureText } from "./architecture-portable-path.mjs";

export function mapArchitectureCodeGraph({ graph, manifest, providerObservation }) {
  if (providerObservation === null || providerObservation === undefined) {
    return invalid("architecture_mapping_provider_required", "providerObservation", "Architecture node mapping requires the current provider observation.");
  }
  const providerNodeIds = new Set(providerObservation.nodes);
  const sourceScopes = new Map(manifest.sourceScopes.map((scope) => [scope.id, scope]));
  const selectedScopeIds = new Set(graph.extractor.sourceScopeIds);
  for (const sourceScopeId of selectedScopeIds) {
    const scope = sourceScopes.get(sourceScopeId);
    if (!scope) return invalid("architecture_mapping_scope_missing", `sourceScopes.${sourceScopeId}`, `Extractor scope ${sourceScopeId} is missing from the manifest.`);
    if (!providerNodeIds.has(scope.nodeId)) {
      return invalid("architecture_mapping_node_unknown", `sourceScopes.${sourceScopeId}.nodeId`, `Source scope ${sourceScopeId} references unknown architecture node ${scope.nodeId}.`);
    }
  }

  const mappings = graph.files.flatMap((file) => {
    if (file.sourceScopeId === null) return [];
    const scope = sourceScopes.get(file.sourceScopeId);
    if (!scope || !selectedScopeIds.has(file.sourceScopeId)) return [];
    return [{
      extractorId: graph.extractor.id,
      path: file.path,
      sourceScopeId: file.sourceScopeId,
      nodeId: scope.nodeId
    }];
  });
  const mappingByPath = new Map(mappings.map((mapping) => [mapping.path, mapping]));
  const edgeEvidence = new Map();
  const unmappedEvidence = new Map();
  for (const dependency of graph.dependencies) {
    const source = mappingByPath.get(dependency.sourcePath);
    const target = mappingByPath.get(dependency.targetPath);
    const evidence = {
      mechanism: "import",
      sourcePath: dependency.sourcePath,
      targetPath: dependency.targetPath,
      specifier: dependency.specifier
    };
    if (source && target) {
      if (source.nodeId === target.nodeId) continue;
      append(edgeEvidence, `${source.nodeId}\0${target.nodeId}`, evidence);
    } else if (source || target) {
      const role = source ? "target" : "source";
      const unmappedPath = source ? dependency.targetPath : dependency.sourcePath;
      append(unmappedEvidence, `${unmappedPath}\0${role}`, evidence);
    }
  }

  const nodeEdges = [...edgeEvidence.entries()].map(([identity, evidence]) => {
    const [sourceNodeId, targetNodeId] = identity.split("\0");
    return {
      extractorId: graph.extractor.id,
      kind: "dependency",
      sourceNodeId,
      targetNodeId,
      evidence: sortEvidence(evidence)
    };
  }).sort((left, right) => compareArchitectureText(edgeIdentity(left), edgeIdentity(right)));
  const unmapped = [...unmappedEvidence.entries()].map(([identity, evidence]) => {
    const [unmappedPath, role] = identity.split("\0");
    return {
      extractorId: graph.extractor.id,
      path: unmappedPath,
      role,
      reason: "no-architecture-source-scope",
      evidence: sortEvidence(evidence)
    };
  }).sort((left, right) => compareArchitectureText(`${left.path}\0${left.role}`, `${right.path}\0${right.role}`));

  return {
    status: "ok",
    observation: {
      schema: "architecture-code-observation/v1",
      extractor: graph.extractor,
      tool: graph.tool,
      mappings,
      nodeEdges,
      unmapped,
      stats: { sourceFiles: graph.stats.sourceFiles }
    }
  };
}

export function compareArchitectureObservation({ providerObservation, codeObservation }) {
  const extractorId = codeObservation.extractor.id;
  const toolRef = codeObservation.extractor.toolRef;
  const relationships = providerObservation.relationships.filter((entry) => entry.extractorIds.includes(extractorId));
  const relationshipByEdge = new Map(relationships.map((entry) => [relationshipEdge(entry), entry]));
  const actualByEdge = new Map(codeObservation.nodeEdges.map((entry) => [edgeIdentity(entry), entry]));
  const findings = [];

  for (const edge of codeObservation.nodeEdges) {
    const relationship = relationshipByEdge.get(edgeIdentity(edge));
    if (relationship?.expectation === "forbidden") {
      findings.push(actualFinding("forbidden-dependency", "error", extractorId, toolRef, relationship, edge, "Observed a dependency forbidden by the authored architecture model."));
      continue;
    }
    if (relationship) continue;
    const reverse = relationshipByEdge.get(`${edge.targetNodeId}\0${edge.sourceNodeId}`);
    if (reverse && reverse.expectation !== "forbidden") {
      findings.push(actualFinding("reverse-dependency", "error", extractorId, toolRef, reverse, edge, "Observed a dependency in the reverse direction of the authored architecture relationship."));
    } else {
      findings.push(actualFinding("unexpected-dependency", "warning", extractorId, toolRef, null, edge, "Observed a cross-node dependency with no extractor-scoped architecture relationship."));
    }
  }

  for (const relationship of relationships) {
    if (relationship.expectation === "required" && !actualByEdge.has(relationshipEdge(relationship))) {
      findings.push(makeFinding({
        kind: "missing-required-dependency",
        severity: "error",
        extractorId,
        relationshipId: relationship.id,
        sourceNodeId: relationship.sourceNodeId,
        targetNodeId: relationship.targetNodeId,
        toolRef,
        evidence: [],
        message: "The authored architecture requires a dependency that was not observed."
      }));
    }
  }

  const mappedNodes = new Map(codeObservation.mappings.map((mapping) => [mapping.path, mapping.nodeId]));
  for (const unmapped of codeObservation.unmapped) {
    for (const evidence of unmapped.evidence) {
      const sourceNodeId = unmapped.role === "source" ? null : mappedNodes.get(evidence.sourcePath) ?? null;
      const targetNodeId = unmapped.role === "target" ? null : mappedNodes.get(evidence.targetPath) ?? null;
      findings.push(makeFinding({
        kind: unmapped.role === "source" ? "unmapped-source" : "unmapped-target",
        severity: "warning",
        extractorId,
        relationshipId: null,
        sourceNodeId,
        targetNodeId,
        toolRef,
        evidence: findingEvidence([evidence]),
        message: `Observed a dependency whose ${unmapped.role} path has no explicit architecture source scope.`
      }));
    }
  }

  const adjacency = dependencyAdjacency(codeObservation.nodeEdges);
  for (const edge of codeObservation.nodeEdges) {
    if (!reaches(edge.targetNodeId, edge.sourceNodeId, adjacency, new Set(), false)) continue;
    findings.push(actualFinding("architecture-cycle", "error", extractorId, toolRef, null, edge, "Observed dependency participates in an architecture-node cycle."));
  }

  return {
    schema: "architecture-comparison/v1",
    findings: findings.sort((left, right) => compareArchitectureText(left.id, right.id)),
    warnings: []
  };
}

function actualFinding(kind, severity, extractorId, toolRef, relationship, edge, message) {
  return makeFinding({
    kind,
    severity,
    extractorId,
    relationshipId: relationship?.id ?? null,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    toolRef,
    evidence: findingEvidence(edge.evidence),
    message
  });
}

function makeFinding(input) {
  const identity = JSON.stringify({
    kind: input.kind,
    extractorId: input.extractorId,
    relationshipId: input.relationshipId,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    toolRef: input.toolRef,
    evidence: input.evidence
  });
  return {
    schema: "architecture-drift-finding/v1",
    id: `finding.${input.kind}.${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
    ...input
  };
}

function findingEvidence(evidence) {
  return evidence.map((entry) => ({ sourcePath: entry.sourcePath, targetPath: entry.targetPath, line: null }));
}

function dependencyAdjacency(edges) {
  const adjacency = new Map();
  for (const edge of edges) append(adjacency, edge.sourceNodeId, edge.targetNodeId);
  return adjacency;
}

function reaches(current, target, adjacency, visited, allowCurrentMatch) {
  if (allowCurrentMatch && current === target) return true;
  if (visited.has(current)) return false;
  visited.add(current);
  return (adjacency.get(current) ?? []).some((next) => reaches(next, target, adjacency, new Set(visited), true));
}

function append(map, key, value) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function relationshipEdge(value) {
  return `${value.sourceNodeId}\0${value.targetNodeId}`;
}

function edgeIdentity(value) {
  return `${value.sourceNodeId}\0${value.targetNodeId}`;
}

function sortEvidence(values) {
  return values.sort((left, right) => compareArchitectureText(
    `${left.sourcePath}\0${left.targetPath}\0${left.specifier}`,
    `${right.sourcePath}\0${right.targetPath}\0${right.specifier}`
  ));
}

function invalid(code, pathName, message) {
  return { status: "invalid", issues: [{ code, path: pathName, message }] };
}
