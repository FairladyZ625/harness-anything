import {
  cliInput,
  defineCenterForwardWriteCommand,
  defineHostAdminCommand,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
  defineRuntimeLocalWriteCommand,
} from "../../../preset/src/preset-command-contract.ts";

export const agentProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "vertical-kind-upsert-cli",
    actionKind: "vertical-kind-upsert",
    phase: "Governed-Entity-W2",
    path: ["vertical", "entity-kind", "upsert"],
    summary:
      "Create one Artifact kind, or restate the mutable facets of an existing one. " +
      "Creation mints the kind's stable identity and version 1 of its attribute schema; " +
      "a rename keeps every existing reference.",
    method: "repo.vertical.kind.upsert",
    inputs: [
      cliInput(
        "--from-file",
        "single",
        true,
        { code: "missing_field" },
        {
          jsonFields: ["id", "entityType", "idPrefix", "display", "descriptorSchemaRef", "store", "locatorKinds"],
          jsonAllowedFields: [
            "retired",
            "retiredAt",
            "reason",
            "kindId",
            "id",
            "entityType",
            "idPrefix",
            "display",
            "descriptorSchemaRef",
            "store",
            "locatorKinds",
            "attributes",
            "relations",
            "maturityVocabulary",
          ],
        },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "vertical-kind-publish-schema-cli",
    actionKind: "vertical-kind-publish-schema",
    phase: "Governed-Entity-W2",
    path: ["vertical", "entity-kind", "publish-schema", "<kind>"],
    summary:
      "Publish the next immutable attribute schema version of one Artifact kind. " +
      "Existing instances keep the version they were accepted against.",
    method: "repo.vertical.kind.publishSchema",
    positional: "kindId",
    inputs: [
      cliInput(
        "--from-file",
        "single",
        true,
        { code: "missing_field" },
        {
          jsonFields: [],
          jsonAllowedFields: ["<attribute name>: { type, enum, required }"],
        },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "vertical-kind-retire-cli",
    actionKind: "vertical-kind-retire",
    phase: "Governed-Entity-W2",
    path: ["vertical", "entity-kind", "retire", "<kind>"],
    summary: "Retire one Artifact kind with a required reason while preserving its declaration.",
    method: "repo.vertical.kind.retire",
    positional: "kindId",
    inputs: [cliInput("--reason", "single", true, { code: "missing_field" })],
  }),
  defineRepoReadCommand({
    id: "agenda",
    phase: "W3",
    path: ["agenda"],
    summary: "Project the current supervisory agenda from tasks, decisions, executions, and relations.",
    method: "repo.agenda.read",
    inputs: [
      cliInput(
        "--limit",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
      ),
      cliInput("--cursor", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "migrate-import",
    phase: "Migration-A",
    path: ["migrate", "import"],
    summary: [
      "Merge one or more complete Git Harness repositories in --source order; ",
      "source writers must be stopped and the source must be a committed snapshot; ",
      "id collisions are deterministically remapped and recorded.",
    ].join(""),
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--source",
        "repeated",
        true,
        {
          code: "missing_field",
        },
        { field: "sourceRoots" },
      ),
      cliInput(
        "--resolve",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^.+=(?:destination|source)$" },
      ),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "vertical-declaration-migrate",
    phase: "Migration-A",
    path: ["migrate", "vertical-declaration"],
    summary: "Materialize the repository vertical declaration once from the installed preset seed.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineRuntimeLocalWriteCommand({
    id: "agent-create",
    phase: "Runtime-B",
    path: ["agent", "create", "<instance-id>"],
    summary: [
      "Ask a declared Agent designer for one structured Agent declaration, ",
      "validate it, and install it without overwriting an existing Agent.",
    ].join(""),
    method: "repo.agentRuntime.spawn",
    positional: "runtimeInstanceId",
    inputs: [
      cliInput(
        "--agent",
        "single",
        true,
        {
          code: "missing_field",
        },
        { field: "agentId" },
      ),
      cliInput(
        "--prompt",
        "single",
        true,
        {
          code: "missing_field",
        },
        { field: "prompt" },
      ),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        {
          enum: ["minimal", "low", "medium", "high", "xhigh", "max"],
          field: "effort",
        },
      ),
      cliInput(
        "--model",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { field: "model" },
      ),
      cliInput(
        "--cwd",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { field: "cwd" },
      ),
      cliInput(
        "--task",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { field: "taskId" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "squad-status",
    phase: "Runtime-B",
    path: ["squad", "status", "<squad-run-id>"],
    summary: "Read a durable Squad run and its leader and worker dispatches.",
    method: "repo.task.read",
    positional: "squadRunId",
    inputs: [],
  }),
  defineRuntimeLocalWriteCommand({
    id: "squad-cancel",
    phase: "Runtime-B",
    path: ["squad", "cancel", "<squad-run-id>"],
    summary: "Durably cancel a Squad run and terminate its leader and worker runtimes.",
    method: "repo.task.run",
    positional: "squadRunId",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "ledger-reconcile",
    phase: "Migration-A",
    path: ["ledger", "reconcile"],
    summary: "Verify the SQLite ledger against its immutable import source, outcomes and required content.",
    method: "repo.task.read",
    inputs: [cliInput("--generation", "single", true, { code: "missing_field" })],
  }),
  defineRepoReadCommand({
    id: "explain",
    actionKind: "entity-action-explain",
    phase: "Ontology-Explain-A",
    path: ["explain", "<kind|entity/ref>..."],
    summary: "Explain a builtin or compiled Artifact Action catalog, or evaluate object refs at the canonical cut.",
    method: "repo.entity.actions.explain",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "entity-import",
    phase: "Governed-Entity-W1-B",
    path: ["entity", "import"],
    summary: "Resolve and import one compiled vertical Artifact Entity through the canonical entity action path.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--kind",
        "single",
        true,
        {
          code: "missing_field",
        },
        { field: "entityKind" },
      ),
      cliInput("--locator", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--expected-version",
        "single",
        true,
        {
          code: "missing_field",
        },
        { regex: "^(?:0|[1-9][0-9]*)$", projection: "number" },
      ),
      cliInput("--title", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--entity-id", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--source-identity", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
      // One JSON object rather than a flag per attribute: the Kind declares its own attribute names at runtime,
      // so the CLI cannot enumerate them, and JSON is the only form that keeps a number a number.
      cliInput("--attributes", "single", false, { code: "invalid_field" }, { projection: "json-object" }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "entity-update",
    phase: "Governed-Entity-W2",
    path: ["entity", "update", "<kind>"],
    summary: "Update mutable fields of one compiled vertical Artifact Entity.",
    method: "repo.task.run",
    positional: "entityKind",
    inputs: [
      cliInput("--id", "single", true, { code: "missing_field" }, { field: "entityId" }),
      cliInput(
        "--expected-version",
        "single",
        true,
        { code: "missing_field" },
        {
          regex: "^(?:0|[1-9][0-9]*)$",
          projection: "number",
        },
      ),
      cliInput("--title", "single", false, { code: "invalid_field" }),
      cliInput("--locator", "single", false, { code: "invalid_field" }),
      cliInput("--content-version", "single", false, { code: "invalid_field" }, { field: "contentVersion" }),
      cliInput("--attributes", "single", false, { code: "invalid_field" }, { projection: "json-object" }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "entity-delete",
    phase: "Governed-Entity-W2",
    path: ["entity", "delete", "<kind>"],
    summary: "Delete one compiled vertical Artifact Entity and retire every file it owns.",
    method: "repo.task.run",
    positional: "entityKind",
    inputs: [
      cliInput("--id", "single", true, { code: "missing_field" }, { field: "entityId" }),
      cliInput("--reason", "single", true, { code: "missing_field" }),
      cliInput(
        "--expected-version",
        "single",
        true,
        { code: "missing_field" },
        {
          regex: "^(?:0|[1-9][0-9]*)$",
          projection: "number",
        },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "entity-archive",
    phase: "Governed-Entity-W2",
    path: ["entity", "archive", "<kind>"],
    summary: "Archive one compiled vertical Artifact Entity without deleting its descriptor.",
    method: "repo.task.run",
    positional: "entityKind",
    inputs: [
      cliInput("--id", "single", true, { code: "missing_field" }, { field: "entityId" }),
      cliInput("--reason", "single", true, { code: "missing_field" }),
      cliInput(
        "--expected-version",
        "single",
        true,
        { code: "missing_field" },
        {
          regex: "^(?:0|[1-9][0-9]*)$",
          projection: "number",
        },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "entity-get",
    phase: "Runtime-B",
    path: ["entity", "get", "<kind>"],
    summary: "Read one canonical Entity declaration.",
    method: "repo.task.read",
    positional: "entityKind",
    inputs: [
      cliInput("--id", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "entity-list",
    phase: "Runtime-B",
    path: ["entity", "list", "<kind>"],
    summary: "List canonical declarations for one registered Entity kind.",
    method: "repo.task.read",
    positional: "entityKind",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "agent-list",
    phase: "Runtime-B",
    path: ["agent", "list"],
    summary: "List installed Agent identity declarations.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "agent-inspect",
    phase: "Runtime-B",
    path: ["agent", "inspect", "<id>"],
    summary: "Inspect one Agent identity including its instructions and runtime type.",
    method: "repo.task.read",
    positional: "agentId",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "agent-validate",
    phase: "Runtime-B",
    path: ["agent", "validate"],
    summary: "Validate one Agent declaration package before installing it.",
    method: "repo.task.read",
    inputs: [cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" })],
  }),
  defineLedgerWriteCommand({
    id: "agent-install",
    phase: "Runtime-B",
    path: ["agent", "install"],
    summary: "Install an Agent declaration into the repository entity store.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" }),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "agent-delete",
    phase: "Runtime-B",
    path: ["agent", "delete", "<id>"],
    summary: "Delete an Agent current view while retaining its canonical history.",
    method: "repo.task.run",
    positional: "agentId",
    inputs: [
      cliInput("--reason", "single", true, { code: "missing_field" }),
      cliInput("--expected-version", "single", true, { code: "missing_field" }, { projection: "number" }),
    ],
  }),
  defineRepoReadCommand({
    id: "squad-list",
    phase: "Runtime-B",
    path: ["squad", "list"],
    summary: "List installed Squad identity declarations.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "squad-inspect",
    phase: "Runtime-B",
    path: ["squad", "inspect", "<id>"],
    summary: "Inspect one Squad and its human-editable roster text.",
    method: "repo.task.read",
    positional: "squadId",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "squad-run",
    phase: "Runtime-B",
    path: ["squad", "run", "<id>"],
    summary: "Start a durable task-derived Squad run; the selected instance and model apply only to its leader.",
    method: "repo.task.run",
    positional: "squadId",
    inputs: [
      cliInput("--instance", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      ),
      cliInput("--model", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput("--cwd", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--task", "single", true, {
        code: "missing_field",
      }),
      cliInput("--prompt", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--detach", "boolean", false, { code: "invalid_field" }, { field: "detach" }),
    ],
  }),
  defineRepoReadCommand({
    id: "squad-validate",
    phase: "Runtime-B",
    path: ["squad", "validate"],
    summary: "Validate one Squad declaration package before installing it.",
    method: "repo.task.read",
    inputs: [cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" })],
  }),
  defineLedgerWriteCommand({
    id: "squad-install",
    phase: "Runtime-B",
    path: ["squad", "install"],
    summary: "Install a Squad declaration into the repository entity store.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" }),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "squad-delete",
    phase: "Runtime-B",
    path: ["squad", "delete", "<id>"],
    summary: "Delete a Squad current view while retaining its canonical history.",
    method: "repo.task.run",
    positional: "squadId",
    inputs: [
      cliInput("--reason", "single", true, { code: "missing_field" }),
      cliInput("--expected-version", "single", true, { code: "missing_field" }, { projection: "number" }),
    ],
  }),
  defineHostAdminCommand({
    id: "repo-bootstrap",
    phase: "W3",
    path: ["init"],
    summary: [
      "Initialize and register a workspace through the daemon (started on ",
      "demand); --configure-only reapplies machine configuration to an ",
      "already-initialized workspace without writing documents.",
    ].join(""),
    method: "daemon.repo.bootstrap",
    inputs: [
      cliInput("--repo-id", "single", false, {
        code: "missing_field",
      }),
      cliInput("--person-id", "single", false, {
        code: "missing_field",
      }),
      cliInput("--display-name", "single", false, {
        code: "missing_field",
      }),
      cliInput(
        "--name",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^[^\\r\\n]+$" },
      ),
      cliInput("--configure-only", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--add-npm-scripts", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
] as const);
