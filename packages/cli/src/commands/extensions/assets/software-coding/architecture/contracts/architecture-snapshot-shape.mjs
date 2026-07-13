const allowedFields = {
  snapshot: ["schema", "modelContract", "manifest", "provenance", "extractors", "mappings", "nodeEdges", "unmapped", "stats"],
  manifest: ["path", "digest"],
  provenance: ["commit", "sourceDigest", "modelDigest", "tools"],
  commit: ["sha", "verification"],
  tool: ["role", "declarationId", "adapter", "tool", "version"],
  extractor: ["id", "adapter", "sourceScopeIds", "inputDigest", "toolRef"],
  mapping: ["extractorId", "path", "sourceScopeId", "nodeId"],
  edge: ["extractorId", "kind", "sourceNodeId", "targetNodeId", "evidence"],
  evidence: ["mechanism", "sourcePath", "targetPath", "specifier"],
  unmapped: ["extractorId", "path", "role", "reason", "evidence"],
  stats: ["sourceFiles", "mappedFiles", "nodeEdges", "evidenceEdges", "unmappedPaths"]
};

export function architectureSnapshotExtraFieldIssues(value) {
  const issues = [];
  addExtraFields(value, allowedFields.snapshot, "$", issues);
  addExtraFields(value?.manifest, allowedFields.manifest, "manifest", issues);
  addExtraFields(value?.provenance, allowedFields.provenance, "provenance", issues);
  addExtraFields(value?.provenance?.commit, allowedFields.commit, "provenance.commit", issues);
  addRecords(value?.provenance?.tools, allowedFields.tool, "provenance.tools", issues);
  addRecords(value?.extractors, allowedFields.extractor, "extractors", issues);
  addRecords(value?.mappings, allowedFields.mapping, "mappings", issues);
  addEvidenceRecords(value?.nodeEdges, allowedFields.edge, "nodeEdges", issues);
  addEvidenceRecords(value?.unmapped, allowedFields.unmapped, "unmapped", issues);
  addExtraFields(value?.stats, allowedFields.stats, "stats", issues);
  return issues;
}

function addEvidenceRecords(records, allowed, path, issues) {
  addRecords(records, allowed, path, issues);
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    addRecords(record?.evidence, allowedFields.evidence, `${path}[${index}].evidence`, issues);
  }
}

function addRecords(records, allowed, path, issues) {
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    addExtraFields(record, allowed, `${path}[${index}]`, issues);
  }
}

function addExtraFields(value, allowed, path, issues) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({
      code: "architecture_snapshot_extra_field",
      path: `${path}.${key}`,
      message: `${path} does not allow the extra field ${key}.`
    });
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
