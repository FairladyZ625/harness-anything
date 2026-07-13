import { Model } from "@effect/sql";
import { Schema } from "effect";

export class D4TaskProjectionModel extends Model.Class<D4TaskProjectionModel>("D4TaskProjectionModel")({
  taskId: Schema.String,
  title: Schema.String,
  canonicalStatus: Schema.String,
  coordinationStatus: Schema.String,
  rawStatus: Schema.String,
  packageDisposition: Schema.String,
  closeoutReadiness: Schema.String,
  lifecycleEngine: Schema.String,
  freshness: Schema.String,
  updatedAt: Schema.String,
  source: Schema.String,
  sourcePath: Schema.String,
  vertical: Schema.NullOr(Schema.String),
  preset: Schema.NullOr(Schema.String),
  profile: Schema.NullOr(Schema.String),
  moduleKey: Schema.NullOr(Schema.String),
  moduleTitle: Schema.NullOr(Schema.String),
  hasLessonCandidates: Schema.Number
}) {}

export class D4DecisionProjectionModel extends Model.Class<D4DecisionProjectionModel>("D4DecisionProjectionModel")({
  decisionId: Schema.String,
  legacyId: Schema.NullOr(Schema.String),
  legacyNumber: Schema.NullOr(Schema.Number),
  state: Schema.String,
  title: Schema.String,
  question: Schema.String,
  chosenJson: Schema.String,
  rejectedJson: Schema.String,
  path: Schema.String,
  moduleKeysJson: Schema.String,
  productLineKeysJson: Schema.String,
  decidedAt: Schema.NullOr(Schema.String)
}) {}
