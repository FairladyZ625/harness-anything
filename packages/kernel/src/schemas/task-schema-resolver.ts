/** @slice-activation Vertical field extension v1 exposes vertical-aware task schema resolution for write-path validation. */
import { Schema } from "effect";
import { TaskFrontmatterSchema, type VerticalDefinition } from "./registry.ts";

export function resolveTaskSchema(vertical: VerticalDefinition): Schema.Schema<any, any, never> {
  let schema: Schema.Schema<any, any, never> = TaskFrontmatterSchema;
  for (const extension of vertical.entityFieldExtensions ?? []) {
    if (extension.extends !== "task") {
      throw new Error(`Unsupported task field extension target: ${extension.extends}`);
    }
    if (extension.kind !== "enum-facet") {
      throw new Error(`Unsupported task field extension kind: ${extension.kind}`);
    }
    const values = nonEmptyStringValues(extension.values, extension.field);
    schema = schema.pipe(Schema.extend(Schema.Struct({
      [extension.field]: Schema.optional(Schema.Literal(...values))
    })));
  }
  return schema;
}

function nonEmptyStringValues(values: ReadonlyArray<string>, field: string): readonly [string, ...string[]] {
  if (values.length === 0) {
    throw new Error(`Task field extension ${field} must declare at least one enum value.`);
  }
  return values as readonly [string, ...string[]];
}
