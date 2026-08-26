import { Schema } from "effect";
import { UtcTimestampSchema } from "./utc-timestamp.ts";

const SessionIdSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));

export const SessionBodyRefSchema = Schema.Struct({
  store: Schema.Literal("authored-cas/v1"),
  ref: Schema.String,
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  size: Schema.Int.pipe(Schema.nonNegative()),
  mediaType: Schema.String,
});

export const SessionManifestSchema = Schema.Struct({
  schema: Schema.Literal("session-entity/v1"),
  sessionId: SessionIdSchema,
  lifecycle: Schema.Literal("active", "sealed", "partial", "unavailable", "archived"),
  archiveStatus: Schema.Literal("complete", "partial", "unavailable"),
  runtime: Schema.Literal("human", "claude-code", "codex", "zcode", "antigravity"),
  source: Schema.Literal("runtime", "manual"),
  detectedAt: UtcTimestampSchema,
  exportedAt: UtcTimestampSchema,
  user: Schema.optional(Schema.String),
  bodyRef: SessionBodyRefSchema,
  snapshot: Schema.Struct({
    capturedAt: UtcTimestampSchema,
    completeness: Schema.Literal("complete", "partial"),
    captureRange: Schema.Struct({
      messageCount: Schema.Int.pipe(Schema.nonNegative()),
      firstMessageAt: Schema.optional(UtcTimestampSchema),
      lastMessageAt: Schema.optional(UtcTimestampSchema),
    }),
    privacyScan: Schema.Struct({
      scannerVersion: Schema.String,
      passed: Schema.Boolean,
      findings: Schema.Array(
        Schema.Struct({
          ruleId: Schema.String,
          severity: Schema.Literal("info", "warning", "error"),
          message: Schema.String,
          path: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});

export type SessionBodyRef = typeof SessionBodyRefSchema.Type;
export type SessionManifest = typeof SessionManifestSchema.Type;
export type SessionFieldKey = keyof SessionManifest;
