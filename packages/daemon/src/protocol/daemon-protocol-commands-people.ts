import { cliInput, defineCliCommand } from "../../../preset/src/preset-command-contract.ts";
import { credentialKinds, peopleCommandClasses } from "../../../kernel/src/index.ts";

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
  personIdInput = () =>
    cliInput(
      "--person-id",
      "single",
      true,
      {
        code: "invalid_field",
        nextAction: "Use --person-id with a letter-led identifier up to 63 characters.",
      },
      { regex: "^[A-Za-z][A-Za-z0-9_-]{0,62}$" },
    ),
  roleInput = () => textInput("--role", true, "Use --role with one non-empty role identifier."),
  commandClassInput = () =>
    cliInput(
      "--command-class",
      "repeated",
      true,
      {
        code: "invalid_field",
        nextAction: "Repeat --command-class with admin, repo-write, repo-read, or arbiter.",
      },
      { enum: peopleCommandClasses, minItems: 1, unique: true },
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
      personIdInput(),
      textInput("--display-name", true, "Use --display-name with one non-empty line."),
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
          enum: credentialKinds,
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
    inputs: [personIdInput(), roleInput(), commandClassInput(), idempotencyInput()],
    ...peopleWriteTopology,
  }),
  defineCliCommand({
    id: "people-remove",
    actionKind: "people-remove",
    phase: "Persons-Registry",
    path: ["people", "remove"],
    summary: "Remove a Person from people.yaml through the canonical Action writer.",
    method: "repo.task.run",
    inputs: [personIdInput(), idempotencyInput()],
    ...peopleWriteTopology,
  }),
]);
