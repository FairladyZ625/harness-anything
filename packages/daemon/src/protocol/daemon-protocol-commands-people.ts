import {
  cliInput,
  defineCliCommand,
  workspacePathFormat,
} from "@harness-anything/preset/internal/preset-command-contract";

export const peopleDelegateJsonFields = Object.freeze(["tokenId", "runtimeSessionId", "action", "expiresAt"] as const),
  peopleDelegateJsonAllowedFields = Object.freeze([...peopleDelegateJsonFields, "idempotencyKey"] as const),
  peopleRevokeDelegationJsonFields = Object.freeze(["tokenId"] as const),
  peopleRevokeDelegationJsonAllowedFields = Object.freeze([
    ...peopleRevokeDelegationJsonFields,
    "idempotencyKey",
  ] as const);

const peopleWriteTopology = {
    commandClass: "admin" as const,
    admission: {
      local: "direct" as const,
      "remote-proxy": "rejected" as const,
      "remote-center": "direct" as const,
      "remote-edge": "via-center-forward" as const,
    },
  },
  textInput = (name: string, required: boolean) =>
    cliInput(name, "single", required, { code: "invalid_field" }, { minLength: 1 }),
  packetInputs = (requiredFields: readonly string[], allowedFields: readonly string[]) => [
    cliInput(
      "--from-file",
      "single",
      false,
      { code: "invalid_field" },
      {
        jsonFields: requiredFields,
        jsonAllowedFields: allowedFields,
        format: workspacePathFormat,
        conflictsWith: ["--json-input"],
      },
    ),
    cliInput(
      "--json-input",
      "single",
      false,
      { code: "invalid_field" },
      {
        jsonFields: requiredFields,
        jsonAllowedFields: allowedFields,
        format: "<json|@->",
        conflictsWith: ["--from-file"],
      },
    ),
  ],
  tokenIdInput = () =>
    cliInput(
      "--token-id",
      "single",
      false,
      {
        code: "missing_field",
      },
      {
        regex: "^det_[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$",
        conflictsWith: ["--from-file"],
      },
    ),
  idempotencyInput = () => textInput("--idempotency-key", false);

export const peopleProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "people-delegate",
    actionKind: "people-delegate",
    phase: "Persons-Registry",
    path: ["people", "delegate"],
    summary: "Delegate a closed Action set from the authenticated principal to one RuntimeSession.",
    method: "repo.task.run",
    inputs: [
      ...packetInputs(peopleDelegateJsonFields, peopleDelegateJsonAllowedFields),
      tokenIdInput(),
      cliInput(
        "--runtime-session-id",
        "single",
        false,
        {
          code: "missing_field",
        },
        { regex: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", conflictsWith: ["--from-file"] },
      ),
      cliInput(
        "--action",
        "repeated",
        false,
        {
          code: "missing_field",
        },
        {
          regex: "^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$",
          minItems: 1,
          unique: true,
          conflictsWith: ["--from-file"],
        },
      ),
      cliInput(
        "--expires-at",
        "single",
        false,
        {
          code: "missing_field",
        },
        { minLength: 1, conflictsWith: ["--from-file"] },
      ),
      idempotencyInput(),
    ],
    ...peopleWriteTopology,
  }),
  defineCliCommand({
    id: "people-revoke-delegation",
    actionKind: "people-revoke-delegation",
    phase: "Persons-Registry",
    path: ["people", "revoke-delegation"],
    summary: "Revoke one DelegatedExecutionToken through the canonical Action writer.",
    method: "repo.task.run",
    inputs: [
      ...packetInputs(peopleRevokeDelegationJsonFields, peopleRevokeDelegationJsonAllowedFields),
      tokenIdInput(),
      idempotencyInput(),
    ],
    ...peopleWriteTopology,
  }),
]);
