import { cliInput, defineCliCommand } from "../../../preset/src/preset-command-contract.ts";
import { credentialKindWords, peopleCommandClassWords } from "./daemon-protocol-vocabulary.ts";

export const peopleAddJsonFields = Object.freeze(["personId", "displayName", "role", "commandClass"] as const),
  peopleAddJsonAllowedFields = Object.freeze([
    ...peopleAddJsonFields,
    "primaryEmail",
    "credentialKind",
    "credentialIssuer",
    "credentialSubject",
    "idempotencyKey",
  ] as const),
  peopleSetRoleJsonFields = Object.freeze(["personId", "role", "commandClass"] as const),
  peopleSetRoleJsonAllowedFields = Object.freeze([...peopleSetRoleJsonFields, "idempotencyKey"] as const),
  peopleRemoveJsonFields = Object.freeze(["personId"] as const),
  peopleRemoveJsonAllowedFields = Object.freeze([...peopleRemoveJsonFields, "idempotencyKey"] as const);

const peopleWriteTopology = {
    commandClass: "admin" as const,
    admission: {
      local: "direct" as const,
      "remote-center": "direct" as const,
      "remote-edge": "via-center-forward" as const,
    },
  },
  textInput = (name: string, required: boolean, nextAction: string) =>
    cliInput(name, "single", required, { code: "invalid_field", nextAction }, { minLength: 1 }),
  fromFileInput = (requiredFields: readonly string[], allowedFields: readonly string[]) =>
    cliInput(
      "--from-file",
      "single",
      false,
      {
        code: "invalid_field",
        nextAction: "Use --from-file <packet.json> by itself, or provide the complete direct flag set.",
      },
      { jsonFields: requiredFields, jsonAllowedFields: allowedFields },
    ),
  personIdInput = () =>
    cliInput(
      "--person-id",
      "single",
      false,
      {
        code: "missing_field",
        nextAction: "Use --person-id with a letter-led identifier up to 63 characters, or use --from-file.",
      },
      { regex: "^[A-Za-z][A-Za-z0-9_-]{0,62}$", conflictsWith: ["--from-file"] },
    ),
  roleInput = () =>
    cliInput(
      "--role",
      "single",
      false,
      { code: "missing_field", nextAction: "Use --role with one non-empty role identifier, or use --from-file." },
      { minLength: 1, conflictsWith: ["--from-file"] },
    ),
  commandClassInput = () =>
    cliInput(
      "--command-class",
      "repeated",
      false,
      {
        code: "missing_field",
        nextAction: "Repeat --command-class with admin, repo-write, repo-read, or arbiter, or use --from-file.",
      },
      { enum: peopleCommandClassWords, minItems: 1, unique: true, conflictsWith: ["--from-file"] },
    ),
  idempotencyInput = () =>
    textInput("--idempotency-key", false, "Use one stable non-empty idempotency key, or omit it."),
  credentialInput = (name: string) =>
    cliInput(
      name,
      "single",
      false,
      {
        code: "invalid_field",
        nextAction: "Credential kind, issuer, and subject must be supplied together, or all three must be omitted.",
      },
      {
        requires: ["--credential-kind", "--credential-issuer", "--credential-subject"],
      },
    );

export const peopleProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "people-add",
    actionKind: "people-add",
    phase: "Persons-Registry",
    path: ["people", "add"],
    summary: "Add a Person to people.yaml through the canonical Action writer.",
    method: "repo.task.run",
    inputs: [
      fromFileInput(peopleAddJsonFields, peopleAddJsonAllowedFields),
      personIdInput(),
      cliInput(
        "--display-name",
        "single",
        false,
        { code: "missing_field", nextAction: "Use --display-name with one non-empty line, or use --from-file." },
        { minLength: 1, conflictsWith: ["--from-file"] },
      ),
      textInput("--primary-email", false, "Use --primary-email with one non-empty value."),
      roleInput(),
      commandClassInput(),
      cliInput(
        "--credential-kind",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Credential kind, issuer, and subject must be supplied together, or all three must be omitted.",
        },
        {
          enum: credentialKindWords,
          requires: ["--credential-issuer", "--credential-subject"],
        },
      ),
      credentialInput("--credential-issuer"),
      credentialInput("--credential-subject"),
      idempotencyInput(),
    ],
    ...peopleWriteTopology,
  }),
  defineCliCommand({
    id: "people-set-role",
    actionKind: "people-set-role",
    phase: "Persons-Registry",
    path: ["people", "set-role"],
    summary: "Set one Person role and its command classes through the canonical Action writer.",
    method: "repo.task.run",
    inputs: [
      fromFileInput(peopleSetRoleJsonFields, peopleSetRoleJsonAllowedFields),
      personIdInput(),
      roleInput(),
      commandClassInput(),
      idempotencyInput(),
    ],
    ...peopleWriteTopology,
  }),
  defineCliCommand({
    id: "people-remove",
    actionKind: "people-remove",
    phase: "Persons-Registry",
    path: ["people", "remove"],
    summary: "Remove a Person from people.yaml through the canonical Action writer.",
    method: "repo.task.run",
    inputs: [fromFileInput(peopleRemoveJsonFields, peopleRemoveJsonAllowedFields), personIdInput(), idempotencyInput()],
    ...peopleWriteTopology,
  }),
]);
