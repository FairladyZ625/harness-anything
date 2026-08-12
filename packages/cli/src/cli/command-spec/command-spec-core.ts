import { defineCommandSpecs } from "./types.ts";
import { parseCapabilitiesArgs } from "../parsers/capabilities.ts";
import { parseCoreTaskArgs } from "../parsers/core-task.ts";
import { parseHelpArgs, parseVersionArgs } from "../parsers/meta.ts";
import { parseRelationArgs } from "../parsers/relation.ts";
import { parseTaskLifecycleCommandArgs } from "../parsers/task-lifecycle.ts";
import { runCapabilitiesCommand } from "../../commands/core/capabilities.ts";
import { runHelpCommand } from "../../commands/core/help.ts";
import { runInitCommand } from "../../commands/core/init.ts";
import { runTaskLifecycleFacadeCommand } from "../../commands/core/task-lifecycle-host.ts";
import { runTaskQueryCommand } from "../../commands/core/task-query.ts";
import { runVersionCommand } from "../../commands/core/version.ts";
import { WRITE_RECEIPT_SCHEMA } from "../../../../kernel/src/index.ts";

const lifecycleOptionalData: Readonly<Record<string, string>> = Object.fromEntries([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]
  .filter((field) => field !== "outcome").map((field) => [field, `Declared by ${WRITE_RECEIPT_SCHEMA.id}.`]));

const taskReceiptContract = {
  data: ["taskId", "outcome", "report"],
  optionalData: lifecycleOptionalData,
  paths: []
} as const;

const executionReceiptContract = {
  data: ["taskId", "executionId", "outcome", "report"],
  optionalData: lifecycleOptionalData,
  paths: []
} as const;

