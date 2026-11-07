import { relationFreshnessWords, relationStateWords, taskStatusWords } from "./daemon-protocol-vocabulary.ts";
import {
  defineCenterForwardWriteCommand,
  defineEdgeReplicaQueryOnlyReadCommand,
  cliInput,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
  titleFocusFormat,
} from "@harness-anything/preset/internal/preset-command-contract";
import { AGENDA_PIN_CRITERIA } from "./daemon-protocol-vocabulary.ts";

export const taskSurfaceProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "task-witness-run",
    hiddenSince: "2026-11-05",
    phase: "W3",
    path: ["task", "witness-run", "<task-id>"],
    summary: "Request the center to execute one declared completion source; no caller-supplied result is accepted.",
    method: "repo.task.witness.run",
    inputs: [
      cliInput("--execution-id", "single", true, { code: "missing_field" }, { pathKind: "non-path" }),
      cliInput("--gate", "single", true, { code: "missing_field" }, { pathKind: "non-path", field: "gateId" }),
    ],
  }),
  ...["claim", "settle", "revoke", "rerun"].map((operation) =>
    (operation === "revoke" || operation === "rerun" ? defineCenterForwardWriteCommand : defineLedgerWriteCommand)({
      id: `task-witness-${operation}`,
      // `rerun` stays visible: gate-customization and the completion-readiness next action name it.
      ...(operation === "rerun" ? {} : { hiddenSince: "2026-11-05" }),
      helpTier: operation === "rerun" ? "maintenance" : "common",
      phase: "W3",
      path: ["task", `witness-${operation}`, "<task-id>"],
      summary:
        operation === "claim" || operation === "settle"
          ? "Completion source host action; task execution credentials cannot claim or publish witnesses."
          : `The task owner may ${operation} the current gate run with an explicit reason.`,
      method: "repo.task.run",
      inputs: [
        cliInput("--execution-id", "single", true, { code: "missing_field" }, { pathKind: "non-path" }),
        cliInput("--gate", "single", true, { code: "missing_field" }, { pathKind: "non-path", field: "gateId" }),
        cliInput(
          "--run-id",
          "single",
          operation === "revoke" || operation === "rerun",
          { code: "missing_field" },
          { pathKind: "non-path" },
        ),
        cliInput(
          "--reason",
          "single",
          operation === "revoke" || operation === "rerun",
          { code: "missing_field" },
          { pathKind: "non-path" },
        ),
      ],
    }),
  ),
  defineRepoReadCommand({
    id: "task-dispatches",
    repositoryRead: true,
    phase: "Runtime-B",
    path: ["task", "dispatches", "<task-id>"],
    summary: "List current and historical runtime dispatches associated with a Task.",
    method: "repo.task.dispatches",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "task-settle",
    helpTier: "advanced",
    payloadFields: [{ field: "taskId", type: "string", required: true, regex: "^[A-Za-z0-9_-]{1,96}$" }],
    phase: "W3",
    path: ["task", "settle", "<task-id>"],
    summary:
      "Assemble the deterministic post-delivery chain once: lease admission, document " +
      "synchronization, submission, and evidence preparation; stops wherever judgment is required.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "task-release",
    helpTier: "advanced",
    phase: "W3",
    path: ["task", "release", "<task-id>"],
    summary:
      "Release a lease after the worker stopped; this does not complete a round takeover. Use task rework --takeover to arrange the returned round.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requiredWhen: { field: "forceTakeover", values: ["true"] } },
      ),
      cliInput(
        "--force-takeover",
        "boolean",
        false,
        { code: "invalid_field" },
        {
          description:
            "Let the task creator release a stopped worker lease with a reason; this does not arrange or launch a replacement.",
        },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-declare-executor",
    helpTier: "maintenance",
    phase: "W3",
    path: ["task", "declare-executor", "<task-id>"],
    summary:
      "Repair executor attribution only for a submitted Execution that still has " +
      "executor=null; dispatched workers bind before launch.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--execution-id",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--agent",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
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
    id: "task-annotate",
    helpTier: "advanced",
    phase: "W3",
    path: ["task", "annotate", "<task-id>"],
    summary:
      "Append a correction or superseded-by note to an existing Execution record; " +
      "annotated history is never rewritten.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--execution-id",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--note",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--kind",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["correction", "superseded-by"] },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-attest",
    helpTier: "advanced",
    phase: "W3",
    path: ["task", "attest", "<task-id>"],
    summary:
      "Record a human witness for a completion gate: approve a manual-attest gate or sign off a " +
      "mandatorySignoff gate over its automated pass; the task owner may override a recorded automated " +
      "fail of an allowOverride gate with --mode override --rationale. Runtime executors cannot attest.",
    method: "repo.task.run",
    inputs: [
      cliInput("--gate", "single", true, { code: "missing_field" }, { pathKind: "non-path", field: "gateId" }),
      cliInput(
        "--result",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", enum: ["pass", "fail"] },
      ),
      cliInput(
        "--mode",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["approve", "override"] },
      ),
      cliInput(
        "--note",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--rationale",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-amend",
    helpTier: "advanced",
    phase: "W3",
    path: ["task", "amend", "<task-id>"],
    summary: "Amend declared task prose or metadata without changing lifecycle authority.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--set",
        "repeated",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[A-Za-z][A-Za-z0-9]*:.+$", field: "patches" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-pin",
    actionKind: "entity-pin",
    // Alias of `ha pin`; entity-pin is the surviving entry point.
    hiddenSince: "2026-11-05",
    phase: "W3",
    path: ["task", "pin", "<task-id>"],
    summary: `Pin a task only when it is ${AGENDA_PIN_CRITERIA}.`,
    method: "repo.task.run",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "task-unpin",
    actionKind: "entity-unpin",
    // Alias of `ha unpin`; entity-unpin is the surviving entry point.
    hiddenSince: "2026-11-05",
    phase: "W3",
    path: ["task", "unpin", "<task-id>"],
    summary: "Remove a task pin so its agenda group uses the standard order.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "task-contract-migrate",
    helpTier: "maintenance",
    phase: "W3",
    path: ["task", "contract", "migrate"],
    summary: "Backfill Task contracts, or explicitly migrate one inactive Task to an existing preset.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--to-preset",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--apply", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--task",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-archive",
    helpTier: "maintenance",
    phase: "W3",
    path: ["task", "archive", "[<task-id>]"],
    summary: "Archive selected Task packages while retaining their evidence and lifecycle history.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--ids",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { field: "taskIds", pathKind: "non-path" },
      ),
      cliInput(
        "--filter",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^state:(?:planned|active|blocked|in_review|done|cancelled)$" },
      ),
      cliInput(
        "--before",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
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
      cliInput(
        "--archived-by",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--archive-field",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-supersede",
    helpTier: "advanced",
    phase: "W3",
    path: ["task", "supersede", "<old-task-id>"],
    summary: "Archive old work and preserve an explicit replacement lineage.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--title",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--slug",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$" },
      ),
      cliInput(
        "--by",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--confirm",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--reason",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--deleted-by",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput("--allow-open-findings", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-rename",
    helpTier: "advanced",
    // CLI alias only: the forwarded durable action is task-amend (a title patch), so authorization,
    // receipt, and the Action inventory key on the shared kind. Declared after task-amend so the
    // kind keeps resolving to the amend descriptor.
    actionKind: "task-amend",
    phase: "W3",
    path: ["task", "rename", "<task-id>"],
    summary:
      "Retitle a task or work in one write: the contract, plan heading, INDEX, projection, and GUI " +
      "follow the same task_amended event. A plan with unsubmitted local changes is refused until " +
      "ha doc sync submits them.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--title",
        "single",
        true,
        { code: "missing_field" },
        { pathKind: "non-path", format: titleFocusFormat },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-move",
    helpTier: "advanced",
    // CLI alias only: the forwarded durable action is task-amend (a parentTaskId patch); relations,
    // dependencies, and dispatch history stay keyed to the task id and move with it.
    actionKind: "task-amend",
    phase: "W3",
    path: ["task", "move", "<task-id>"],
    summary:
      "Move a task, with its subtree, under another parent task or work by amending parentTaskId. " +
      "A live lease does not block the move: it re-hangs the task only, so a running worker is " +
      "unaffected. Refused when the new parent does not exist or when the move would make the " +
      "parent chain cyclic (including moving a task under itself or its own descendant).",
    method: "repo.task.run",
    inputs: [
      cliInput("--parent", "single", true, { code: "missing_field" }, { pathKind: "non-path", field: "parentTaskId" }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-delete",
    helpTier: "maintenance",
    phase: "W3",
    path: ["task", "delete"],
    summary: "Soft-delete through production authority; hard delete remains rejected with a repair path.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--soft",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", format: "<task-id>" },
      ),
      cliInput(
        "--hard",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", format: "<task-id>" },
      ),
      cliInput(
        "--confirm",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--reason",
        "single",
        false,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--deleted-by",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-reopen",
    helpTier: "advanced",
    phase: "W3",
    path: ["task", "reopen", "<task-id>"],
    summary: "Reopen a nonterminal archived or tombstoned Task package.",
    method: "repo.task.run",
    inputs: [
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
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "task-review",
    helpTier: "advanced",
    repositoryRead: true,
    phase: "W3",
    path: ["task", "review", "<task-id>"],
    summary: "Lint the legacy review contract without approving completion.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--reviewer",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "work-list",
    repositoryRead: true,
    phase: "W3",
    path: ["work", "list"],
    summary:
      "List works — a work is one root task plus its subtree — with task counts, leaf status counts, and " +
      "latest activity. Open works only unless --all.",
    method: "repo.task.read",
    inputs: [
      cliInput("--all", "boolean", false, { code: "invalid_field" }),
      cliInput(
        "--limit",
        "single",
        false,
        { code: "invalid_field" },
        {
          pathKind: "non-path",
          projection: "number",
          regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$",
          wire: { minimum: 1 },
        },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "work-show",
    repositoryRead: true,
    phase: "W3",
    path: ["work", "show", "<task-id>"],
    summary: "Show one work: its goal, leaf status counts, groups, and the tasks still open.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "task-list",
    repositoryRead: true,
    phase: "W3",
    path: ["task", "list"],
    summary:
      "List Task projection rows (default 50; use --cursor for more) or a recursive parent subtree " +
      "with canonical filters.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--status",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: taskStatusWords },
      ),
      cliInput(
        "--search",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--kind",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "workKind", enum: ["feat", "fix", "refactor", "docs", "test", "chore"] },
      ),
      cliInput(
        "--risk-tier",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--urgency",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--parent",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "parentTaskId" },
      ),
      cliInput(
        "--depth",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^(?:[1-9][0-9]*|all)$" },
      ),
      cliInput(
        "--updated-after",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$" },
      ),
      cliInput(
        "--updated-before",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$" },
      ),
      cliInput(
        "--limit",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          pathKind: "non-path",
          projection: "number",
          regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$",
          wire: { minimum: 1 },
        },
      ),
      cliInput(
        "--cursor",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "relation-triples",
    hiddenSince: "2026-11-05",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "triples"],
    summary: "List writable canonical relation triples, optionally filtered by endpoint kind.",
    method: "repo.task.read",
    inputs: [
      cliInput("--source-kind", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--target-kind", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "relation-list",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "list"],
    summary: "Query first-class Relation aggregates from the canonical versioned projection.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--entity",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      // --source/--target and the --source-ref/--target-ref spellings from `relation relate` feed
      // the same query fields; declaring them as mutually exclusive pairs keeps both spellings legal.
      cliInput(
        "--source",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--source-ref"], pathKind: "non-path" },
      ),
      cliInput(
        "--source-ref",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "source", conflictsWith: ["--source"] },
      ),
      cliInput(
        "--target",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--target-ref"], pathKind: "non-path" },
      ),
      cliInput(
        "--target-ref",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "target", conflictsWith: ["--target"] },
      ),
      cliInput(
        "--type",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--state",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: relationStateWords },
      ),
      cliInput(
        "--freshness",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: relationFreshnessWords },
      ),
      cliInput(
        "--updated-after",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$" },
      ),
      cliInput(
        "--updated-before",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$" },
      ),
      cliInput(
        "--limit",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
      ),
      cliInput(
        "--cursor",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "graph",
    phase: "W3",
    path: ["graph", "<ref>"],
    summary:
      "Render the read-only causal tree for one Task, Decision, Fact, or work/task slug: " +
      "declared relations in both directions plus task parent/child structure, with cycles, " +
      "repeats, and truncated frontiers marked. --depth is 1–16 (default 4); each relation neighborhood " +
      "has a fixed 500-node budget. On budget rejection use --depth 1 or a narrower task, decision anchor, or fact ref.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--depth",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^(?:[1-9]|1[0-6])$" },
      ),
      cliInput("--include-archived", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "task-read-set",
    repositoryRead: true,
    phase: "Governed-Entity-W2-B",
    path: ["task", "read-set", "<task-id>"],
    summary: "Derive what a Task must read from its declared relations at one projection cut.",
    method: "repo.task.read",
    inputs: [],
  }),
] as const);
