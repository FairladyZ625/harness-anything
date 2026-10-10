import { Schema } from "effect";
import Ajv from "ajv";
import { gateAppliesTo } from "../domain/completion-source.ts";
import type { VerticalCompletionDeclaration } from "../domain/completion-source.ts";

const Text = Schema.String.pipe(Schema.minLength(1));
const schemaAdmission = new Ajv({ allErrors: true, strictKeywords: true, jsonPointers: true });
const predicate = {
  predicateType: Text,
  resultSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
    Schema.filter((value) => {
      try {
        const compiled = schemaAdmission.compile(value);
        return compiled.$async !== true || "Completion predicate schemas must be synchronous draft-07 schemas";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }),
  ),
};
export const WitnessSourceSchema = Schema.Union(
  Schema.Struct({ ...predicate, kind: Schema.Literal("github-actions") }),
  Schema.Struct({ ...predicate, kind: Schema.Literal("command"), entrypoint: Text }),
  Schema.Struct({
    ...predicate,
    kind: Schema.Literal("external"),
    runnerRole: Text,
    outputBindings: Schema.optional(Schema.Record({ key: Text, value: Schema.Literal("run-artifact") })),
  }),
  Schema.Struct({ ...predicate, kind: Schema.Literal("manual") }),
);

export const VerticalCompletionDeclarationSchema = Schema.Struct({
  sources: Schema.Record({ key: Text, value: WitnessSourceSchema }),
  gates: Schema.Record({
    key: Text,
    value: Schema.Struct({
      source: Text,
      appliesTo: Schema.Literal(...gateAppliesTo),
      subjects: Schema.optional(Schema.Union(Schema.Literal("all-artifacts"), Schema.Array(Text))),
      bindings: Schema.optional(
        Schema.Record({
          key: Text,
          value: Schema.Struct({ artifact: Text, pointer: Schema.String }),
        }),
      ),
      mandatorySignoff: Schema.optional(Schema.Boolean),
      allowOverride: Schema.optional(Schema.Boolean),
      independentNode: Schema.optional(Schema.Boolean),
    }),
  }),
  closeoutDefaults: Schema.Struct({
    review: Schema.optional(Schema.Boolean),
    consent: Schema.optional(Schema.Boolean),
    factDisposition: Schema.optional(Schema.Boolean),
    codeDoc: Schema.optional(Schema.Boolean),
  }),
});

type Decoded = Schema.Schema.Type<typeof VerticalCompletionDeclarationSchema>;
true satisfies [Decoded] extends [VerticalCompletionDeclaration]
  ? [VerticalCompletionDeclaration] extends [Decoded]
    ? true
    : never
  : never;
