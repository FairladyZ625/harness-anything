const architectureManifestContractId = "architecture-manifest/v1";
const stableIdPattern = "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$";
const stableIdSchema = {
  type: "string",
  pattern: stableIdPattern
};
const likeC4IdentifierSchema = {
  type: "string",
  pattern: "^[A-Za-z_][A-Za-z0-9_-]*$"
};
const relativePosixSelectorSchema = {
  type: "string",
  pattern: "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*//).+$"
};
const portablePhysicalPathSchema = {
  ...relativePosixSelectorSchema,
  format: "portable-relative-path"
};
const sourceGlobSchema = {
  ...relativePosixSelectorSchema,
  format: "repository-source-glob",
  allOf: [{ pattern: "^(?!!).+$" }]
};
const likeC4SourcePathSchema = {
  ...portablePhysicalPathSchema,
  allOf: [{ pattern: "\\.c4$" }]
};

export const ArchitectureModelContract = deepFreeze({
  id: "architecture-model/v1",
  providerId: "likec4",
  identity: {
    metadataKey: "archId",
    pattern: stableIdPattern,
    elementUniqueness: "model-global",
    relationshipUniqueness: "model-global"
  },
  metadataFields: {
    archId: stableIdSchema,
    status: {
      type: "string",
      enum: ["draft", "verified"]
    },
    placeholder: {
      type: "boolean"
    },
    owner: {
      type: "string",
      minLength: 1
    },
    responsibilities: nonEmptyUniqueStringArraySchema(),
    nonResponsibilities: nonEmptyUniqueStringArraySchema(),
    expectation: {
      type: "string",
      enum: ["allowed", "required", "forbidden"]
    },
    extractorIds: {
      ...nonEmptyUniqueStringArraySchema(stableIdSchema),
      references: `${architectureManifestContractId}#extractors[].id`
    },
    adrRefs: nonEmptyUniqueStringArraySchema({
      type: "string",
      minLength: 1,
      format: "portable-repository-relative-path"
    }),
    decisionRefs: nonEmptyUniqueStringArraySchema({
      type: "string",
      minLength: 1,
      pattern: "^decision/[A-Za-z0-9][A-Za-z0-9._-]*$"
    })
  },
  lifecycle: {
    statusMetadataKey: "status",
    placeholderMetadataKey: "placeholder",
    placeholderInvalidValue: true
  },
  elements: {
    requiredMetadataKeys: [
      "archId",
      "status",
      "owner",
      "responsibilities",
      "nonResponsibilities"
    ],
    arrayMetadataKeys: ["responsibilities", "nonResponsibilities"]
  },
  relationships: {
    requiredMetadataKeys: ["archId", "status", "expectation"],
    expectationMetadataKey: "expectation",
    extractorIdsMetadataKey: "extractorIds",
    extractorParticipation: "explicit-only",
    extractorScopedEndpointsRequired: true
  },
  evidence: {
    adrRefsMetadataKey: "adrRefs",
    decisionRefsMetadataKey: "decisionRefs",
    verifiedRule: {
      when: {
        metadataKey: "status",
        equals: "verified"
      },
      requireAny: [
        { metadataKey: "adrRefs", minItems: 1 },
        { metadataKey: "decisionRefs", minItems: 1 }
      ]
    }
  },
  sourcePaths: {
    authority: architectureManifestContractId,
    modelMetadataAllowed: false
  },
  views: {
    requiredIds: ["landscape", "write-path", "runtime"]
  }
});

