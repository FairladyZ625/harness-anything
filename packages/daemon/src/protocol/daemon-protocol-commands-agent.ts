import {
  cliInput,
  defineHostAdminCommand,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
  defineRuntimeLocalWriteCommand,
} from "../../../preset/src/preset-command-contract.ts";

export const agentProtocolCommands = Object.freeze([
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
          nextAction: "Use --limit with an integer from 1 to 500 (applied per agenda source).",
        },
        { regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
      ),
      cliInput("--cursor", "single", false, {
        code: "invalid_field",
        nextAction: "Use the non-empty nextCursor returned by the previous agenda page.",
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
          nextAction: "Add one or more --source <git-repository-path> values.",
        },
        { field: "sourceRoots" },
      ),
      cliInput(
        "--resolve",
        "repeated",
        false,
        {
          code: "invalid_field",
          nextAction: "Use --resolve <repo-relative-path>=destination|source once per reported conflict.",
        },
        { regex: "^.+=(?:destination|source)$" },
      ),
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "fact-rekey",
    phase: "Migration-A",
    path: ["migrate", "rekey-facts"],
    summary:
      "Re-key facts in a committed canonical repository; stop daemon writers first and use --dry-run before applying.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
    ],
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
          nextAction: "Add --agent <designer-agent-id>.",
        },
        { field: "agentId" },
      ),
      cliInput(
        "--prompt",
        "single",
        true,
        {
          code: "missing_field",
          nextAction: "Add --prompt <Agent requirement>.",
        },
        { field: "prompt" },
      ),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
          nextAction: "Use minimal, low, medium, high, or xhigh with a Codex instance.",
        },
        {
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          field: "effort",
        },
      ),
      cliInput(
        "--model",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use one model supported by the runtime instance.",
        },
        { field: "model" },
      ),
      cliInput(
        "--cwd",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use a repository-relative directory; omit --cwd for the repository root.",
        },
        { field: "cwd" },
      ),
      cliInput(
        "--task",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use one active task id for --task.",
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
    method: "repo.task.run",
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
  defineLedgerWriteCommand({
    id: "ledger-migrate",
    phase: "Migration-A",
    path: ["migrate", "ledger"],
    summary: "Migrate the canonical ledger from flat/v1 to sharded-sha256-2/v1.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "entity-explain",
    phase: "Runtime-B",
    path: ["entity", "explain", "<kind>"],
    summary: "Explain one registered Entity kind contract.",
    method: "repo.task.run",
    positional: "entityKind",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "entity-get",
    phase: "Runtime-B",
    path: ["entity", "get", "<kind>"],
    summary: "Read one canonical Entity declaration.",
    method: "repo.task.run",
    positional: "entityKind",
    inputs: [
      cliInput("--id", "single", true, {
        code: "missing_field",
        nextAction: "Add --id <entity-id>.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "entity-list",
    phase: "Runtime-B",
    path: ["entity", "list", "<kind>"],
    summary: "List canonical declarations for one registered Entity kind.",
    method: "repo.task.run",
    positional: "entityKind",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "agent-list",
    phase: "Runtime-B",
    path: ["agent", "list"],
    summary: "List installed Agent identity declarations.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "agent-inspect",
    phase: "Runtime-B",
    path: ["agent", "inspect", "<id>"],
    summary: "Inspect one Agent identity including its instructions and runtime type.",
    method: "repo.task.run",
    positional: "agentId",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "agent-validate",
    phase: "Runtime-B",
    path: ["agent", "validate"],
    summary: "Validate one Agent declaration package before installing it.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--source",
        "single",
        true,
        { code: "missing_field", nextAction: "Add --source <agent-package>." },
        { field: "packageSource" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "agent-install",
    phase: "Runtime-B",
    path: ["agent", "install"],
    summary: "Install an Agent declaration into the repository entity store.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--source",
        "single",
        true,
        { code: "missing_field", nextAction: "Add --source <agent-package>." },
        { field: "packageSource" },
      ),
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "squad-list",
    phase: "Runtime-B",
    path: ["squad", "list"],
    summary: "List installed Squad identity declarations.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "squad-inspect",
    phase: "Runtime-B",
    path: ["squad", "inspect", "<id>"],
    summary: "Inspect one Squad and its human-editable roster text.",
    method: "repo.task.run",
    positional: "squadId",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "squad-run",
    phase: "Runtime-B",
    path: ["squad", "run", "<id>"],
    summary: "Start a durable task-derived Squad run supervised by callback-driven leader turns.",
    method: "repo.task.run",
    positional: "squadId",
    inputs: [
      cliInput("--instance", "single", true, {
        code: "missing_field",
        nextAction: "Add --instance <runtime-instance-id>.",
      }),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
          nextAction: "Use minimal, low, medium, high, or xhigh with a Codex instance.",
        },
        { enum: ["minimal", "low", "medium", "high", "xhigh"] },
      ),
      cliInput("--model", "single", false, {
        code: "invalid_field",
        nextAction: "Use one model supported by the runtime instance.",
      }),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
          nextAction: "Use bypass, workspace-write, or read-only for every Squad dispatch.",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput("--cwd", "single", false, {
        code: "invalid_field",
        nextAction: "Use a repository-relative directory; omit --cwd for the repository root.",
      }),
      cliInput("--task", "single", true, {
        code: "missing_field",
        nextAction: "Add --task <active-task-id> so every squad report is archived.",
      }),
      cliInput("--prompt", "single", false, {
        code: "invalid_field",
        nextAction: "Use --prompt <text> only as an override; omit it to derive the mission from --task.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "squad-validate",
    phase: "Runtime-B",
    path: ["squad", "validate"],
    summary: "Validate one Squad declaration package before installing it.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--source",
        "single",
        true,
        { code: "missing_field", nextAction: "Add --source <squad-package>." },
        { field: "packageSource" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "squad-install",
    phase: "Runtime-B",
    path: ["squad", "install"],
    summary: "Install a Squad declaration into the repository entity store.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--source",
        "single",
        true,
        { code: "missing_field", nextAction: "Add --source <squad-package>." },
        { field: "packageSource" },
      ),
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
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
      cliInput("--repo-id", "single", true, {
        code: "missing_field",
        nextAction: "Init requires repo-id, person-id, and display-name.",
      }),
      cliInput("--person-id", "single", true, {
        code: "missing_field",
        nextAction: "Init requires repo-id, person-id, and display-name.",
      }),
      cliInput("--display-name", "single", true, {
        code: "missing_field",
        nextAction: "Init requires repo-id, person-id, and display-name.",
      }),
      cliInput(
        "--name",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "--name must be one non-empty line.",
        },
        { regex: "^[^\\r\\n]+$" },
      ),
      cliInput("--configure-only", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --configure-only once.",
      }),
      cliInput("--add-npm-scripts", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --add-npm-scripts once.",
      }),
    ],
  }),
] as const);
