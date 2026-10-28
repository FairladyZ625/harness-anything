import {
  relationDirectionWords as relationDirections,
  relationOriginWords as relationOrigins,
  relationTypeWords as relationTypes,
} from "./daemon-protocol-vocabulary.ts";
import { cliInput, defineCenterForwardWriteCommand } from "@harness-anything/preset/internal/preset-command-contract";

const invalid = () => ({ code: "invalid_field" });
const expectedVersion = cliInput("--expected-version", "single", true, invalid(), {
  regex: "^(?:0|[1-9][0-9]*)$",
  projection: "number" as const,
});
const endpointRefFormat =
  "<kind>/<id>; a newly created task is task/<task-id>, the id alone and task:<task-id> are not refs";

export const relationProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "relation-relate",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "relate"],
    summary: [
      "Create a first-class Relation aggregate under its revision fence. ",
      "Both endpoints are Entity refs spelled <kind>/<id> — task/<task-id>, decision/<decision-id>/<clause-id>, ",
      "fact/<fact-id>, person/<person-id>; a bare id or kind:id is rejected as an invalid ref, not a missing entity. ",
      "To ask a person for an answer, relate task/<id> or decision/<id> to person/<id> with --type awaits ",
      '--rationale "<question|acceptance|consent|reopen>: <what you ask>"; it lists in their ha agenda ',
      "等你处理 and holds the task out of the dispatch queue until answered — ask there, not in markdown or chat. ",
      "To ask again after an answer, relate the same endpoints with --expected-version set to the retired ",
      "Relation's revision (the column after its id in ha relation list, workspaceRevision in --json); ",
      "the relation reactivates with the new rationale and keeps its history.",
    ].join(""),
    method: "repo.task.run",
    inputs: [
      cliInput("--source-ref", "single", true, invalid(), {
        description: "the Relation's source endpoint, a local Entity ref",
        format: endpointRefFormat,
      }),
      cliInput("--target-ref", "single", true, invalid(), {
        description: "the Relation's target endpoint, a local Entity ref",
        format: endpointRefFormat,
      }),
      cliInput("--type", "single", true, invalid(), {
        field: "relationType",
        enum: relationTypes,
      }),
      cliInput("--direction", "single", false, invalid(), { enum: relationDirections }),
      cliInput("--origin", "single", false, invalid(), { enum: relationOrigins }),
      cliInput("--rationale", "single", true, invalid()),
      cliInput("--expected-version", "single", true, invalid(), {
        description:
          "the Relation's current revision; pass 0 to create a new Relation and the retired revision to re-ask",
        regex: "^(?:0|[1-9][0-9]*)$",
        projection: "number" as const,
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "relation-unrelate",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "unrelate", "<relation-id>"],
    summary:
      "Retire a Relation aggregate under its revision fence: --expected-version is the Relation's own " +
      "revision, the column after its id in ha relation list (workspaceRevision in --json). " +
      "Answering an awaits Relation retires it " +
      "with the answer as --reason; the person can instead answer it in place from the GUI overview " +
      "(等你答复), which writes the same retire.",
    method: "repo.task.run",
    inputs: [cliInput("--reason", "single", true, invalid()), expectedVersion],
  }),
  defineCenterForwardWriteCommand({
    id: "relation-reconfirm",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "reconfirm", "<relation-id>"],
    summary: "Reconfirm a Relation against the target version at the current canonical cut.",
    method: "repo.task.run",
    inputs: [cliInput("--rationale", "single", true, invalid()), expectedVersion],
  }),
] as const);
