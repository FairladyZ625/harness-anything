import type {
  DecisionPackage,
  EntityRelationRecord,
  HarnessLayoutInput,
  ProvenancePayload,
} from "@harness-anything/kernel";
import type { DecisionCreateInput } from "../decision-write-service.ts";
import type {
  AuthorityHostCommand,
  AuthorityHostCommandAction,
  AuthorityHostDecisionProposeAction,
  AuthorityHostNewTaskAction,
  AuthorityIngressAdapter
} from "./daemon-host-contract.ts";

export type ProductionAuthorityCommand = AuthorityHostCommand;
export type ProductionAuthorityCommandAction = AuthorityHostCommandAction;
export type ProductionAuthorityDecisionProposeAction = AuthorityHostDecisionProposeAction;
export type ProductionAuthorityNewTaskAction = AuthorityHostNewTaskAction;

export type ProductionAuthorityIngressDisposition =
  | { readonly status: "typed-v2"; readonly adapter: AuthorityIngressAdapter }
  | { readonly status: "excluded"; readonly decisionRef: string; readonly reason: string };

export interface ProductionAuthorityTaskCreateWrite {
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

export interface ProductionAuthorityCompilerHostServices {
  readonly productionAuthorityIngressFor: (kind: string) => ProductionAuthorityIngressDisposition | undefined;
  readonly normalizeDecisionProposeAction: (action: ProductionAuthorityDecisionProposeAction) => ProductionAuthorityDecisionProposeAction;
  readonly normalizedFactSource: (action: Extract<ProductionAuthorityCommandAction, { readonly kind: "record-fact" }>) => string;
  readonly buildTaskCreateWrites: (input: {
    readonly rootInput: HarnessLayoutInput;
    readonly action: ProductionAuthorityNewTaskAction;
    readonly createdAt: string;
    readonly provenance: ProvenancePayload;
  }) =>
    | { readonly ok: true; readonly writes: ReadonlyArray<ProductionAuthorityTaskCreateWrite> }
    | { readonly ok: false; readonly settingsErrorCode?: string };
  readonly materializeProposedDecision: (action: ProductionAuthorityDecisionProposeAction) =>
    | { readonly ok: true; readonly decision: DecisionCreateInput }
    | { readonly ok: false; readonly reason: string };
  readonly decisionRelationRecord: (input: {
    readonly decisionId: string;
    readonly anchor: string;
    readonly target: string;
    readonly relationType: EntityRelationRecord["type"];
    readonly rationale: string;
  }) => EntityRelationRecord;
  readonly materializedTaskPriorityWrites: (
    rootInput: HarnessLayoutInput,
    decision: DecisionPackage,
    relation: EntityRelationRecord
  ) =>
    | { readonly ok: true; readonly writes: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }> }
    | { readonly ok: false; readonly error: { readonly hint: string } };
  readonly renderForceStatusAudit: (status: string, reason: string, recordedAt?: string) => string;
}

export interface ProductionAuthorityIdentityHostService<Identity> {
  readonly loadDaemonIdentity: (
    rootDir: string,
    layoutOverrides: { readonly authoredRoot?: string } | undefined,
    endpoint?: string,
    userRoot?: string
  ) => Identity;
}

export type ProductionAuthorityHostServices<Identity> =
  & ProductionAuthorityCompilerHostServices
  & ProductionAuthorityIdentityHostService<Identity>;
