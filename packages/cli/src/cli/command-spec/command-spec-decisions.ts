import { defineCommandSpecs } from "./types.ts";

export const decisionsCommandSpecs = defineCommandSpecs([
  {
    "kind": "decision-list",
    "usage": "decision list [--search <text>] [--legacy-id E<n>] [--legacy-range E<n>-E<n>] [--state <state>] [--module <key>] [--product-line <key>] [--compact] [--json]",
    "options": [{"flag":"--search","description":"Search task metadata and prose."},{"flag":"--legacy-id","description":"Filter decisions by migrated legacy E number, such as E72."},{"flag":"--legacy-range","description":"Filter decisions by an inclusive migrated legacy E-number range, such as E1-E71."},{"flag":"--state","description":"Filter decisions by decision state."},{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--product-line","description":"Attach a comma-separated product line list to a decision."},{"flag":"--compact","description":"Return only cold-start summary fields for list commands."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List decision question/chosen/rejected summaries for cold-start review.",
    "examples": ["harness-anything decision list --state active --module m5-circulation --legacy-range E1-E71 --compact --json"],
    "parserId": "decision",
    "runnerId": "decision",
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
    "parserId": "decision",
    "runnerId": "decision",
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
    "kind": "decision-propose",
    "usage": "decision propose --title <title> --question <text> --chosen <text|json>... --rejected <text|json>... --why-not <text> [--from-file <path>|--json-input <json>] [--id dec_x] [--risk-tier low|medium|high] [--urgency low|medium|high] [--module <key[,key]>] [--product-line <key[,key]>] [--proposed-by kind:id] [--arbiter kind:id] [--claim <text>]... [--non-load-bearing] [--evidence-relation <anchor>:<type>:<task|fact-ref>:<rationale>] [--body <text>] [--dry-run] [--json]",
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--question","description":"Set the decision question being answered."},{"flag":"--chosen","description":"Set the selected decision option text."},{"flag":"--rejected","description":"Set a rejected decision option text."},{"flag":"--why-not","description":"Set the rationale for rejecting the alternative."},{"flag":"--from-file","description":"Read command input JSON from a file; flags remain shortcut overrides."},{"flag":"--json-input","description":"Read command input JSON from an inline string; flags remain shortcut overrides."},{"flag":"--id","description":"Set the explicit entity id when the command supports one."},{"flag":"--risk-tier","description":"Set decision risk tier: low, medium, or high."},{"flag":"--urgency","description":"Set decision urgency: low, medium, or high."},{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--product-line","description":"Attach a comma-separated product line list to a decision."},{"flag":"--proposed-by","description":"Set the decision proposer as agent:<id>, human:<id>, or system:<id>."},{"flag":"--arbiter","description":"Set the decision arbiter as agent:<id>, human:<id>, or system:<id>."},{"flag":"--claim","description":"Set the primary supporting claim text for a decision."},{"flag":"--non-load-bearing","description":"Mark the proposed primary claim, or an existing amended claim, as exempt from reckon coverage."},{"flag":"--evidence-relation","description":"Attach a decision anchor to a task, decision, or fact ref as anchor:type:target:rationale; repeat for multiple relations."},{"flag":"--body","description":"Set authored body content for the generated decision document."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Create a proposed decision with optional typed evidence relations through the decision write service.",
    "examples": ["harness-anything decision propose --title \"Adopt CLI decision loop\" --question \"Should M3 expose decision CLI?\" --chosen \"Expose it\" --rejected \"Keep write API only\" --why-not \"No human fallback path\" --evidence-relation C1:supersedes-fact:fact/task_01ABC/F-1234ABCD:\"Evidence covers C1.\""],
    "parserId": "decision",
    "runnerId": "decision",
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
    "usage": "decision accept <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--judgment-only <rationale>] [--dry-run] [--json]",
    "options": [{"flag":"--arbiter","description":"Set the decision arbiter as agent:<id>, human:<id>, or system:<id>."},{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--judgment-only","description":"Accept a decision without evidence only with an explicit recorded rationale."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Accept a proposed decision through the decision write service after the non-empty evidence floor or an explicit judgment-only rationale.",
    "examples": ["harness-anything decision accept dec_01ABC --arbiter human:ZeyuLi"],
    "parserId": "decision",
    "runnerId": "decision",
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
    "usage": "decision reject <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--arbiter","description":"Set the decision arbiter as agent:<id>, human:<id>, or system:<id>."},{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Reject a proposed decision through the decision write service.",
    "examples": ["harness-anything decision reject dec_01ABC --arbiter human:ZeyuLi"],
    "parserId": "decision",
    "runnerId": "decision",
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
    "usage": "decision defer <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--arbiter","description":"Set the decision arbiter as agent:<id>, human:<id>, or system:<id>."},{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Defer a proposed decision through the decision write service.",
    "examples": ["harness-anything decision defer dec_01ABC --arbiter human:ZeyuLi"],
    "parserId": "decision",
    "runnerId": "decision",
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
    "usage": "decision supersede <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--arbiter","description":"Set the decision arbiter as agent:<id>, human:<id>, or system:<id>."},{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Supersede a decision through the decision write service.",
    "examples": ["harness-anything decision supersede dec_01ABC --arbiter human:ZeyuLi"],
    "parserId": "decision",
    "runnerId": "decision",
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
    "usage": "decision amend <decision-id> [--title <title>] [--load-bearing <claim-id>|--non-load-bearing <claim-id>] [--set <field>:<value>] [--append <field>:<json>] [--body <text>] [--dry-run] [--json]",
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--load-bearing","description":"Mark an existing claim as covered by the reckon gate during decision amend."},{"flag":"--non-load-bearing","description":"Mark the proposed primary claim, or an existing amended claim, as exempt from reckon coverage."},{"flag":"--set","description":"Replace a schema-declared amendable field value."},{"flag":"--append","description":"Append a JSON value to a schema-declared amendable field."},{"flag":"--body","description":"Set authored body content for the generated decision document."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Amend a decision without changing its lifecycle state.",
    "examples": ["harness-anything decision amend dec_01ABC --set title:\"Updated title\""],
    "parserId": "decision",
    "runnerId": "decision",
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
    "parserId": "decision",
    "runnerId": "decision",
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
    "parserId": "decision",
    "runnerId": "decision",
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
    "parserId": "decision",
    "runnerId": "decision",
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
    "parserId": "decision",
    "runnerId": "decision",
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
    "usage": "decision retire <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]",
    "options": [{"flag":"--arbiter","description":"Set the decision arbiter as agent:<id>, human:<id>, or system:<id>."},{"flag":"--decided-at","description":"Set the decision timestamp for transition commands."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Retire a decision through the decision write service.",
    "examples": ["harness-anything decision retire dec_01ABC --arbiter human:ZeyuLi"],
    "parserId": "decision",
    "runnerId": "decision",
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
    "parserId": "record",
    "runnerId": "fact",
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
    "parserId": "record",
    "runnerId": "fact",
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
    "summary": "Record a stable task-local fact anchor through the fact write service.",
    "examples": ["harness-anything fact record --task task_01ABC --statement \"CLI fallback passed\" --source \"manual verification\" --confidence high"],
    "parserId": "record",
    "runnerId": "fact",
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
    "parserId": "record",
    "runnerId": "fact",
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
    "parserId": "distill",
    "runnerId": "distill",
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
    "summary": "Commit an explicit distill candidate claim through the fact write service.",
    "examples": ["harness-anything distill promote --task task_01ABC --candidate .harness/generated/distill/task_01ABC/distill_123.json --claim \"Distilled claim\" --memory-class semantic"],
    "parserId": "distill",
    "runnerId": "distill",
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
