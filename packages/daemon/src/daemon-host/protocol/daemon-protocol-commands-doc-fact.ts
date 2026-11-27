import {
  defineEdgeReplicaQueryOnlyReadCommand,
  defineCenterForwardWriteCommand,
  cliInput,
  defineLedgerWriteCommand,
  defineCliCommand,
  nodeLocalWriteCommandTopology,
  workspacePathFormat,
} from "@harness-anything/preset/internal/preset-command-contract";

const factDomainTypeFormat =
  "<Fact domain type; 1-64 characters with no leading/trailing whitespace or control characters; " +
  "run ha fact type list for registered values or ha fact type register <type> --source <source> to register one>";

export const docFactProtocolCommands = Object.freeze([
  ...["assign", "unassign"].map((operation) =>
    defineCenterForwardWriteCommand({
      id: `fact-${operation}`,
      phase: "DecisionFact-B",
      path: ["fact", operation, "<fact-id>"],
      summary:
        operation === "assign" ? "Assign a Fact to a person, node or team." : "Remove the current Fact assignment.",
      method: "repo.task.run",
      inputs: [
        cliInput(
          "--expected-version",
          "single",
          true,
          { code: "missing_field" },
          { pathKind: "non-path", projection: "number" },
        ),
        ...(operation === "assign"
          ? [
              cliInput(
                "--person",
                "single",
                false,
                { code: "invalid_field" },
                { pathKind: "non-path", field: "personId" },
              ),
              cliInput("--node", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "nodeId" }),
              cliInput("--team", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "teamId" }),
              cliInput(
                "--expires-at",
                "single",
                false,
                { code: "invalid_field" },
                { pathKind: "non-path", field: "expiresAt" },
              ),
            ]
          : []),
      ],
      actionConstraints: operation === "assign" ? [["personId", "nodeId", "teamId"]] : [],
    }),
  ),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "doc-status",
    phase: "DocSync-B",
    path: ["doc", "status"],
    summary: "Scan the authored root for document candidates.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--task",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--path",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "ledger-document", format: workspacePathFormat },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "doc-sync-dry-run",
    actionKind: "doc-dry-run",
    phase: "DocSync-B",
    path: ["doc", "sync", "--dry-run"],
    summary: "Preview the scanner selection without writing.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--task",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--path",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "ledger-document", format: workspacePathFormat },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-sync-submit",
    actionKind: "doc-submit",
    phase: "DocSync-B",
    path: ["doc", "sync", "--submit"],
    summary:
      "Submit eligible scanner candidates through the resident daemon. refresh-region-policy guards " +
      "machine-managed frontmatter; authored prose sections stay free to edit, reorder, add, or remove, " +
      "and task start still requires the scaffold headings.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--task",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { field: "taskId", pathKind: "non-path" },
      ),
      cliInput(
        "--path",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { field: "paths", pathKind: "ledger-document", format: workspacePathFormat },
      ),
      cliInput(
        "--all",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--task", "--path"] },
      ),
    ],
  }),
  defineCliCommand({
    ...nodeLocalWriteCommandTopology,
    id: "doc-materialize",
    phase: "DocSync-B",
    path: ["doc", "materialize"],
    summary: [
      "Preview what restoring the canonical cut would touch; restore named paths with --path, a task package with --task, ",
      "or the whole cut with --all.",
    ].join(""),
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--task",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { field: "taskId", pathKind: "non-path" },
      ),
      cliInput(
        "--path",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "ledger-document", format: workspacePathFormat },
      ),
      cliInput(
        "--all",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--task", "--path"] },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "doc-show",
    repositoryRead: true,
    phase: "DocSync-B",
    path: ["doc", "show"],
    summary: "Show a canonical projected document; --raw prints only the document body.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--path",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "ledger-document", format: workspacePathFormat },
      ),
      cliInput("--raw", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--offset", "single", false, { code: "invalid_field" }, { pathKind: "non-path", projection: "number" }),
      cliInput("--length", "single", false, { code: "invalid_field" }, { pathKind: "non-path", projection: "number" }),
      cliInput(
        "--content-sha256",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "contentSha256" },
      ),
      cliInput(
        "--content-revision",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "contentRevision", projection: "number" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-retire",
    phase: "DocSync-B",
    path: ["doc", "retire"],
    summary: "Retire one or more canonical documents with one audited reason.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--path",
        "repeated",
        true,
        {
          code: "missing_field",
        },
        { field: "paths", pathKind: "ledger-document", format: workspacePathFormat },
      ),
      cliInput(
        "--reason",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-conflict-resolve",
    phase: "Fleet-Wiring",
    path: ["doc", "conflict", "resolve", "<conflict-id>"],
    summary:
      "Close a staged sync conflict by hand after merging base/local/center; the next sync submits on the fresh base.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-conflict-discard-local",
    phase: "Fleet-Wiring",
    path: ["doc", "conflict", "discard-local", "<conflict-id>"],
    summary: "Resolve a staged sync conflict by discarding the local changes and restoring the recorded center bytes.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-conflict-overwrite-center",
    phase: "Fleet-Wiring",
    path: ["doc", "conflict", "overwrite-center", "<conflict-id>"],
    summary: [
      "Resolve a staged sync conflict by pushing the staged local bytes with ",
      "the recorded center digest as the expected base.",
    ].join(""),
    method: "repo.task.run",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "fact-reclassify",
    phase: "DecisionFact-A",
    path: ["fact", "reclassify"],
    syntaxPath: ["fact", "reclassify", "<fact-id>"],
    summary: "Replace a Fact's domain types with an audited reclassification event.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--type",
        "repeated",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", field: "domainTypes", format: factDomainTypeFormat },
      ),
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "fact-archive",
    payloadFields: [
      { field: "factId", type: "string", required: false, wire: { required: false } },
      { field: "factIds", type: "string-array", required: false },
      { field: "idsFile", type: "string", required: false, wire: { omit: true } },
    ],
    phase: "DecisionFact-A",
    path: ["fact", "archive"],
    syntaxPath: ["fact", "archive", "<fact-id>"],
    summary:
      "Archive one Fact (or every id listed by --ids-file) with an audited fact_archived event: " +
      "the managed Markdown retires while the event and projection row stay canonical.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput(
        "--ids-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          codec: { kind: "line-list-file", target: "factIds", maxBytes: 64 * 1024 },
          field: "idsFile",
          pathKind: "workspace-file",
          // An empty --ids-file settles as no_changes in archiveAllFacts; it never reports applied.
          zeroHit: "no_changes",
          format: workspacePathFormat,
        },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "fact-unarchive",
    phase: "DecisionFact-A",
    path: ["fact", "unarchive"],
    syntaxPath: ["fact", "unarchive", "<fact-id>"],
    summary: "Restore one archived Fact's managed document and visibility with an audited fact_unarchived event.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "fact-rematerialize",
    phase: "DecisionFact-A",
    path: ["fact", "rematerialize"],
    summary:
      "Re-render one Fact's or every Fact's managed document from the current canonical projection, including liveness.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--all",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--id"] },
      ),
      cliInput(
        "--id",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "factId", conflictsWith: ["--all"], regex: "^F-[0-9A-HJKMNP-TV-Z]{8}$" },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "fact-type-register",
    payloadFields: [
      { field: "type", type: "string", required: false, wire: { omit: true } },
      { field: "source", type: "string", required: false, wire: { omit: true } },
      { field: "statement", type: "string", required: true },
      { field: "evidenceSource", type: "string", required: true },
      { field: "confidence", type: "string", required: false },
      { field: "memoryClass", type: "string", required: false },
      { field: "memoryTags", type: "string-array", required: false },
      { field: "registersDomainType", type: "string", required: true },
    ],
    phase: "DecisionFact-A",
    path: ["fact", "type", "register"],
    syntaxPath: ["fact", "type", "register", "<type>"],
    summary: "Register one controlled Fact domain type through an audited Fact event.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--source",
        "single",
        true,
        {
          code: "missing_field",
        },
        { field: "evidenceSource", pathKind: "non-path" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "fact-type-list",
    phase: "DecisionFact-A",
    path: ["fact", "type", "list"],
    summary: "List registered Fact domain types and the Fact that registered each value.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "fact-record",
    payloadFields: [
      {
        field: "supersedes",
        type: "json-object",
        required: false,
        fields: [
          { field: "factRef", type: "string", required: true },
          { field: "rationale", type: "string", required: true },
        ],
      },
      { field: "rationale", type: "string", required: false, wire: { omit: true } },
    ],
    phase: "DecisionFact-A",
    path: ["fact", "record"],
    syntaxPath: ["fact", "record", "[task-id]"],
    summary: "Record an immutable Fact event.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", false, { code: "missing_field" }, { pathKind: "non-path", field: "taskId" }),
      cliInput(
        "--statement",
        "single",
        false,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", field: "statement", maxLength: 32 * 1024, conflictsWith: ["--text"] },
      ),
      cliInput(
        "--text",
        "single",
        false,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", field: "statement", maxLength: 32 * 1024, conflictsWith: ["--statement"] },
      ),
      cliInput(
        "--source",
        "single",
        true,
        { code: "missing_field" },
        { field: "evidenceSource", pathKind: "non-path" },
      ),
      cliInput(
        "--observed-at",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$" },
      ),
      cliInput(
        "--confidence",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--memory-class",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["semantic", "episodic", "procedural"] },
      ),
      cliInput(
        "--type",
        "repeated",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "domainTypes", format: factDomainTypeFormat },
      ),
      cliInput(
        "--memory-tag",
        "repeated",
        false,
        { code: "invalid_field" },
        // Mirrors kernel factMemoryTags; the thin CLI graph must not load a kernel module for help.
        {
          pathKind: "non-path",
          field: "memoryTags",
          enum: ["episode", "procedural", "tool_memory", "pattern", "task_skill", "abstract_rule", "other"],
        },
      ),
      cliInput(
        "--supersedes",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", requires: ["--rationale"] },
      ),
      cliInput(
        "--rationale",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", requires: ["--supersedes"], regex: "^[\\s\\S]{1,199}$", format: "1-199 characters" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "fact-show",
    phase: "DecisionFact-A",
    path: ["fact", "show", "<fact-id>"],
    summary: "Show one projected Fact.",
    method: "repo.task.read",
    inputs: [
      // <fact-id> and --id are the same field in two spellings; the parser rejects both-at-once
      // and reports a missing id itself, so the flag stays optional in the declaration.
      cliInput(
        "--id",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^F-[0-9A-HJKMNP-TV-Z]{8}$" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "kb-catalog",
    repositoryRead: true,
    phase: "KB-S1",
    path: ["kb", "catalog"],
    summary: "List KB document catalog cards across local-private and center-shared scopes.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--scope",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["local", "shared", "all"] },
      ),
      cliInput("--domain", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--tag", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--include-archived", "boolean", false, { code: "invalid_field" }, { field: "includeArchived" }),
      cliInput("--limit", "single", false, { code: "invalid_field" }, { pathKind: "non-path", projection: "number" }),
      cliInput("--cursor", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput(
        "--max-summary-chars",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "maxSummaryChars", projection: "number" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "kb-outline",
    repositoryRead: true,
    phase: "KB-S1",
    path: ["kb", "outline", "<doc-id>"],
    summary: "Show the deterministic Markdown heading outline tree for a KB document.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--scope",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["local", "shared", "all"] },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "kb-read",
    repositoryRead: true,
    phase: "KB-S1",
    path: ["kb", "read", "<doc-id>"],
    summary: "Read a KB document by complete section, line range, or full view without fixed chunking.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--scope",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["local", "shared", "all"] },
      ),
      cliInput(
        "--section",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", conflictsWith: ["--lines", "--full"] },
      ),
      cliInput(
        "--lines",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", conflictsWith: ["--section", "--full"] },
      ),
      cliInput("--full", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--section", "--lines"] }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "kb-put",
    phase: "KB-S1",
    path: ["kb", "put", "<doc-id>"],
    summary: "Write or update a KB Document Bundle in local-private or center-shared scope.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--scope",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["local", "shared"] },
      ),
      cliInput("--title", "single", true, { code: "missing_field" }, { pathKind: "non-path" }),
      cliInput("--domain", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--summary", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--alias", "repeated", false, { code: "invalid_field" }, { pathKind: "non-path", field: "aliases" }),
      cliInput("--tag", "repeated", false, { code: "invalid_field" }, { pathKind: "non-path", field: "tags" }),
      cliInput(
        "--status",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["active", "superseded", "rejected"] },
      ),
      cliInput(
        "--superseded-by",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "supersededBy" },
      ),
      cliInput(
        "--valid-from",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "validFrom" },
      ),
      cliInput("--valid-to", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "validTo" }),
      cliInput(
        "--content",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", conflictsWith: ["--file"] },
      ),
      cliInput(
        "--file",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "contentFile", conflictsWith: ["--content"] },
      ),
      cliInput(
        "--source-filename",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "sourceFilename" },
      ),
      cliInput(
        "--source-media-type",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "sourceMediaType" },
      ),
      cliInput(
        "--expected-version",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "expectedVersion", projection: "number" },
      ),
    ],
  }),
  defineCliCommand({
    ...nodeLocalWriteCommandTopology,
    id: "kb-mount",
    phase: "KB-S1",
    path: ["kb", "mount"],
    summary: "Manage host-local external Markdown directory mounts for local-private KB.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--operation",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["list", "add", "remove", "write"] },
      ),
      cliInput("--mount-id", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "mountId" }),
      cliInput("--path", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "rootPath" }),
      cliInput(
        "--mode",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["readonly", "readwrite"] },
      ),
      cliInput("--domain", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--tag", "repeated", false, { code: "invalid_field" }, { pathKind: "non-path", field: "tags" }),
      cliInput(
        "--relative-path",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "relativePath" },
      ),
      cliInput("--content", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    ],
  }),
] as const);
