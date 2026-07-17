import { defineCommandSpecs } from "./types.ts";
import { parseDecisionArgs } from "../parsers/decision.ts";
import { parseDistillArgs } from "../parsers/distill.ts";
import { parseRecordArgs } from "../parsers/record.ts";
import { runDecisionCommand } from "../../commands/core/decision.ts";
import { runDistillCommand } from "../../commands/core/distill.ts";
import { runFactCommand } from "../../commands/core/fact.ts";

export const decisionsCommandSpecs = defineCommandSpecs([
  {
    "kind": "decision-list",
    "usage": "decision list [--search <text>] [--legacy-id E<n>] [--legacy-range E<n>-E<n>] [--state <state>] [--module <key>] [--product-line <key>] [--compact] [--json]",
    "options": [{"flag":"--search","description":"Search task metadata and prose."},{"flag":"--legacy-id","description":"Filter decisions by migrated legacy E number, such as E72."},{"flag":"--legacy-range","description":"Filter decisions by an inclusive migrated legacy E-number range, such as E1-E71."},{"flag":"--state","description":"Filter decisions by decision state."},{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--product-line","description":"Attach a comma-separated product line list to a decision."},{"flag":"--compact","description":"Return only cold-start summary fields for list commands."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List decision question/chosen/rejected summaries for cold-start review.",
    "examples": ["harness-anything decision list --state active --module m5-circulation --legacy-range E1-E71 --compact --json"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "decision-show",
    "usage": "decision show <decision-id|E<n>> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Show one decision summary by decision id or legacy E number.",
    "examples": ["harness-anything decision show E72 --json"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "decision-verify",
    "usage": "decision verify <decision-id>|--all [--json]",
    "options": [{"flag":"--all","description":"Verify every decision that carries a content pin."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Recompute the last versioned decision content pin and report Git-attributed mismatch warnings without modifying the ledger.",
    "examples": ["harness-anything decision verify dec_01ABC --json", "harness-anything decision verify --all --json"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": [],
      "optionalData": {"decisionId":"Only emitted when verifying one decision; --all emits aggregate rows without a single decision id."}
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "decision-repin",
    "usage": "decision repin <decision-id> --migration-evidence task/<task-id>/<audit-marker> [--json]",
    "options": [{"flag":"--migration-evidence","description":"Bind the additive re-pin to an auditable migration task reference."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Append a current v1 content pin to a verified stale decision through migration-attributed coordination.",
    "examples": ["harness-anything decision repin dec_01ABC --migration-evidence task/task_01ABC/amend-after-pin --json"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-propose",
    "usage": "decision propose --title <title> --question <text> --chosen <text|json>... --rejected <text|json>... [--why-not <fallback-for-text-rejections>] [--from-file <path>|--json-input <json>] [--id dec_x] [--risk-tier low|medium|high] [--urgency low|medium|high] [--module <key[,key]>] [--product-line <key[,key]>] [--claim <text>]... [--fulfillment <claim-id>:<mode>]... [--non-load-bearing] [--evidence-relation <anchor>:<type>:<task|fact-ref>:<rationale>] [--body <text>|--body-file <path>] [--dry-run] [--json]",
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--question","description":"Set the decision question being answered."},{"flag":"--chosen","description":"Add a chosen option; repeat independently for every chosen option."},{"flag":"--rejected","description":"Add a rejected option; repeat independently and use JSON to carry its own why_not."},{"flag":"--why-not","description":"Set the fallback rationale applied to text-only rejected options."},{"flag":"--from-file","description":"Read command input JSON from a file; flags remain shortcut overrides."},{"flag":"--json-input","description":"Read command input JSON from an inline string; flags remain shortcut overrides."},{"flag":"--id","description":"Set the explicit entity id when the command supports one."},{"flag":"--risk-tier","description":"Set decision risk tier: low, medium, or high."},{"flag":"--urgency","description":"Set decision urgency: low, medium, or high."},{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--product-line","description":"Attach a comma-separated product line list to a decision."},{"flag":"--claim","description":"Set the primary supporting claim text for a decision."},{"flag":"--fulfillment","description":"Declare one claim fulfillment mode as claim-id:evidenced, claim-id:delivered, or claim-id:standing-policy."},{"flag":"--non-load-bearing","description":"Mark the proposed primary claim, or an existing amended claim, as exempt from reckon coverage."},{"flag":"--evidence-relation","description":"Attach a decision anchor to a task, decision, or fact ref as anchor:type:target:rationale; repeat for multiple relations."},{"flag":"--body","description":"Set authored body content for the generated decision document; mutually exclusive with --body-file."},{"flag":"--body-file","description":"Read authored body markdown from a file; mutually exclusive with --body."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Create a proposed decision with optional typed evidence relations through the decision write service.",
    "examples": ["harness-anything decision propose --title \"Adopt CLI decision loop\" --question \"Should M3 expose decision CLI?\" --chosen \"Expose it\" --rejected \"Keep write API only\" --why-not \"No human fallback path\" --evidence-relation C1:supersedes-fact:fact/task_01ABC/F-1234ABCD:\"Evidence covers C1.\""],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-accept",
    "usage": "decision accept <decision-id> [--decided-at <iso>] [--judgment-only <rationale>] [--standing-policy] [--fulfillment <claim-id>:<mode>]... [--dry-run] [--json]",
    "options": [{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--judgment-only","description":"Accept a decision without evidence only with an explicit recorded rationale."},{"flag":"--standing-policy","description":"Classify the accepted decision as a standing policy."},{"flag":"--fulfillment","description":"Declare one claim fulfillment mode as claim-id:evidenced, claim-id:delivered, or claim-id:standing-policy."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Accept a proposed decision through the decision write service after the non-empty evidence floor or an explicit judgment-only rationale.",
    "examples": ["harness-anything decision accept dec_01ABC"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-reject",
    "usage": "decision reject <decision-id> [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Reject a proposed decision through the decision write service.",
    "examples": ["harness-anything decision reject dec_01ABC"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-defer",
    "usage": "decision defer <decision-id> [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Defer a proposed decision through the decision write service.",
    "examples": ["harness-anything decision defer dec_01ABC"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-supersede",
    "usage": "decision supersede <decision-id> [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Supersede a decision through the decision write service.",
    "examples": ["harness-anything decision supersede dec_01ABC"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-amend",
    "usage": "decision amend <decision-id> [--title <title>] [--standing-policy] [--fulfillment <claim-id>:<mode>]... [--load-bearing <claim-id>|--non-load-bearing <claim-id>] [--set <field>:<value>] [--append <field>:<json>] [--body <text>|--body-file <path>] [--dry-run] [--json]",
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--standing-policy","description":"Classify the decision as a standing policy."},{"flag":"--fulfillment","description":"Declare one claim fulfillment mode as claim-id:evidenced, claim-id:delivered, or claim-id:standing-policy."},{"flag":"--load-bearing","description":"Mark an existing claim as covered by the reckon gate during decision amend."},{"flag":"--non-load-bearing","description":"Mark the proposed primary claim, or an existing amended claim, as exempt from reckon coverage."},{"flag":"--set","description":"Replace a schema-declared amendable field value."},{"flag":"--append","description":"Append a JSON value to a schema-declared amendable field."},{"flag":"--body","description":"Set authored body content for the generated decision document; mutually exclusive with --body-file."},{"flag":"--body-file","description":"Read authored body markdown from a file; mutually exclusive with --body."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Amend a decision without changing its lifecycle state.",
    "examples": ["harness-anything decision amend dec_01ABC --set title:\"Updated title\""],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-relate",
    "usage": "decision relate <decision-id> --anchor <CH1|RJ1|C1> --type <supports|supersedes|refines|narrows|derives|blocks|relates|implements|produces|evidences|evidenced-by|invalidated-by|supersedes-fact> --target <entity-ref> --rationale <text> [--body <text>] [--dry-run] [--json]; derives->task seeds missing task risk-tier/urgency once, not live sync",
    "options": [{"flag":"--anchor","description":"Select the decision anchor id used as a relation source."},{"flag":"--type","description":"Set the relation type for the new decision edge."},{"flag":"--target","description":"Set the relation target entity ref."},{"flag":"--rationale","description":"Record the rationale for a relation or generated decision."},{"flag":"--body","description":"Set authored body content for the generated decision document."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Append a typed relation record to a decision through the relation-specific write surface.",
    "examples": ["harness-anything decision relate dec_01ABC --anchor CH1 --type supersedes --target decision/dec_00XYZ --rationale \"Newer decision supersedes the old storage claim.\""],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-reckon",
    "usage": "decision reckon <decision-id> --task <task-id> [--dry-run] [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Evaluate load-bearing decision claim coverage and record the verdict as a task-local fact.",
    "examples": ["harness-anything decision reckon dec_01ABC --task task_01ABC"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "taskId", "factId", "factRef", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-relation-retire",
    "usage": "decision relation retire <decision-id> --relation <relation-id> [--body <text>] [--dry-run] [--json]",
    "options": [{"flag":"--relation","description":"Select a hosted relation id."},{"flag":"--body","description":"Set authored body content for the generated decision document."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Retire a hosted decision relation by rewriting the source decision frontmatter.",
    "examples": ["harness-anything decision relation retire dec_01ABC --relation rel_0123456789abcdef"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-relation-replace",
    "usage": "decision relation replace <decision-id> --relation <relation-id> --anchor <CH1|RJ1|C1> --type <supports|supersedes|refines|narrows|derives|blocks|relates|implements|produces|evidences|evidenced-by|invalidated-by|supersedes-fact> --target <entity-ref> --rationale <text> [--body <text>] [--dry-run] [--json]; derives->task seeds missing task risk-tier/urgency once, not live sync",
    "options": [{"flag":"--relation","description":"Select a hosted relation id."},{"flag":"--anchor","description":"Select the decision anchor id used as a relation source."},{"flag":"--type","description":"Set the relation type for the replacement decision edge."},{"flag":"--target","description":"Set the relation target entity ref."},{"flag":"--rationale","description":"Record the rationale for a relation or generated decision."},{"flag":"--body","description":"Set authored body content for the generated decision document."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Replace a hosted decision relation by retiring the old edge and appending a new edge.",
    "examples": ["harness-anything decision relation replace dec_01ABC --relation rel_0123456789abcdef --anchor CH1 --type relates --target decision/dec_00XYZ --rationale \"Replacement edge.\""],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "decision-retire",
    "usage": "decision retire <decision-id> [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Retire a decision through the decision write service.",
    "examples": ["harness-anything decision retire dec_01ABC"],
    "parse": parseDecisionArgs,
    "run": runDecisionCommand,
    "receiptContract": {
      "data": ["decisionId", "decisionState", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "fact-list",
    "usage": "fact list --task <task-id> [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List task-local fact anchors from the facts document.",
    "examples": ["harness-anything fact list --task task_01ABC --json"],
    "parse": parseRecordArgs,
    "run": runFactCommand,
    "receiptContract": {
      "data": ["taskId", "rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "fact-show",
    "usage": "fact show --task <task-id> --id <fact-id> [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--id","description":"Set the explicit entity id when the command supports one."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Show one task-local fact anchor by id.",
    "examples": ["harness-anything fact show --task task_01ABC --id F-DEADBEEF --json"],
    "parse": parseRecordArgs,
    "run": runFactCommand,
    "receiptContract": {
      "data": ["taskId", "factId", "factRef", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "record-fact",
    "usage": "fact record --task <task-id> --statement <text> --source <text> [--from-file <path>|--json-input <json>] [--id F-DEADBEEF] [--confidence low|medium|high] [--memory-class semantic|episodic|procedural] [--memory-tag <tag>] [--observed-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--statement","description":"Set the fact statement text."},{"flag":"--source","description":"Set the fact evidence source text."},{"flag":"--from-file","description":"Read command input JSON from a file; flags remain shortcut overrides."},{"flag":"--json-input","description":"Read command input JSON from an inline string; flags remain shortcut overrides."},{"flag":"--id","description":"Set the explicit entity id when the command supports one."},{"flag":"--confidence","description":"Set fact confidence as low, medium, or high."},{"flag":"--memory-class","description":"Classify fact memory as semantic, episodic, or procedural."},{"flag":"--memory-tag","description":"Attach a fact memory tag; repeat or comma-separate values."},{"flag":"--observed-at","description":"Set the observation timestamp for a fact record."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["record fact --task <task-id> (deprecated, use fact record; retires at E77/F6 acceptance)"],
    "aliasDisplay": {"record fact --task <task-id> (deprecated, use fact record; retires at E77/F6 acceptance)":"hidden"},
    "summary": "Record a stable task-local fact anchor through the fact write service.",
    "examples": ["harness-anything fact record --task task_01ABC --statement \"CLI fallback passed\" --source \"manual verification\" --confidence high"],
    "parse": parseRecordArgs,
    "run": runFactCommand,
    "receiptContract": {
      "data": ["taskId", "factId", "factRef", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "fact-invalidate",
    "usage": "fact invalidate --task <task-id> --id <fact-id> --by <fact-id> --rationale <text> [--dry-run] [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--id","description":"Set the explicit entity id when the command supports one."},{"flag":"--by","description":"Set the replacing task or invalidating fact id."},{"flag":"--rationale","description":"Record the rationale for a relation or generated decision."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Invalidate a task-local fact by recording a superseding fact relation through the fact write service.",
    "examples": ["harness-anything fact invalidate --task task_01ABC --id F-DEADBEEF --by F-FEEDFACE --rationale \"New fact supersedes old fact\""],
    "parse": parseRecordArgs,
    "run": runFactCommand,
    "receiptContract": {
      "data": ["taskId", "factId", "factRef", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "distill-candidate",
    "usage": "distill candidate --task <task-id> --input <path> [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--input","description":"Provide an input path or one script input as key=value; repeat for script inputs."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Create a generated distill candidate artifact without recording a fact.",
    "examples": ["harness-anything distill candidate --task task_01ABC --input artifacts/transcript.md --json"],
    "parse": parseDistillArgs,
    "run": runDistillCommand,
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "distill-commit",
    "usage": "distill promote --task <task-id> --candidate <path> --claim <text> [--id F-DEADBEEF] [--confidence low|medium|high] [--memory-class semantic|episodic|procedural] [--memory-tag <tag>] [--observed-at <iso>] [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--candidate","description":"Read a generated distill candidate artifact."},{"flag":"--claim","description":"Set the primary supporting claim text for a decision."},{"flag":"--id","description":"Set the explicit entity id when the command supports one."},{"flag":"--confidence","description":"Set fact confidence as low, medium, or high."},{"flag":"--memory-class","description":"Classify fact memory as semantic, episodic, or procedural."},{"flag":"--memory-tag","description":"Attach a fact memory tag; repeat or comma-separate values."},{"flag":"--observed-at","description":"Set the observation timestamp for a fact record."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["distill commit --task <task-id> (deprecated, use distill promote; retires at E77/F6 acceptance)"],
    "aliasDisplay": {"distill commit --task <task-id> (deprecated, use distill promote; retires at E77/F6 acceptance)":"hidden"},
    "summary": "Commit an explicit distill candidate claim through the fact write service.",
    "examples": ["harness-anything distill promote --task task_01ABC --candidate .harness/generated/distill/task_01ABC/distill_123.json --claim \"Distilled claim\" --memory-class semantic"],
    "parse": parseDistillArgs,
    "run": runDistillCommand,
    "receiptContract": {
      "data": ["taskId", "factId", "factRef", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  }
]);
