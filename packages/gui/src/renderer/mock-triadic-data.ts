export type Priority = "low" | "medium" | "high";
export type DecisionState = "proposed" | "active" | "deferred" | "rejected" | "retired";
export type FactState = "live" | "invalidated" | "dangling";

export interface FactRecord {
  readonly id: string;
  readonly taskId: string;
  readonly text: string;
  readonly observedAt: string;
  readonly state: FactState;
  readonly source: string;
}

export interface DecisionRecord {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly state: DecisionState;
  readonly riskTier: Priority;
  readonly urgency: Priority;
  readonly chosen: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<{ readonly text: string; readonly whyNot: string }>;
  readonly factIds: ReadonlyArray<string>;
  readonly derivedTaskIds: ReadonlyArray<string>;
  readonly provenance: string;
  readonly readiness: "green" | "yellow" | "red";
  readonly readinessReason: string;
}

export interface RelationRecord {
  readonly from: string;
  readonly to: string;
  readonly type: "supports" | "derives" | "supersedes" | "invalidates";
  readonly rationale: string;
}

export const MOCK_FACTS: ReadonlyArray<FactRecord> = [
  {
    id: "task_gui_shell/F-7Q2K9ADJ",
    taskId: "task_gui_shell",
    text: "Electron renderer can consume the sandboxed preload bridge without Node globals.",
    observedAt: "2026-07-07T08:40:00.000Z",
    state: "live",
    source: "prototype evidence"
  },
  {
    id: "task_projection/F-4K7PGT2M",
    taskId: "task_projection",
    text: "Task projection rows are available through the local controller task bridge.",
    observedAt: "2026-07-07T09:05:00.000Z",
    state: "live",
    source: "projection read"
  },
  {
    id: "task_graph/F-91NQ88DW",
    taskId: "task_graph",
    text: "Relation graph read APIs exist below the application boundary but are not exposed by LocalControllerService.",
    observedAt: "2026-07-07T09:22:00.000Z",
    state: "live",
    source: "source inspection"
  },
  {
    id: "task_old_review/F-0MISSING",
    taskId: "task_old_review",
    text: "Legacy review workbench conflated task closeout and decision arbitration.",
    observedAt: "2026-07-02T11:00:00.000Z",
    state: "invalidated",
    source: "canonical IA"
  }
];

export const MOCK_DECISIONS: ReadonlyArray<DecisionRecord> = [
  {
    id: "dec_gui_ia_renderer",
    title: "Port operator IA into the Electron renderer",
    question: "Should the first GUI shell render the triadic operator IA instead of the static workspace demo?",
    state: "proposed",
    riskTier: "high",
    urgency: "high",
    chosen: ["Move the reference IA into renderer-owned React components and keep task data real."],
    rejected: [
      {
        text: "Keep a static shell until all triadic APIs exist.",
        whyNot: "It hides the product shape and makes GUI validation impossible."
      },
      {
        text: "Add private renderer-only decision APIs.",
        whyNot: "It violates the contract-owned bridge boundary."
      }
    ],
    factIds: ["task_gui_shell/F-7Q2K9ADJ", "task_projection/F-4K7PGT2M"],
    derivedTaskIds: [],
    provenance: "codex worker session · 2026-07-07",
    readiness: "yellow",
    readinessReason: "Decision/fact projection reads are not yet exposed at the application bridge."
  },
  {
    id: "dec_projection_read_surface",
    title: "Expose projection reads through application services",
    question: "What is needed before decision/fact GUI views can switch from mock to real data?",
    state: "proposed",
    riskTier: "high",
    urgency: "medium",
    chosen: ["Add read-only LocalControllerService methods for decision projection, relation graph, fact anchors, and coverage."],
    rejected: [
      {
        text: "Import kernel readers directly in the renderer.",
        whyNot: "The renderer must see serialized preload results, not kernel internals."
      }
    ],
    factIds: ["task_graph/F-91NQ88DW"],
    derivedTaskIds: [],
    provenance: "source inspection · 2026-07-07",
    readiness: "green",
    readinessReason: "Scope is a future backend slice, not this renderer port."
  },
  {
    id: "dec_review_split",
    title: "Keep A-axis closeout separate from B-axis arbitration",
    question: "Should task closeout and decision arbitration share one review surface?",
    state: "active",
    riskTier: "medium",
    urgency: "medium",
    chosen: ["Task closeout remains a mechanical task surface; decision arbitration gets its own inbox."],
    rejected: [
      {
        text: "Use one Review tab with task and decision queues.",
        whyNot: "It reintroduces the old task-only mental model."
      }
    ],
    factIds: ["task_old_review/F-0MISSING"],
    derivedTaskIds: [],
    provenance: "canonical IA · 2026-07-02",
    readiness: "red",
    readinessReason: "One referenced historical fact is marked invalidated."
  }
];

export const MOCK_RELATIONS: ReadonlyArray<RelationRecord> = [
  {
    from: "decision/dec_gui_ia_renderer/C1",
    to: "fact/task_gui_shell/F-7Q2K9ADJ",
    type: "supports",
    rationale: "The renderer bridge is the already shipped task data path."
  },
  {
    from: "decision/dec_gui_ia_renderer/C1",
    to: "fact/task_projection/F-4K7PGT2M",
    type: "supports",
    rationale: "The task list, board, and detail views can be wired now."
  },
  {
    from: "decision/dec_projection_read_surface/C1",
    to: "fact/task_graph/F-91NQ88DW",
    type: "supports",
    rationale: "The missing bridge surface is visible from source inspection."
  },
  {
    from: "decision/dec_review_split/C1",
    to: "fact/task_old_review/F-0MISSING",
    type: "supports",
    rationale: "Historical evidence explains the split, but the fact is not live."
  }
];

export function factById(factId: string): FactRecord | undefined {
  return MOCK_FACTS.find((fact) => fact.id === factId);
}
