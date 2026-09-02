export type ReceiptGuidanceArgument = string | number | boolean | readonly string[];

export interface ReceiptGuidanceWhen {
  readonly [field: string]: string | number | boolean;
}

export const RECEIPT_GUIDANCE_KINDS = Object.freeze([
  "repository-diff-contract",
  "task-create-publish",
  "task-create-start",
  "receipt-query",
  "edit-plan",
  "pin-agenda",
  "ledger-managed",
] as const);
export type ReceiptGuidanceKind = (typeof RECEIPT_GUIDANCE_KINDS)[number];

export interface ReceiptGuidanceContractEntry {
  readonly kind: ReceiptGuidanceKind;
  readonly args: Readonly<Record<string, ReceiptGuidanceArgument>>;
  readonly when?: ReceiptGuidanceWhen;
}

export interface ActionReturnsContract {
  readonly schema: "action-result/v1";
  readonly fields: readonly string[];
  readonly guidance: readonly ReceiptGuidanceContractEntry[];
}

export const taskCreateReturnsContract: ActionReturnsContract = Object.freeze({
  schema: "action-result/v1",
  fields: Object.freeze([
    "outcome",
    "opId",
    "unmetCriteria",
    "effects",
    "updatedProjection",
    "rejectionExplanation",
    "nextActions",
    "guidance",
  ]),
  guidance: Object.freeze([
    Object.freeze({
      kind: "repository-diff-contract",
      args: Object.freeze({}),
      when: Object.freeze({ outputShape: "repository-diff" }),
    }),
    Object.freeze({
      kind: "task-create-publish",
      args: Object.freeze({}),
      when: Object.freeze({ dryRun: true }),
    }),
    Object.freeze({
      kind: "task-create-start",
      args: Object.freeze({ packagePath: "{packagePath}", taskId: "{taskId}" }),
      when: Object.freeze({ dryRun: false, "proof.canonicalVisible": true }),
    }),
    Object.freeze({
      kind: "receipt-query",
      args: Object.freeze({ opId: "{opId}" }),
      when: Object.freeze({ dryRun: false, "proof.canonicalVisible": false }),
    }),
    Object.freeze({ kind: "edit-plan", args: Object.freeze({ packagePath: "{packagePath}" }) }),
    Object.freeze({ kind: "pin-agenda", args: Object.freeze({ taskId: "{taskId}" }) }),
    Object.freeze({
      kind: "ledger-managed",
      args: Object.freeze({ fields: Object.freeze(["INDEX.md", "closeout.md"]) }),
    }),
  ]),
});
