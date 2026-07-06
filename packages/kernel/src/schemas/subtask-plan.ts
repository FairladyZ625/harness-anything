import { Schema } from "effect";

const SubtaskPlanChildSchema = Schema.Struct({
  role: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.Literal("pending", "exists"),
  existingTaskId: Schema.optional(Schema.String),
  title: Schema.String,
  brief: Schema.Struct({
    objective: Schema.String,
    scope: Schema.String,
    acceptance: Schema.Array(Schema.String).pipe(Schema.minItems(1))
  }),
  createCommand: Schema.String
});

const SubtaskPlanDependencySchema = Schema.Struct({
  sourceRole: Schema.String,
  type: Schema.Literal("depends-on"),
  targetRole: Schema.String,
  rationale: Schema.String
});

export const SubtaskPlanSchema = Schema.Struct({
  schema: Schema.Literal("subtask-plan/v1"),
  parentTaskId: Schema.String,
  generatedAt: Schema.String,
  children: Schema.Array(SubtaskPlanChildSchema).pipe(Schema.minItems(1)),
  dependencies: Schema.Array(SubtaskPlanDependencySchema),
  applyContract: Schema.Struct({
    order: Schema.Tuple(Schema.Literal("create-all-children"), Schema.Literal("then-relate-by-role-map")),
    idempotencyKey: Schema.Literal("title-role-prefix-under-parent"),
    relateCommandTemplate: Schema.String
  })
});
