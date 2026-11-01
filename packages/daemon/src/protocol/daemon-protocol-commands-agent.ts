import {
  cliInput,
  defineCenterForwardWriteCommand,
  defineHostAdminCommand,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
  defineEdgeReplicaQueryOnlyReadCommand,
  defineRuntimeLocalWriteCommand,
} from "@harness-anything/preset/internal/preset-command-contract";
import { agentRunProtocolCommand } from "./daemon-protocol-commands-runtime-fleet.ts";

/** History pages accept 1..500 rows; the reader enforces the same bound. */
const agentHistoryLimit = "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$";
// `ha vertical kind upsert` reads the declaration in the calling CLI (the fleet channel forwards one
// object, and `kindId` may default from the file), so its path is relative to the selected root —
// `--root` or the current directory — not to the center's workspace root that `workspacePathFormat`
// names. Reusing that wording here told callers the wrong directory.
const callerRootPathFormat =
  "<path; relative paths resolve from the selected root (--root), defaulting to the current directory>";

export const agentProtocolCommands = Object.freeze([
  // Artifact kind authoring is a CLI surface over the same center actions the GUI calls. The five
  // commands below are the thin projections of `repo.vertical.kind.*`: no second write path exists.
  // A declaration is always fenced by the Kind's own accepted revision, so `--expected-version 0`
  // states the intent to create and an existing Kind answers by its stable identity or qualified id.
  defineRepoReadCommand({
    id: "vertical-kind-list",
    phase: "Governed-Entity-W2",
    path: ["vertical", "kind", "list"],
    summary:
      "List the declared Artifact kinds with their stable kindId, qualified id, revision fence and newest schema version.",
    method: "repo.task.read",
    inputs: [cliInput("--include-retired", "boolean", false, { code: "invalid_field" })],
  }),
  defineRepoReadCommand({
    id: "vertical-kind-show",
    phase: "Governed-Entity-W2",
    path: ["vertical", "kind", "show", "<kind>"],
    summary:
      "Show one declared Artifact kind, including every immutable schema version and its relations; retired kinds stay readable.",
    method: "repo.task.read",
    positional: "kindId",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "vertical-kind-upsert",
    actionKind: "vertical-kind-upsert",
    phase: "Governed-Entity-W2",
    path: ["vertical", "kind", "upsert"],
    summary:
      "Create one Artifact kind from a declaration, or restate the mutable facets of an existing one under its revision fence.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--kind",
        "single",
        false,
        { code: "invalid_field" },
        {
          description: "address an existing Kind by kindId, kindRef or qualified id; defaults to declaration.id",
        },
      ),
      cliInput("--declaration", "single", false, { code: "invalid_field" }, { projection: "json-object" }),
      cliInput(
        "--from-file",
        "single",
        false,
        { code: "invalid_field" },
        {
          format: callerRootPathFormat,
          conflictsWith: ["--declaration"],
          jsonFields: [
            "id",
            "entityType",
            "idPrefix",
            "display",
            "descriptorSchemaRef",
            "store",
            "locatorKinds",
            "attributes",
          ],
          jsonAllowedFields: [
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
            "kindId",
            "revision",
            "schemaVersions",
          ],
        },
      ),
      cliInput(
        "--expected-version",
        "single",
        true,
        { code: "missing_field" },
        { regex: "^(?:0|[1-9][0-9]*)$", projection: "number" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "vertical-kind-publish-schema",
    actionKind: "vertical-kind-publish-schema",
    phase: "Governed-Entity-W2",
    path: ["vertical", "kind", "publish-schema", "<kind>"],
    summary:
      "Publish the next immutable attribute schema version of one Artifact kind; published versions are never rewritten.",
    method: "repo.task.run",
    positional: "kindId",
    inputs: [
      cliInput("--attributes", "single", true, { code: "missing_field" }, { projection: "json-object" }),
      cliInput(
        "--expected-version",
        "single",
        true,
        { code: "missing_field" },
        { regex: "^(?:0|[1-9][0-9]*)$", projection: "number" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "vertical-kind-retire",
    actionKind: "vertical-kind-retire",
    phase: "Governed-Entity-W2",
    path: ["vertical", "kind", "retire", "<kind>"],
    summary: "Retire one Artifact kind with a required reason while preserving its declaration and instances.",
    method: "repo.task.run",
    positional: "kindId",
    inputs: [
      cliInput("--reason", "single", true, { code: "missing_field" }, { minLength: 1, maxLength: 199 }),
      cliInput(
        "--expected-version",
        "single",
        true,
        { code: "missing_field" },
        { regex: "^(?:0|[1-9][0-9]*)$", projection: "number" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "agenda",
    phase: "W3",
    path: ["agenda"],
    summary:
      "Project the current supervisory agenda from tasks, decisions, executions, and relations; " +
      "等你处理 lists the active awaits Relations addressed to you, each with its answer command " +
      "(or answer in place from the GUI overview); 已答复，待你跟进 lists answered awaits on the tasks " +
      "and decisions you own until the source is written again. " +
      "Each task row names its work; --work <id> narrows the agenda to that work's root and subtree.",
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
      cliInput("--work", "single", false, { code: "invalid_field" }, { format: "<work root task id>" }),
    ],
  }),
  agentRunProtocolCommand,
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
  defineCenterForwardWriteCommand({
    id: "assignment-migrate",
    phase: "Migration-A",
    path: ["migrate", "assignment"],
    summary: "Convert historical task assignment mutations into assigned-to Relation events and verify the conversion.",
    method: "repo.task.run",
    inputs: [cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" })],
  }),
  defineLedgerWriteCommand({
    id: "vertical-declaration-migrate",
    phase: "Migration-A",
    path: ["migrate", "vertical-declaration"],
    summary: "Materialize the repository vertical declaration once from the installed preset seed.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "squad-status",
    phase: "Runtime-B",
    path: ["squad", "status", "<squad-run-id>"],
    summary: "Read a durable Squad run and its leader and worker dispatches; --wait blocks until the run settles.",
    method: "repo.task.read",
    positional: "squadRunId",
    inputs: [cliInput("--wait", "boolean", false, { code: "invalid_field" })],
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
        "--mode",
        "single",
        false,
        { code: "invalid_field" },
        {
          field: "mode",
          enum: ["reference", "snapshot"],
          description:
            "Select --mode explicitly. reference records the locator without reading it; use it in personal or non-central repositories when the original should stay authoritative and easy to update. snapshot reads and stores observed bytes in Harness; use it for file documents governed by a central repository. Examples: ha entity import --kind <kind> --mode reference --expected-version 0 --locator https://example.invalid/minutes --locator-kind url; ha entity import --kind <kind> --mode snapshot --expected-version 0 --locator docs/minutes.md --locator-kind repository-path.",
        },
      ),
      cliInput(
        "--locator-kind",
        "single",
        false,
        { code: "invalid_field" },
        {
          field: "locatorKind",
          enum: ["repository-path", "url", "external-key", "local-path"],
          description:
            "Selects the locator grammar. Reference supports repository-path, url with any absolute scheme, local-path (a file URL or absolute path), and external-key (provider:project:key). A local path is resolvable only on the registering node.",
        },
      ),
      cliInput(
        "--content-version",
        "single",
        false,
        { code: "invalid_field" },
        {
          field: "contentVersion",
          description: "Optional caller-declared version for reference mode; never treated as observed content.",
        },
      ),
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
  defineEdgeReplicaQueryOnlyReadCommand({
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
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "entity-list",
    phase: "Runtime-B",
    path: ["entity", "list", "<kind>"],
    summary: "List canonical declarations for one registered Entity kind.",
    method: "repo.task.read",
    positional: "entityKind",
    inputs: [],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "agent-list",
    phase: "Runtime-B",
    path: ["agent", "list"],
    summary: "List installed Agent identity declarations.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
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
  // Version management reads the declaration history the ledger already keeps: every
  // entity_upserted carries its body digest, so a version is addressed by revision and read back
  // from the retained content object. These are named reads, not a second store.
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "agent-history",
    phase: "Runtime-B",
    path: ["agent", "history", "<id>"],
    summary:
      "List the declaration versions of one Agent, newest first; each row names the revision, actor, body digest and a one-line summary.",
    method: "repo.task.read",
    positional: "agentId",
    inputs: [
      cliInput("--limit", "single", false, { code: "invalid_field" }, { regex: agentHistoryLimit }),
      cliInput("--cursor", "single", false, { code: "invalid_field" }, { regex: "^[0-9]+$" }),
      cliInput("--no-summary", "boolean", false, { code: "invalid_field" }),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "agent-diff",
    phase: "Runtime-B",
    path: ["agent", "diff", "<id>"],
    summary:
      "Compare two declaration versions of one Agent field by field; --to defaults to the current declaration revision.",
    method: "repo.task.read",
    positional: "agentId",
    inputs: [
      cliInput("--from", "single", true, { code: "missing_field" }, { regex: "^[1-9][0-9]*$", projection: "number" }),
      cliInput("--to", "single", false, { code: "invalid_field" }, { regex: "^[1-9][0-9]*$", projection: "number" }),
    ],
  }),
  // The single-version body read behind `ha agent rollback` and the GUI version tab. Internal
  // because it is a composition input, not a documented command: the user-facing surface stays
  // history + diff + rollback, and no caller has to learn a fourth verb to read one old body.
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "agent-version-read",
    actionKind: "agent-version-read",
    internal: true,
    phase: "Runtime-B",
    path: ["agent", "_version"],
    summary: "Read one retained Agent declaration version and its difference to the live declaration.",
    method: "repo.task.read",
    inputs: [
      cliInput("--id", "single", true, { code: "missing_field" }, { field: "agentId" }),
      cliInput(
        "--revision",
        "single",
        true,
        { code: "missing_field" },
        { regex: "^[1-9][0-9]*$", projection: "number" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "agent-install",
    // Source paths belong to the edge; only the resolved declaration crosses the fleet wire.
    payloadFields: [{ field: "packageSource", type: "string", required: false, wire: { omit: true } }],
    phase: "Runtime-B",
    path: ["agent", "install"],
    summary:
      "Install an Agent declaration, or update an existing one in place; --expected-version guards the update against concurrent edits.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" }),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
      cliInput(
        "--expected-version",
        "single",
        false,
        { code: "invalid_field" },
        { regex: "^[0-9]+$", projection: "number" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
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
  // Rollback composes existing surfaces rather than adding a write path: the CLI reads the
  // retained body of --to-revision, refuses a byte-identical no-op, then submits that body as the
  // ordinary agent-install action with the revision fence. It therefore rides the read method at
  // the protocol layer; the daemon answers it with the CLI instruction instead of composing RPCs.
  defineRepoReadCommand({
    id: "agent-rollback",
    actionKind: "agent-rollback",
    phase: "Runtime-B",
    path: ["agent", "rollback", "<id>"],
    summary:
      "Restore one historical Agent declaration revision through agent-install; refuses to write when the target body is already live.",
    method: "repo.task.read",
    positional: "agentId",
    inputs: [
      cliInput(
        "--to-revision",
        "single",
        true,
        { code: "missing_field" },
        { regex: "^[1-9][0-9]*$", projection: "number" },
      ),
      cliInput(
        "--expected-version",
        "single",
        false,
        { code: "invalid_field" },
        { regex: "^[0-9]+$", projection: "number" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "agent-retire",
    phase: "Runtime-B",
    path: ["agent", "retire", "<id>"],
    summary: "Retire an Agent while retaining its canonical history and deep-link identity.",
    method: "repo.task.run",
    positional: "agentId",
    inputs: [
      cliInput("--reason", "single", true, { code: "missing_field" }),
      cliInput("--successor", "single", false, { code: "invalid_field" }),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "squad-list",
    phase: "Runtime-B",
    path: ["squad", "list"],
    summary: "List installed Squad identity declarations.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "squad-inspect",
    phase: "Runtime-B",
    path: ["squad", "inspect", "<id>"],
    summary: "Inspect one Squad and its human-editable roster text.",
    method: "repo.task.read",
    positional: "squadId",
    inputs: [],
  }),
  defineRuntimeLocalWriteCommand({
    id: "squad-run",
    phase: "Runtime-B",
    path: ["squad", "run", "<id>"],
    summary: [
      "Start a durable task-derived Squad run; the selected instance and model apply only to its leader. ",
      "Without --cwd the run uses the task's worktree; Harness creates and reclaims worker worktrees itself.",
    ].join(""),
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
  defineCenterForwardWriteCommand({
    id: "squad-install",
    // Source paths belong to the edge; only the resolved declaration crosses the fleet wire.
    payloadFields: [{ field: "packageSource", type: "string", required: false, wire: { omit: true } }],
    phase: "Runtime-B",
    path: ["squad", "install"],
    summary:
      "Install a Squad declaration, or update an existing one in place; --expected-version guards the update against concurrent edits.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" }),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
      cliInput("--expected-version", "single", false, { code: "invalid_field" }, { projection: "number" }),
    ],
  }),
  defineCenterForwardWriteCommand({
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
    id: "edge-join",
    phase: "W3",
    path: ["edge", "join", "<link>"],
    positional: "link",
    summary: "Consume an edge invitation after TLS pin verification and signed-in device approval.",
    method: "daemon.rbac.manage",
    // One operation of the managed RBAC surface, like login; it declares no Action of its own.
    actionKind: "rbac-bootstrap",
    inputs: [
      cliInput("--root", "single", false, { code: "invalid_field" }, { field: "workspaceRoot" }),
      cliInput(
        "--quota-bytes",
        "single",
        false,
        { code: "invalid_field" },
        {
          field: "quotaBytes",
          regex: "^[1-9][0-9]*$",
          projection: "number",
        },
      ),
    ],
  }),
  defineHostAdminCommand({
    id: "rbac-bootstrap",
    phase: "W3",
    path: ["bootstrap"],
    summary:
      "Sign in without a local browser (--operation login), inspect session, or logout; install/configure Keycloak, manage its HTTPS listener, session lifetime and fleet node registrations. `session-lifetime` reports the Keycloak URL and realm it reads. To set the lifetime, first read its version and pass it with --expected-version. Configure external harness-center credentials with --client-secret-stdin (redirected input only). Create the first administrator with --operation bootstrap-admin and --password-file; credentials never belong in argv. A first node registration requires --credential-file for the machine credential it mints.",
    method: "daemon.rbac.manage",
    inputs: [
      cliInput(
        "--operation",
        "single",
        false,
        { code: "invalid_field" },
        {
          enum: [
            "bootstrap",
            "health",
            "start",
            "stop",
            "backup",
            "restore",
            "upgrade",
            "bootstrap-status",
            "bootstrap-admin",
            "login",
            "session",
            "logout",
            "session-lifetime",
            "session-lifetime-set",
            "listener",
            "listener-set",
            "team-list",
            "team-create",
            "team-update",
            "team-delete",
            "team-member-add",
            "team-member-remove",
            "group-list",
            "grant-list",
            "grant",
            "revoke",
            "node-list",
            "node-register",
            "node-unregister",
            "receipt-list",
            "receipt-reconcile",
            "device-list",
            "device-rename",
            "device-pause",
            "device-resume",
            "device-remove",
            "device-logout-all",
            "edge-join-create",
            "edge-join-status",
            "edge-join-list",
            "edge-join-revoke",
          ],
        },
      ),
      cliInput("--confirm", "boolean", false, { code: "invalid_field" }),
      cliInput("--force", "boolean", false, { code: "invalid_field" }),
      cliInput("--mode", "single", false, { code: "invalid_field" }, { enum: ["managed", "external"] }),
      cliInput("--url", "single", false, { code: "invalid_field" }),
      cliInput("--realm", "single", false, { code: "invalid_field" }),
      cliInput("--client-secret-stdin", "boolean", false, { code: "invalid_field" }, { field: "clientSecretStdin" }),
      cliInput("--client-id", "single", false, { code: "invalid_field" }, { field: "clientId" }),
      cliInput("--backup-dir", "single", false, { code: "invalid_field" }, { field: "backupDir" }),
      cliInput(
        "--seconds",
        "single",
        false,
        { code: "invalid_field" },
        { field: "sessionLifetimeSeconds", regex: "^[1-9][0-9]*$", projection: "number" },
      ),
      cliInput(
        "--expected-version",
        "single",
        false,
        { code: "invalid_field" },
        {
          field: "expectedVersion",
          description: "for session-lifetime-set, use the version returned by --operation session-lifetime",
        },
      ),
      cliInput(
        "--operation-id",
        "single",
        false,
        { code: "invalid_field" },
        {
          field: "operationId",
          description:
            "journal key for one access-administration write; generated when omitted, so pass it explicitly to retry the same operation",
        },
      ),
      cliInput("--listen-address", "single", false, { code: "invalid_field" }, { field: "listenAddress" }),
      cliInput("--hostname", "single", false, { code: "invalid_field" }),
      cliInput("--port", "single", false, { code: "invalid_field" }, { regex: "^[1-9][0-9]*$", projection: "number" }),
      cliInput("--certificate-file", "single", false, { code: "invalid_field" }, { field: "certificateFile" }),
      cliInput("--certificate-key-file", "single", false, { code: "invalid_field" }, { field: "certificateKeyFile" }),
      cliInput("--team-id", "single", false, { code: "invalid_field" }, { field: "teamId" }),
      cliInput("--team-name", "single", false, { code: "invalid_field" }, { field: "teamName" }),
      cliInput("--node-id", "single", false, { code: "invalid_field" }, { field: "nodeId" }),
      cliInput("--system-name", "single", false, { code: "invalid_field" }, { field: "systemName" }),
      cliInput("--platform", "single", false, { code: "invalid_field" }),
      cliInput("--person-id", "single", false, { code: "invalid_field" }, { field: "personId" }),
      cliInput("--group-id", "single", false, { code: "invalid_field" }, { field: "groupId" }),
      cliInput("--resource", "single", false, { code: "invalid_field" }),
      cliInput("--credential-file", "single", false, { code: "invalid_field" }, { field: "credentialFile" }),
      cliInput("--join-id", "single", false, { code: "invalid_field" }, { field: "joinId" }),
      cliInput("--join-repo", "repeated", false, { code: "invalid_field" }),
      cliInput("--join-group", "repeated", false, { code: "invalid_field" }),
      cliInput("--node-label", "single", false, { code: "invalid_field" }, { field: "nodeLabel" }),
      cliInput("--transport", "single", false, { code: "invalid_field" }, { enum: ["direct", "ssh-reverse"] }),
      cliInput("--ssh-target", "single", false, { code: "invalid_field" }, { field: "sshTarget" }),
      cliInput("--username", "single", false, { code: "invalid_field" }, { field: "username" }),
      cliInput("--email", "single", false, { code: "invalid_field" }, { field: "email" }),
      cliInput("--display-name", "single", false, { code: "invalid_field" }, { field: "displayName" }),
      cliInput("--password-file", "single", false, { code: "invalid_field" }, { field: "passwordFile" }),
    ],
  }),
  defineHostAdminCommand({
    id: "node-unregister",
    actionKind: "rbac-bootstrap",
    phase: "W3",
    path: ["access", "node", "unregister"],
    summary:
      "Preview retirement of one node across all repositories. Pass --confirm and the preview's --expected-version to revoke credentials, disconnect sessions and remove replication slots. Busy nodes require --force. Force fences further writes; existing leases and executions remain for explicit recovery and are listed in the audit receipt. Rejoin with ha edge join to obtain a new node identity.",
    method: "daemon.rbac.manage",
    inputs: [
      cliInput("--node-id", "single", true, { code: "missing_field" }, { field: "nodeId" }),
      cliInput("--expected-version", "single", false, { code: "invalid_field" }, { field: "expectedVersion" }),
      cliInput("--confirm", "boolean", false, { code: "invalid_field" }),
      cliInput("--force", "boolean", false, { code: "invalid_field" }),
      cliInput("--operation-id", "single", false, { code: "invalid_field" }, { field: "operationId" }),
    ],
  }),
  // dec_F01770FD0DCF72683B7C4C7A47/CH4: request lifecycle actions are explicit host-admin
  // descriptors even though they share the closed daemon.rbac.manage transport.
  defineHostAdminCommand({
    id: "permission-request-create",
    actionKind: "permission-request-create",
    phase: "W3",
    path: ["access", "request-create"],
    summary: "Create a versioned permission request.",
    method: "daemon.rbac.manage",
    inputs: [
      cliInput("--group-id", "single", true, { code: "missing_field" }, { field: "groupId" }),
      cliInput("--resource", "single", true, { code: "missing_field" }),
      cliInput("--rationale", "single", false, { code: "invalid_field" }),
    ],
  }),
  defineHostAdminCommand({
    id: "permission-request-decide",
    actionKind: "permission-request-decide",
    phase: "W3",
    path: ["access", "request-decide"],
    summary: "Approve or reject a versioned permission request.",
    method: "daemon.rbac.manage",
    inputs: [
      cliInput("--request-id", "single", true, { code: "missing_field" }, { field: "requestId" }),
      cliInput(
        "--request-version",
        "single",
        true,
        { code: "missing_field" },
        { field: "requestVersion", regex: "^[1-9][0-9]*$", projection: "number" },
      ),
      cliInput("--decision", "single", true, { code: "missing_field" }, { enum: ["approve", "reject"] }),
    ],
  }),
  defineHostAdminCommand({
    id: "permission-request-withdraw",
    actionKind: "permission-request-withdraw",
    phase: "W3",
    path: ["access", "request-withdraw"],
    summary: "Withdraw a pending permission request.",
    method: "daemon.rbac.manage",
    inputs: [
      cliInput("--request-id", "single", true, { code: "missing_field" }, { field: "requestId" }),
      cliInput(
        "--request-version",
        "single",
        true,
        { code: "missing_field" },
        { field: "requestVersion", regex: "^[1-9][0-9]*$", projection: "number" },
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