export const coreCommandSpecs = defineCommandSpecs([
  {
    kind: "help",
    usage: "help",
    options: [],
    aliases: ["--help", "-h"],
    summary: "Show global help or detailed help for one command.",
    examples: ["harness-anything help task create"],
    parse: parseHelpArgs,
    run: runHelpCommand,
    receiptContract: { data: ["commands", "report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "version",
    usage: "version",
    options: [],
    aliases: ["--version", "-v"],
    summary: "Print the installed CLI version.",
    examples: ["harness-anything version"],
    parse: parseVersionArgs,
    run: runVersionCommand,
    receiptContract: { data: ["version"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "entity-list",
    usage: "entity list [--json]",
    options: [{ flag: "--json", description: "Emit command-receipt/v2 JSON." }],
    summary: "List entity kinds derived from registered command descriptors.",
    examples: ["harness-anything entity list --json"],
    parse: parseCapabilitiesArgs,
    run: runCapabilitiesCommand,
    receiptContract: { data: ["rows", "report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "capabilities",
    usage: "capabilities [--kind <entity-kind>] [--json]",
    options: [{ flag: "--kind", description: "Filter capabilities by entity kind." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }],
    summary: "Describe entity operations, input schemas, shortcuts, and examples.",
    examples: ["harness-anything decision capabilities --json"],
    parse: parseCapabilitiesArgs,
    run: runCapabilitiesCommand,
    receiptContract: { data: ["rows", "report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "init",
    usage: "init [--name <name>] [--add-npm-scripts]",
    options: [{ flag: "--name", description: "Set the project name written to harness.yaml." }, { flag: "--add-npm-scripts", description: "Add npm script shortcuts during initialization." }],
    summary: "Create the harness directory layout and optional npm shortcuts.",
    examples: ["harness-anything init --name my-project --add-npm-scripts"],
    parse: parseCoreTaskArgs,
    run: runInitCommand,
    receiptContract: { data: ["generated", "report"], paths: ["primary", "config"] },
    eventPolicy: { conflictMarkerPreflight: true, runtimeEvent: "deferred" }
  },
  {
    kind: "task-create",
    usage: "task create --title <title> [--task-id <id>] [--completion-gate <gate-id>]... [--json]",
    options: [
      { flag: "--title", description: "Set the required replay/v1 task title." },
      { flag: "--task-id", description: "Set an explicit task id; otherwise the facade derives one from the operation identity." },
      { flag: "--completion-gate", description: "Declare a completion gate id; repeat for multiple gates." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "Create a task with the fixed replay/v1 graph.",
    examples: ["harness-anything task create --title \"Normalize CLI help\" --completion-gate G10"],
    parse: parseTaskLifecycleCommandArgs,
    run: runTaskLifecycleFacadeCommand,
    receiptContract: taskReceiptContract,
    eventPolicy: { conflictMarkerPreflight: true, runtimeEvent: "none" }
  },
  {
    kind: "task-start",
    usage: "task start <id> --execution-id <execution-id> [--json]",
    options: [
      { flag: "--execution-id", description: "Create exactly this Execution in the current implementation round." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "Atomically start an Execution with an actor-bound lease.",
    examples: ["harness-anything task start task_01ABC --execution-id execution_01ABC --json"],
    parse: parseTaskLifecycleCommandArgs,
    run: runTaskLifecycleFacadeCommand,
    receiptContract: executionReceiptContract,
    eventPolicy: { conflictMarkerPreflight: true, runtimeEvent: "none" }
  },
  {
    kind: "task-submit",
    usage: "task submit <id> --execution-id <execution-id> --claim <text> --commit-sha <40-sha> [--deliverable <text>]... [--evidence-ref <ref>]... [--verification <text>]... [--known-gap <text>]... [--residual-risk <text>]... [--json]",
    options: [
      { flag: "--execution-id", description: "Submit exactly this active Execution." },
      { flag: "--claim", description: "Record the submission claim." },
      { flag: "--commit-sha", description: "Record the full lowercase 40-character code commit SHA." },
      { flag: "--deliverable", description: "Record a deliverable; repeat as needed." },
      { flag: "--evidence-ref", description: "Record an evidence reference; repeat as needed." },
      { flag: "--verification", description: "Record a verification statement; repeat as needed." },
      { flag: "--known-gap", description: "Record a known gap; repeat as needed." },
      { flag: "--residual-risk", description: "Record a residual risk; repeat as needed." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "Submit the active Execution through its actor-bound lease.",
    examples: ["harness-anything task submit task_01ABC --execution-id execution_01ABC --claim \"ready\" --commit-sha 0123456789abcdef0123456789abcdef01234567"],
    parse: parseTaskLifecycleCommandArgs,
    run: runTaskLifecycleFacadeCommand,
    receiptContract: executionReceiptContract,
    eventPolicy: { conflictMarkerPreflight: true, runtimeEvent: "none" }
  },
  {
    kind: "task-review-execution",
    usage: "task review-execution <id> --execution-id <execution-id> (--anti-entropy-token <token> --anti-entropy-report <path> | --kind acceptance --verdict approved|dismissed --review-id <id> --reason <text> --commit-sha <40-sha> --iteration 0|1) [--json]",
    options: [
      { flag: "--execution-id", description: "Review exactly this submitted Execution." },
      { flag: "--anti-entropy-token", description: "Supply the signed frozen-report receipt token." },
      { flag: "--anti-entropy-report", description: "Supply the immutable anti-entropy report path." },
      { flag: "--kind", description: "Use acceptance for the acceptance review path." },
      { flag: "--verdict", description: "Use approved or dismissed for acceptance." },
      { flag: "--review-id", description: "Set the immutable acceptance review id." },
      { flag: "--reason", description: "Record the semantic review reason." },
      { flag: "--commit-sha", description: "Bind the review to the submitted code commit." },
      { flag: "--iteration", description: "Bind the review to iteration 0 or 1." },
      { flag: "--evidence-checked", description: "Record checked evidence; repeat as needed." },
      { flag: "--acknowledge-archive-warnings", description: "Acknowledge partial or unavailable session archives." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "Record a signed anti-entropy or explicit acceptance Review for one submitted Execution.",
    examples: ["harness-anything task review-execution task_01ABC --execution-id execution_01ABC --kind acceptance --verdict approved --review-id review_01ABC --reason \"accepted\" --commit-sha 0123456789abcdef0123456789abcdef01234567 --iteration 0"],
    parse: parseTaskLifecycleCommandArgs,
    run: runTaskLifecycleFacadeCommand,
    receiptContract: executionReceiptContract,
    eventPolicy: { conflictMarkerPreflight: true, runtimeEvent: "none" }
  },
  {
    kind: "task-complete",
    usage: "task complete <id> --execution-id <submitted-execution-id> [--gate-receipt <gate-id>:<receipt-ref>]... [--json]",
    options: [
      { flag: "--execution-id", description: "Complete against exactly this submitted Execution." },
      { flag: "--gate-receipt", description: "Supply one opaque receipt reference per declared completion gate." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "Complete a reviewed Execution after its declared completion gate receipt set matches exactly.",
    examples: ["harness-anything task complete task_01ABC --execution-id execution_01ABC --gate-receipt G10:artifacts/g10.json"],
    parse: parseTaskLifecycleCommandArgs,
    run: runTaskLifecycleFacadeCommand,
    receiptContract: executionReceiptContract,
    eventPolicy: { conflictMarkerPreflight: true, runtimeEvent: "none" }
  },
  {
    kind: "task-show",
    usage: "task show <id> [--json]",
    options: [{ flag: "--json", description: "Emit command-receipt/v2 JSON." }],
    summary: "Show the replay/v1 task projection without writing.",
    examples: ["harness-anything task show task_01ABC --json"],
    parse: parseTaskLifecycleCommandArgs,
    run: runTaskLifecycleFacadeCommand,
    receiptContract: taskReceiptContract,
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "relation-list",
    usage: "relation list [--entity <entity-ref>] [--source <entity-ref>] [--target <entity-ref>] [--type <type>] [--state active|retired] [--json]",
    options: [{ flag: "--entity", description: "Filter relation edges where either endpoint matches the entity ref." }, { flag: "--source", description: "Filter relation edges by source entity ref." }, { flag: "--target", description: "Set the relation target entity ref." }, { flag: "--type", description: "Filter relation edges by relation type." }, { flag: "--state", description: "Filter relation edges by relation state: active or retired." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }],
    summary: "List projected relation graph edges with source, target, type, state, owner, and source path filters.",
    examples: ["harness-anything relation list --entity task/task_01ABC --json"],
    parse: parseRelationArgs,
    run: runTaskQueryCommand,
    receiptContract: { data: ["rows", "report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  }
]);
