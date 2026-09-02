import { relationFreshnessWords, relationStateWords } from "./daemon-protocol-vocabulary.ts";
import {
  defineCenterForwardWriteCommand,
  cliInput,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
} from "../../../preset/src/preset-command-contract.ts";

export const taskSurfaceProtocolCommands = Object.freeze([
  defineRepoReadCommand({
    id: "task-dispatches",
    phase: "Runtime-B",
    path: ["task", "dispatches", "<task-id>"],
    summary: "List current and historical runtime dispatches associated with a Task.",
    method: "repo.task.dispatches",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "task-release",
    phase: "W3",
    path: ["task", "release", "<task-id>"],
    summary: "Release the authenticated holder lease and preserve the Execution audit trail.",
    method: "repo.task.run",
    inputs: [
      cliInput("--reason", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-declare-executor",
    phase: "W3",
    path: ["task", "declare-executor", "<task-id>"],
    summary:
      "Repair executor attribution only for a submitted Execution that still has " +
      "executor=null; dispatched workers bind before launch.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--agent",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      ),
      cliInput("--reason", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-transition",
    phase: "W3",
    path: ["task", "transition", "<task-id>", "<planned|active|blocked|in_review|done|cancelled>"],
    summary: "Move lifecycle status; done and in_review remain reserved for complete and submit.",
    method: "repo.task.run",
    inputs: [
      cliInput("--force", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--reason", "single", false, {
        code: "missing_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-amend",
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
        { regex: "^[A-Za-z][A-Za-z0-9]*:.+$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-pin",
    phase: "W3",
    path: ["task", "pin", "<task-id>"],
    summary: "Pin a task to the front of its agenda group.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "task-unpin",
    phase: "W3",
    path: ["task", "unpin", "<task-id>"],
    summary: "Remove a task pin so its agenda group uses the standard order.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "task-contract-migrate",
    phase: "W3",
    path: ["task", "contract", "migrate"],
    summary: "Plan or apply deterministic Task contract backfills; ambiguous Tasks remain manual.",
    method: "repo.task.run",
    inputs: [
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--apply", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--task", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-archive",
    phase: "W3",
    path: ["task", "archive", "[<task-id>]"],
    summary: "Archive selected Task packages while retaining their evidence and lifecycle history.",
    method: "repo.task.run",
    inputs: [
      cliInput("--ids", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--filter",
        "single",
        false,
        { code: "invalid_field" },
        {
          regex: "^state:(?:planned|active|blocked|in_review|done|cancelled)$",
        },
      ),
      cliInput("--before", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--reason", "single", true, {
        code: "missing_field",
      }),
      cliInput("--archived-by", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--archive-field", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-supersede",
    phase: "W3",
    path: ["task", "supersede", "<old-task-id>"],
    summary: "Archive old work and preserve an explicit replacement lineage.",
    method: "repo.task.run",
    inputs: [
      cliInput("--title", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--slug",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$" },
      ),
      cliInput("--by", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--confirm", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--reason", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--deleted-by", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--allow-open-findings", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-delete",
    phase: "W3",
    path: ["task", "delete"],
    summary: "Soft-delete through production authority; hard delete remains rejected with a repair path.",
    method: "repo.task.run",
    inputs: [
      cliInput("--soft", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--hard", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--confirm", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--reason", "single", false, {
        code: "missing_field",
      }),
      cliInput("--deleted-by", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-reopen",
    phase: "W3",
    path: ["task", "reopen", "<task-id>"],
    summary: "Reopen a nonterminal archived or tombstoned Task package.",
    method: "repo.task.run",
    inputs: [
      cliInput("--reason", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "task-review",
    phase: "W3",
    path: ["task", "review", "<task-id>"],
    summary: "Lint the legacy review contract without approving completion.",
    method: "repo.task.read",
    inputs: [
      cliInput("--reviewer", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "task-list",
    phase: "W3",
    path: ["task", "list"],
    summary: "List Task projection rows or a recursive parent subtree with canonical filters.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--status",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          enum: ["planned", "active", "blocked", "in_review", "done", "cancelled"],
        },
      ),
      cliInput("--module", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--search", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--kind",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: ["feat", "fix", "refactor", "docs", "test", "chore"] },
      ),
      cliInput("--risk-tier", "single", false, { code: "invalid_field" }, { enum: ["low", "medium", "high"] }),
      cliInput("--urgency", "single", false, { code: "invalid_field" }, { enum: ["low", "medium", "high"] }),
      cliInput("--parent", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--depth",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^(?:[1-9][0-9]*|all)$" },
      ),
      cliInput(
        "--updated-after",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
        },
      ),
      cliInput(
        "--updated-before",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
        },
      ),
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
  defineRepoReadCommand({
    id: "relation-list",
    phase: "Governed-Entity-W1-D",
    path: ["relation", "list"],
    summary: "Query first-class Relation aggregates from the canonical versioned projection.",
    method: "repo.task.read",
    inputs: [
      cliInput("--entity", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--source", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--target", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--type", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--state",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: relationStateWords },
      ),
      cliInput(
        "--freshness",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: relationFreshnessWords },
      ),
      cliInput(
        "--updated-after",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
        },
      ),
      cliInput(
        "--updated-before",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
        },
      ),
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
] as const);
