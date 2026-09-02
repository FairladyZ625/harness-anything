import {
  relationDirectionWords as relationDirections,
  relationOriginWords as relationOrigins,
  relationTypeWords as relationTypes,
} from "./daemon-protocol-vocabulary.ts";
import { cliInput, defineCenterForwardWriteCommand } from "../../../preset/src/preset-command-contract.ts";

const invalid = () => ({ code: "invalid_field" });
const expectedVersion = cliInput("--expected-version", "single", true, invalid(), {
  regex: "^(?:0|[1-9][0-9]*)$",
  projection: "number" as const,
});

export const relationProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "relation-relate",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "relate"],
    summary: "Create a first-class Relation aggregate under its revision fence.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source-ref", "single", true, invalid()),
      cliInput("--target-ref", "single", true, invalid()),
      cliInput("--type", "single", true, invalid(), {
        field: "relationType",
        enum: relationTypes,
      }),
      cliInput("--direction", "single", false, invalid(), { enum: relationDirections }),
      cliInput("--origin", "single", false, invalid(), { enum: relationOrigins }),
      cliInput("--rationale", "single", true, invalid()),
      expectedVersion,
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "relation-unrelate",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "unrelate", "<relation-id>"],
    summary: "Retire a Relation aggregate under its revision fence.",
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