export const ArchitectureManifestSchema = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://harness-anything.dev/schemas/software-coding/architecture-manifest.schema.json",
  title: "Software Coding Architecture Manifest",
  description: "Opt-in routing contract for a repository-owned architecture model.",
  type: "object",
  required: [
    "schema",
    "enabled",
    "modelContract",
    "provider",
    "modelRoot",
    "views",
    "sourceScopes",
    "extractors"
  ],
  properties: {
    schema: { type: "string", const: architectureManifestContractId },
    enabled: { type: "boolean", const: true },
    modelContract: { type: "string", const: ArchitectureModelContract.id },
    provider: {
      type: "object",
      required: ["id", "config"],
      properties: {
        id: { type: "string", const: ArchitectureModelContract.providerId },
        config: portablePhysicalPathSchema
      },
      additionalProperties: false
    },
    modelRoot: portablePhysicalPathSchema,
    views: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "providerView", "path"],
        properties: {
          id: stableIdSchema,
          providerView: likeC4IdentifierSchema,
          path: likeC4SourcePathSchema
        },
        additionalProperties: false
      }
    },
    sourceScopes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "nodeId", "include", "exclude"],
        properties: {
          id: stableIdSchema,
          nodeId: stableIdSchema,
          include: { type: "array", minItems: 1, items: sourceGlobSchema },
          exclude: { type: "array", items: sourceGlobSchema }
        },
        additionalProperties: false
      }
    },
    extractors: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "adapter", "sourceScopeIds"],
        properties: {
          id: stableIdSchema,
          adapter: { type: "string", const: "javascript-typescript/imports-v1" },
          sourceScopeIds: { type: "array", minItems: 1, items: stableIdSchema }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false,
  "x-harness-schema-id": architectureManifestContractId,
  "x-harness-generated-from": "architecture-manifest.mjs#ArchitectureManifestSchema",
  "x-harness-semantic-validator": "validateArchitectureManifest"
});

export function validateArchitectureManifest(input) {
  const structuralIssues = validateAgainstSchema(input, ArchitectureManifestSchema, "$", ArchitectureManifestSchema);
  if (structuralIssues.length > 0) {
    return {
      ok: false,
      issues: [{
        code: "architecture_manifest_invalid",
        path: structuralIssues[0].path,
        message: structuralIssues[0].message
      }]
    };
  }

  const value = input;
  const issues = [
    ...duplicateIssues(value.views, "id", "duplicate_architecture_view_id", "views"),
    ...duplicateIssues(value.views, "providerView", "duplicate_architecture_provider_view", "views"),
    ...duplicateIssues(value.views, "path", "duplicate_architecture_view_path", "views", portablePathKey),
    ...duplicateIssues(value.sourceScopes, "id", "duplicate_architecture_source_scope_id", "sourceScopes"),
    ...duplicateIssues(value.extractors, "id", "duplicate_architecture_extractor_id", "extractors")
  ];
  const viewIds = new Set(value.views.map((view) => view.id));
  for (const requiredView of ArchitectureModelContract.views.requiredIds) {
    if (!viewIds.has(requiredView)) {
      issues.push({
        code: "missing_architecture_view",
        path: "views",
        message: `Required architecture view ${requiredView} is missing.`
      });
    }
  }

  const configPathKey = portablePathKey(value.provider.config);
  for (const [viewIndex, view] of value.views.entries()) {
    if (portablePathKey(view.path) === configPathKey) {
      issues.push({
        code: "architecture_model_path_collision",
        path: `views[${viewIndex}].path`,
        message: `Provider config and architecture view ${view.id} resolve to the same portable model path.`
      });
    }
  }

  const sourceScopeIds = new Set(value.sourceScopes.map((scope) => scope.id));
  for (const [extractorIndex, extractor] of value.extractors.entries()) {
    const seenRefs = new Set();
    for (const [referenceIndex, sourceScopeId] of extractor.sourceScopeIds.entries()) {
      if (seenRefs.has(sourceScopeId)) {
        issues.push({
          code: "duplicate_architecture_source_scope_ref",
          path: `extractors[${extractorIndex}].sourceScopeIds[${referenceIndex}]`,
          message: `Extractor ${extractor.id} repeats source scope ${sourceScopeId}.`
        });
      }
      seenRefs.add(sourceScopeId);
      if (!sourceScopeIds.has(sourceScopeId)) {
        issues.push({
          code: "unknown_architecture_source_scope",
          path: `extractors[${extractorIndex}].sourceScopeIds[${referenceIndex}]`,
          message: `Extractor ${extractor.id} references unknown source scope ${sourceScopeId}.`
        });
      }
    }
  }

  return issues.length === 0
    ? { ok: true, value, issues: [] }
    : { ok: false, issues };
}

export function architectureManifestJsonSchema() {
  return structuredClone(ArchitectureManifestSchema);
}

export function architectureModelContract() {
  return structuredClone(ArchitectureModelContract);
}

