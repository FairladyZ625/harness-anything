import { Schema } from "effect";

export const ProjectionWarningSourceSchema = Schema.Literal("source-package", "generated-cache", "collaboration-gate");
export const ProjectionWarningCodeSchema = Schema.Literal(
  "projection_missing",
  "projection_stale",
  "projection_tampered",
  "source_malformed",
  "duplicate_task_id",
  "duplicate_external_binding",
  "generated_tracked",
  "binding_tampered",
  "conflict_marker_present",
  "decision_watermark_missing",
  "decision_watermark_duplicate",
  "dangling_entity_ref",
  "invalid_relation_endpoint",
  "relation_host_source_mismatch",
  "relation_provenance_inheritance_mismatch",
  "relation_id_mismatch",
  "duplicate_relation_id",
  "relation_rationale_missing",
  "relation_endpoint_unknown",
  "relation_cycle_detected"
);

const HarnessCheckAxisReportSchema = Schema.Struct({
  axis: ProjectionWarningSourceSchema,
  ok: Schema.Boolean,
  warningCount: Schema.Number,
  hardFailCount: Schema.Number,
  codes: Schema.Array(ProjectionWarningCodeSchema)
});

export const HarnessCheckReportSchema = Schema.Struct({
  schema: Schema.Literal("harness-check-report/v1"),
  ok: Schema.Boolean,
  axes: Schema.Tuple(HarnessCheckAxisReportSchema, HarnessCheckAxisReportSchema, HarnessCheckAxisReportSchema),
  summary: Schema.Struct({
    rowCount: Schema.Number,
    warningCount: Schema.Number,
    hardFailCount: Schema.Number
  })
});
