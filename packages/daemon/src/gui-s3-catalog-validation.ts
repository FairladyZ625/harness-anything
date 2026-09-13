import { closed, digest, errorShape, profileRows, record, stringArray } from "./gui-s3-control.ts";

export function validateCatalogSnapshot(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      status: "string",
      repoId: "string",
      observedAt: "string",
      catalogDigest: "string",
      defaults: "object",
      presets: "array",
      verticals: "array",
      templates: "array",
      scaffolds: "object",
      settingsFields: "array",
      adapters: "array",
    },
    "catalog snapshot",
  );
  if (!record(value)) return errors;
  if (
    value.schema !== "gui-catalog-snapshot/v1" ||
    !["ready", "pending"].includes(String(value.status)) ||
    !digest(value.catalogDigest)
  )
    errors.push("catalog snapshot identity is invalid");
  for (const field of Array.isArray(value.settingsFields) ? value.settingsFields : []) {
    if (!record(field)) continue;
    errors.push(
      ...closed(
        field,
        { field: "string", type: "string", required: "boolean", enum: "optional-array" },
        "catalog settings field",
      ),
    );
  }
  if (record(value.defaults))
    errors.push(
      ...closed(
        value.defaults,
        { verticalId: "string", presetId: "string", profileId: "null-string", locale: "string" },
        "catalog defaults",
      ),
    );
  for (const row of Array.isArray(value.presets) ? value.presets : []) {
    errors.push(
      ...closed(
        row,
        {
          id: "string",
          title: "string",
          description: "string",
          verticalId: "string",
          sourceKind: "string",
          validity: "string",
          version: "null-string",
          kind: "null-string",
          defaultProfile: "null-string",
          profiles: "array",
          entrypoints: "array",
          issues: "array",
          shadows: "nullable-object",
        },
        "catalog preset",
      ),
    );
    if (
      record(row) &&
      (!["bundled", "user", "user-shadow"].includes(String(row.sourceKind)) ||
        !["valid", "unavailable", "blocked"].includes(String(row.validity)) ||
        !stringArray(row.entrypoints))
    )
      errors.push("catalog preset enum is invalid");
    if (record(row) && !profileRows(row.profiles)) errors.push("catalog preset profiles are invalid");
    if (record(row) && record(row.shadows)) {
      errors.push(...closed(row.shadows, { layer: "string", title: "string" }, "catalog preset shadows"));
      if (row.shadows.layer !== "bundled") errors.push("catalog preset shadow layer is invalid");
    }
  }
  for (const row of Array.isArray(value.verticals) ? value.verticals : []) {
    errors.push(
      ...closed(
        row,
        {
          id: "string",
          title: "string",
          version: "string",
          source: "string",
          available: "boolean",
          valid: "boolean",
          issues: "array",
        },
        "catalog vertical",
      ),
    );
    if (record(row) && row.source !== "builtin") errors.push("catalog vertical source is invalid");
  }
  for (const row of Array.isArray(value.templates) ? value.templates : []) {
    errors.push(
      ...closed(
        row,
        { templateRef: "string", slot: "string", materializeAs: "string", locales: "array" },
        "catalog template",
      ),
    );
    if (record(row) && !stringArray(row.locales)) errors.push("catalog template locales are invalid");
  }
  if (record(value.scaffolds)) {
    errors.push(...closed(value.scaffolds, { task: "array", repository: "array" }, "catalog scaffolds"));
    if (!stringArray(value.scaffolds.task) || !stringArray(value.scaffolds.repository))
      errors.push("catalog scaffold paths are invalid");
  }
  for (const row of Array.isArray(value.adapters) ? value.adapters : []) {
    errors.push(
      ...closed(
        row,
        {
          adapterId: "string",
          registered: "boolean",
          capabilities: "array",
          writability: "string",
          defaultProvider: "boolean",
          unavailableReason: "null-string",
        },
        "catalog adapter",
      ),
    );
    if (
      record(row) &&
      (row.registered !== true ||
        !stringArray(row.capabilities) ||
        !["read-only", "read-write", "unknown"].includes(String(row.writability)))
    )
      errors.push("catalog adapter state is invalid");
  }
  return errors;
}
export function validateCatalogPreset(value: unknown): readonly string[] {
  const errors = closed(
    value,
    { schema: "string", ok: "boolean", repoId: "string", preset: "object", resolved: "object" },
    "catalog preset detail",
  );
  if (!record(value)) return errors;
  if (value.schema !== "gui-catalog-preset/v1") errors.push("catalog preset detail schema is invalid");
  if (record(value.preset))
    errors.push(
      ...closed(
        value.preset,
        {
          id: "string",
          verticalId: "string",
          version: "null-string",
          extends: "null-string",
          capabilityImports: "array",
        },
        "catalog preset manifest",
      ),
    );
  if (record(value.resolved)) {
    errors.push(
      ...closed(
        value.resolved,
        {
          profile: "object",
          templates: "array",
          documents: "array",
          entrypoints: "array",
          provenance: "object",
          digest: "string",
        },
        "catalog preset resolved",
      ),
    );
    // 包内文档正文(路线 A):逐行闭形状,body 是 GUI 详情页渲染的唯一正文来源。
    for (const row of Array.isArray(value.resolved.documents) ? value.resolved.documents : [])
      errors.push(
        ...closed(
          row,
          {
            slot: "string",
            path: "string",
            body: "string",
            mediaType: "string",
            owner: "string",
            templateRef: "string",
          },
          "catalog preset document",
        ),
      );
  }
  return errors;
}
export function validateCatalogRereadReceipt(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      outcome: "string",
      operationId: "string",
      repoId: "string",
      beforeDigest: "string",
      afterDigest: "string",
      observedAt: "string",
      error: "nullable-object",
    },
    "catalog reread receipt",
  );
  if (!record(value)) return errors;
  errors.push(...errorShape(value.error, "catalog reread error"));
  if (
    value.schema !== "catalog-reread-receipt/v1" ||
    !["applied", "op_rejected"].includes(String(value.outcome)) ||
    !digest(value.beforeDigest) ||
    !digest(value.afterDigest)
  )
    errors.push("catalog reread receipt identity is invalid");
  return errors;
}
