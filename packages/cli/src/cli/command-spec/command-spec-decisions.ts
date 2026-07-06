import { defineCommandSpecs } from "./types.ts";

export const decisionsCommandSpecs = defineCommandSpecs([
  {
    "kind": "decision-list",
    "usage": "decision list [--search <text>] [--legacy-id E<n>] [--legacy-range E<n>-E<n>] [--state <state>] [--module <key>] [--product-line <key>] [--compact] [--json]",
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
    "usage": "decision propose --title <title> --question <text> --chosen <text> --rejected <text> --why-not <text> [--from-file <path>|--json-input <json>] [--id dec_x] [--risk-tier low|medium|high] [--urgency low|medium|high] [--module <key[,key]>] [--product-line <key[,key]>] [--proposed-by kind:id] [--arbiter kind:id] [--claim <text>]... [--non-load-bearing] [--evidence-relation <anchor>:<type>:<task|fact-ref>:<rationale>] [--body <text>] [--dry-run] [--json]",
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
