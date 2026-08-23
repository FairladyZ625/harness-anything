export type StatusEntity =
  | "Task"
  | "Decision"
  | "Execution"
  | "Lease"
  | "RelationEdge"
  | "Package"
  | "FactRecord"
  | "Review"
  | "RuntimeSession"
  | "WriteReceipt"
  | "Recovery"
  | "PresetRun"
  | "TaskCloseout"
  | "VerticalScript"
  | "LegacyFact"
  | "GuiAdapter"
  | "DaemonWire";

export type StatusDivergence = "entity-scoped" | "divergent";

export interface StatusWordRegistration {
  /** The literal status word, e.g. "active". */
  readonly word: string;
  readonly entity: StatusEntity;
  /** The entity field the word is a value of, e.g. "status" / "state" / "phase". */
  readonly field: string;
  /** One sentence: what the word means on this entity. */
  readonly meaning: string;
  /**
   * "divergent": the same word on other entities means a materially different
   * concept (rename candidate). "entity-scoped": same word elsewhere is the same
   * concept, an operational cousin, or unrelated-but-registered.
   */
  readonly divergence: StatusDivergence;
  /** Required for divergent words: why the collision stands and where a rename would go. */
  readonly resolution?: string;
}

export interface StatusVocabulary {
  /** Vocabulary id, e.g. "task.status". */
  readonly id: string;
  readonly entity: StatusEntity;
  readonly field: string;
  /** Repo-relative module that declares the vocabulary. */
  readonly module: string;
  /**
   * Declaration anchor: an exported const/type name, or "#fieldName" for an inline
   * `readonly` field union. Anchors with a runtime export are bijection-checked by
   * the gate; text anchors are text-checked.
   */
  readonly anchor: string;
  readonly words: readonly string[];
  /** Declared words are a subset of this vocabulary (derived/coarse/validator sets). */
  readonly subsetOf?: string;
  /** GUI mirror: words must equal the mirrored vocabulary's words plus `plusWords`. */
  readonly mirrorOf?: string;
  readonly plusWords?: readonly string[];
  readonly note?: string;
}
