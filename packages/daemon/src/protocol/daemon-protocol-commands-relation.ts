import {
  relationDirectionWords as relationDirections,
  relationOriginWords as relationOrigins,
  relationTypeWords as relationTypes,
} from "./daemon-protocol-vocabulary.ts";
import { cliInput, defineCenterForwardWriteCommand } from "../../../preset/src/preset-command-contract.ts";

const invalid = (nextAction: string) => ({ code: "invalid_field", nextAction });
const expectedVersion = cliInput(
  "--expected-version",
  "single",
  true,
  invalid("Supply the current Relation aggregate revision (0 when creating a new relation)."),
  { regex: "^(?:0|[1-9][0-9]*)$", projection: "number" as const },
);

export const relationProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "relation-relate",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "relate"],
    summary: "Create a first-class Relation aggregate under its revision fence.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source-ref", "single", true, invalid("Use a canonical registered Entity ref as --source-ref.")),
      cliInput("--target-ref", "single", true, invalid("Use a canonical registered Entity ref as --target-ref.")),
      cliInput("--type", "single", true, invalid("Use a registered canonical relation type."), {
        field: "relationType",
        enum: relationTypes,
      }),
      cliInput("--direction", "single", false, invalid("Use directed or undirected."), { enum: relationDirections }),
      cliInput("--origin", "single", false, invalid("Use a registered Relation origin."), { enum: relationOrigins }),
      cliInput("--rationale", "single", true, invalid("Supply a non-empty relation rationale.")),
      expectedVersion,
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "relation-unrelate",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "unrelate", "<relation-id>"],
    summary: "Retire a Relation aggregate under its revision fence.",
    method: "repo.task.run",
    inputs: [cliInput("--reason", "single", true, invalid("Supply a non-empty retirement reason.")), expectedVersion],
  }),
  defineCenterForwardWriteCommand({
    id: "relation-reconfirm",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "reconfirm", "<relation-id>"],
    summary: "Reconfirm a Relation against the target version at the current canonical cut.",
    method: "repo.task.run",
    inputs: [
      cliInput("--rationale", "single", true, invalid("Supply a non-empty reconfirmation rationale.")),
      expectedVersion,
    ],
  }),
] as const);
