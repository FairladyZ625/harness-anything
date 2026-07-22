import { Schema } from "effect";

const OptionalString = Schema.optional(Schema.String);
const StringArray = Schema.Array(Schema.String);
const LocaleSchema = Schema.Literal("zh-CN", "en-US");
const ConfigIdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9/_@.-]*$/u));

export const HarnessConfigSchema = Schema.Struct({
  schema: Schema.Literal("harness/v2"),
  project: Schema.Struct({
    id: Schema.String,
    locale: LocaleSchema
  }),
  lifecycle: Schema.Struct({
    default: Schema.String,
    enabled: StringArray,
    engines: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        kind: Schema.String,
        workspace: OptionalString,
        project: OptionalString
      })
    })
  }),
  vertical: Schema.Struct({
    default: Schema.String
  }),
  presets: Schema.Struct({
    default: Schema.String
  }),
  settings: Schema.optional(Schema.Struct({
    locale: Schema.optional(LocaleSchema),
    defaultVertical: Schema.optional(ConfigIdentifierSchema),
    defaultPreset: Schema.optional(ConfigIdentifierSchema),
    defaultProfile: Schema.optional(ConfigIdentifierSchema),
    identity: Schema.optional(Schema.Struct({
      mode: Schema.optional(Schema.Literal("local", "remote")),
      personId: Schema.optional(ConfigIdentifierSchema),
      displayName: Schema.optional(Schema.String)
    })),
    tasks: Schema.optional(Schema.Struct({
      leaseEnforcement: Schema.optional(Schema.Boolean),
      leaseTtlMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)))
    })),
    execution: Schema.optional(Schema.Struct({
      consentTtlMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)))
    })),
    adapters: Schema.optional(Schema.Struct({
      multica: Schema.optional(Schema.Struct({
        staleTtlMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)))
      }))
    })),
    customVerticals: Schema.optional(Schema.Struct({
      enabled: Schema.Boolean
    }))
  })),
  storage: Schema.Struct({
    markdownRoot: Schema.String,
    sqlitePath: Schema.String,
    journalPath: Schema.String
  })
});
