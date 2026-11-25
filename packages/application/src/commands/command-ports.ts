import type {
  ActorIdentity,
  AuthorizationDecision,
  CanonicalEventAppendReceipt,
  CanonicalEventCut,
  CanonicalEventStore,
  CompletionEvidenceV1,
  ReceiptDiagnostic,
  RuntimeExecutionPrincipal,
  TaskEventV1,
  TaskLifecycleSnapshot,
  TaskProjection,
  WriteReceiptDraft,
  WriteSource,
} from "@harness-anything/kernel";

export type CommandAction = Readonly<Record<string, unknown>> & { readonly kind: string };

export interface CommandBinding {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly authorizationDecision?: AuthorizationDecision;
  readonly executionPrincipal?: RuntimeExecutionPrincipal;
  readonly personIdentityWitnesses?: ReadonlyMap<string, string>;
}

export interface PublicPublication {
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
}

export type TaskCreateReceipt = WriteReceiptDraft & {
  readonly taskId: string;
};

export interface CommandOperationPort {
  readonly input: { readonly repoId: string };
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly operationId: (
    action: CommandAction,
    binding: CommandBinding,
    workspaceId: string,
    expectedRevision: number,
  ) => string;
  readonly cellCodedError: (code: string, message: string, diagnostic?: ReceiptDiagnostic) => Error;
  readonly requiredCellText: (value: unknown, name: string) => string;
}

export interface EntityPinCommandCell extends CommandOperationPort {
  readonly settings: { readonly readRepository: () => { readonly agenda: { readonly pinLimit: number } } };
  readonly publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => PublicPublication;
}

export interface TaskWitnessCommandCell extends CommandOperationPort {
  readonly publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => PublicPublication;
  readonly receiptProof: (
    event: { readonly opId: string; readonly workspaceRevision: number },
    publication: PublicPublication,
  ) => NonNullable<WriteReceiptDraft["proof"]>;
  readonly lifecycleReceipt: (
    event: TaskEventV1,
    snapshot: TaskLifecycleSnapshot,
    publication: PublicPublication,
    proof: NonNullable<WriteReceiptDraft["proof"]>,
    authorizationDecision?: WriteReceiptDraft["authorizationDecision"],
  ) => WriteReceiptDraft;
  readonly publishGateWitness: (
    taskId: string,
    executionId: string,
    snapshot: TaskLifecycleSnapshot,
    packagePath: string | null,
    binding: CommandBinding,
    evidence: CompletionEvidenceV1,
  ) => WriteReceiptDraft;
}

export interface AssignmentMigrationCommandCell extends CommandOperationPort {
  readonly previewResult: (opId: string, value: object, revision: number, command: string) => WriteReceiptDraft;
  readonly readResult: (
    opId: string,
    value: object,
    revision: number,
    worktreeVisible: boolean | null,
  ) => WriteReceiptDraft;
}

export interface VerticalKindReadPort {
  readonly read: (method: "repo.vertical.declaration.read") => Promise<unknown>;
}

export interface SubmissionArtifactCell {
  readonly store: Pick<
    CanonicalEventStore,
    "readContentBlob" | "readContentBlobRange" | "readContentBlobSize" | "readEventAtRevision"
  >;
  readonly cellCodedError: CommandOperationPort["cellCodedError"];
}