function validateAgainstSchema(value, schema, path, rootSchema) {
  const issues = [];
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    issues.push({ path, message: `Expected the literal ${JSON.stringify(schema.const)}.` });
  }
  if (schema.type !== undefined && !hasJsonType(value, schema.type)) {
    issues.push({ path, message: `Expected ${schema.type}.` });
    return issues;
  }
  if (typeof value === "string" && schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    issues.push({ path, message: `Value does not match ${schema.pattern}.` });
  }
  if (typeof value === "string" && schema.format !== undefined) {
    const formatIssue = stringFormatIssue(value, schema.format);
    if (formatIssue !== undefined) issues.push({ path, message: formatIssue });
  }
  if (Array.isArray(value)) {
    issues.push(...validateArray(value, schema, path, rootSchema));
  } else if (isRecord(value)) {
    issues.push(...validateObject(value, schema, path, rootSchema));
  }
  for (const nestedSchema of schema.allOf ?? []) {
    issues.push(...validateAgainstSchema(value, nestedSchema, path, rootSchema));
  }
  return issues;
}

function validateArray(value, schema, path, rootSchema) {
  const issues = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    issues.push({ path, message: `Expected at least ${schema.minItems} item(s).` });
  }
  if (schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      issues.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`, rootSchema));
    }
  }
  return issues;
}

function validateObject(value, schema, path, rootSchema) {
  const issues = [];
  const properties = schema.properties ?? {};
  for (const requiredProperty of schema.required ?? []) {
    if (!Object.hasOwn(value, requiredProperty)) {
      issues.push({ path: `${path}.${requiredProperty}`, message: "Required property is missing." });
    }
  }
  for (const [key, propertyValue] of Object.entries(value)) {
    if (properties[key] !== undefined) {
      issues.push(...validateAgainstSchema(propertyValue, properties[key], `${path}.${key}`, rootSchema));
    } else if (schema.additionalProperties === false) {
      issues.push({ path: `${path}.${key}`, message: "Unknown property is not allowed." });
    }
  }
  return issues;
}

function hasJsonType(value, type) {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function duplicateIssues(records, key, code, path, canonicalize = (value) => value) {
  const seen = new Set();
  const issues = [];
  for (const [index, record] of records.entries()) {
    const value = record[key];
    const canonicalValue = canonicalize(value);
    if (seen.has(canonicalValue)) {
      issues.push({
        code,
        path: `${path}[${index}].${key}`,
        message: `${path}.${key} value ${value} must be unique.`
      });
    }
    seen.add(canonicalValue);
  }
  return issues;
}

function stringFormatIssue(value, format) {
  if (format === "portable-relative-path") return portablePhysicalPathIssue(value);
  if (format === "repository-source-glob") return repositorySourceGlobIssue(value);
  return undefined;
}

function portablePhysicalPathIssue(value) {
  const relativeIssue = relativePosixSelectorIssue(value);
  if (relativeIssue !== undefined) return relativeIssue;
  for (const segment of value.split("/")) {
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      return "Path segments must not end with a space or dot.";
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
      return "Windows-reserved path segments are not allowed.";
    }
    if (/[<>:"|?*]/u.test(segment)) {
      return "Physical paths must not contain Windows-forbidden characters or glob metacharacters.";
    }
  }
  return undefined;
}

function repositorySourceGlobIssue(value) {
  const relativeIssue = relativePosixSelectorIssue(value);
  if (relativeIssue !== undefined) return relativeIssue;
  if (value.startsWith("!")) return "Leading glob negation is not allowed.";
  return undefined;
}

function relativePosixSelectorIssue(value) {
  if (value.length === 0) return "Relative paths must not be empty.";
  if (value.includes("\0")) return "Relative paths must not contain NUL.";
  if (value.includes("\\")) return "Relative paths must use POSIX separators.";
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.startsWith("//")) {
    return "Absolute paths are not allowed.";
  }
  if (value !== value.normalize("NFC")) return "Relative paths must be NFC-normalized.";
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return "Relative paths must be normalized and stay inside the repository.";
  }
  return undefined;
}

function portablePathKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function nonEmptyUniqueStringArraySchema(items = { type: "string", minLength: 1 }) {
  return {
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items
  };
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const nestedValue of Object.values(value)) {
    if (nestedValue !== null && typeof nestedValue === "object" && !Object.isFrozen(nestedValue)) {
      deepFreeze(nestedValue);
    }
  }
  return value;
}
