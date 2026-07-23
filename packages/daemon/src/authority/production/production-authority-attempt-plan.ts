import { randomBytes, randomUUID } from "node:crypto";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  assertMutationClaimMatchesV2,
  canonicalPayloadDigestV2,
  decodeSemanticMutationEnvelopeV2,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  operationIdDiagnosticV2,
  sameProtocolSchemaTupleV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  validateEnvelopeBindingV2,
  verifyActorAxesBindingV2,
  type AuthorizedOperationAttemptV2,
  type ProductionAuthorityCommand,
  type SemanticMutationEnvelopeV2
} from "@harness-anything/application";
import {
  encodeCanonicalCbor,
  semanticMutationWireV2,
  stableStringify,
  type CanonicalCborValue,
  type RegistryEntityRefV2,
  type WriteAttribution,
  type WriteOp
} from "@harness-anything/kernel";
import type { AuthorityConnectionContext } from "../../protocol/connection-context.ts";
import type { DaemonAuthorityAttemptCompilerV2 } from "../authority-command-submission.ts";
import {
  openAuthorityProductionKeyMaterial,
  type AuthorityProductionRepoConfigV1,
  type DurableAuthorityBindingRuntimeV2
} from "./authority-production-state.ts";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";
import { executorDerivedFromPresetScript } from "./production-authority-script-ingest.ts";
import {
  decodeRepoWriteOutcomeV1,
  type RepoWriteProceedingOutcomeV1
} from "../../runtime/repo-write-outcome-schema.ts";

type KeyMaterial = ReturnType<typeof openAuthorityProductionKeyMaterial>;
type CanonicalCompileInput =
  Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0];

export const productionAuthorityAttemptPlanV1Schema =
  "production-authority-attempt-plan/v1" as const;

/** JSON-safe recovery material fixed before the outer operation may proceed. */
export interface ProductionAuthorityAttemptPlanV1 {
  readonly schema: typeof productionAuthorityAttemptPlanV1Schema;
  readonly commandKind: ProductionAuthorityCommand["action"]["kind"];
  readonly targetEntityId: string;
  readonly requestId: string;
  readonly innerOpId: string;
  readonly semanticDigest: string;
  readonly tokenId: string;
  readonly bindingId: string;
  readonly plannedAtMs: string;
  readonly expiresAtMs: string;
  readonly presentationTokenBase64url: string;
  readonly envelopeBase64url: string;
  readonly attribution: WriteAttribution;
}

export interface ProductionAuthorityProgressAppendPlanV1
  extends ProductionAuthorityAttemptPlanV1 {
  readonly commandKind: "progress-append";
}

export interface ProductionAuthorityOuterRecoveryWitnessV1 {
  readonly outerOpId: string;
  readonly outerRequestDigest: string;
  readonly outerGeneration: number;
}

export interface ProductionAuthorityAttemptPlanner {
  readonly planIntent: (
    command: ProductionAuthorityCommand,
    attribution: CanonicalCompileInput["attribution"],
    currentSession: CanonicalCompileInput["currentSession"],
    canonicalEntityId: WriteOp["entityId"],
    intent: CanonicalAttemptIntent | null
  ) => Promise<ProductionAuthorityAttemptPlanV1>;
  readonly activatePlan: (
    plan: ProductionAuthorityAttemptPlanV1
  ) => AuthorizedOperationAttemptV2;
  readonly activateRecoveryPlan: (
    plan: ProductionAuthorityAttemptPlanV1,
    witness: ProductionAuthorityOuterRecoveryWitnessV1
  ) => Promise<AuthorizedOperationAttemptV2>;
}

export function createProductionAuthorityAttemptPlanner(input: {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly keyStore: KeyMaterial["keyStore"];
  readonly keyRegistry: KeyMaterial["registry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly context: AuthorityConnectionContext;
  readonly nowMs?: () => number;
  readonly randomUuid?: () => string;
  readonly random128?: () => Uint8Array;
  /**
   * Loads the exact fsynced PROCEEDING row and invokes the consumer while the
   * current daemon generation fence remains held.
   */
  readonly runAuthorizedRecoveryPlan?: <Result>(
    witness: ProductionAuthorityOuterRecoveryWitnessV1,
    useDurableProceeding: (outcome: RepoWriteProceedingOutcomeV1) => Result
  ) => Promise<Result>;
}): ProductionAuthorityAttemptPlanner {
  const nowMs = input.nowMs ?? Date.now;
  const newUuid = input.randomUuid ?? randomUUID;
  const newRandom128 = input.random128 ?? (() => randomBytes(16));
  return {
    planIntent: async (
      command,
      attribution,
      currentSession,
      canonicalEntityId,
      intent
    ) => {
      if (!intent) {
        throw new Error(`AUTHORITY_TYPED_COMMAND_UNSUPPORTED:${command.action.kind}`);
      }
      if (canonicalEntityId !== intent.physicalEntityId) {
        throw new Error(
          `AUTHORITY_CANONICAL_ENTITY_MISMATCH:submittedEntityId=${canonicalEntityId};intentEntityId=${intent.physicalEntityId}`
        );
      }
      const executorAgentId = attribution.executor?.id ?? null;
      if (executorAgentId && !input.config.allowedExecutorAgentIds.includes(executorAgentId)
        && !executorDerivedFromPresetScript(command, executorAgentId)) {
        throw new Error("AUTHORITY_EXECUTOR_NOT_SERVER_APPROVED");
      }
      const now = nowMs();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error("AUTHORITY_ATTEMPT_PLAN_TIME_INVALID");
      }
      const allowedEntityKinds = canonicalBindingTextSet(
        intent.mutations.map((mutation) => mutation.entity.entityKind)
      );
      const allowedActions = canonicalBindingTextSet(
        intent.mutations.map((mutation) => mutation.action)
      );
      const resourceScopes = canonicalBindingResourceScopes([
        ...intent.mutations.map((mutation) => ({
          kind: "entity-ref" as const,
          entityRef: mutation.entity
        })),
        ...intent.portablePaths.map((portablePath) => ({
          kind: "portable-path" as const,
          path: portablePath
        }))
      ]);
      const claims = {
        tokenId: `${input.config.admissionTokenRef}:${newUuid()}`,
        bindingId: `binding:${newUuid()}`,
        principalPersonId: input.context.actor.personId,
        executorAgentId,
        workspaceId: input.config.workspaceId,
        deviceId: input.config.deviceId,
        viewId: input.config.viewId,
        sessionId: currentSession.sessionId,
        allowedEntityKinds,
        allowedActions,
        resourceScopes,
        pathFootprint: null,
        maxBytes: BigInt(intent.payload.byteLength) + 4_096n,
        maxMutations: intent.mutations.length,
        maxOperations: 1,
        authorityGeneration: BigInt(input.config.authorityGeneration),
        channelNonceDigest: input.context.channelBinding.digest,
        schemaTuple: input.config.schemaTuple,
        issuedAt: BigInt(now),
        notBefore: BigInt(now),
        expiresAt: BigInt(now + 5 * 60_000),
        revocationEpochs: executorAgentId === null
          ? { ...input.config.revocationEpochs, executor: 0n }
          : input.config.revocationEpochs
      };
      const token = issueActorAxesBindingV2(
        claims,
        input.keyStore.signingProfile(input.keyRegistry, now)
      );
      const operationRandom = newRandom128();
      if (operationRandom.byteLength !== 16) {
        throw new Error("AUTHORITY_ATTEMPT_PLAN_RANDOM128_INVALID");
      }
      const mutationSet = {
        registryVersion: 1,
        mutations: intent.mutations.map((mutation) => ({
          entity: mutation.entity,
          action: { registryVersion: 1, action: mutation.action }
        })).sort((left, right) => Buffer.compare(
          Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
          Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
        ))
      } as const;
      const base: SemanticMutationEnvelopeV2 = {
        schema: semanticMutationEnvelopeV2Schema,
        workspaceId: input.config.workspaceId,
        operationId: {
          namespace: input.config.operationNamespace,
          clientRandom128: operationRandom
        },
        binding: {
          bindingId: claims.bindingId,
          actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
          deviceId: claims.deviceId,
          viewId: claims.viewId,
          sessionId: claims.sessionId,
          admissionTokenRef: {
            tokenId: claims.tokenId,
            tokenDigest: actorAxesBindingTokenDigestV2(token)
          }
        },
        schemaTuple: input.config.schemaTuple,
        intent: {
          kind: "typed",
          command: { registryVersion: 1, name: intent.commandName, version: 1 },
          canonicalPayload: {
            kind: "inline",
            size: BigInt(intent.payload.byteLength),
            bytes: intent.payload
          },
          canonicalPayloadDigest: canonicalPayloadDigestV2(intent.payload),
          baseCas: intent.baseRefs.map((entityRef) => ({
            entityRef,
            expectedSemanticVersion: null,
            expectedStateDigest: null
          })),
          declaredPathCas: intent.declaredPathCas
        },
        claimedMutationSet: mutationSet,
        claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
        claimedSemanticRequestDigest: Buffer.alloc(32)
      };
      const envelope = {
        ...base,
        claimedSemanticRequestDigest: semanticRequestDigestV2(base)
      };
      return {
        schema: productionAuthorityAttemptPlanV1Schema,
        commandKind: command.action.kind,
        targetEntityId: canonicalEntityId,
        requestId: `authority-command:${newUuid()}`,
        innerOpId: operationIdDiagnosticV2(envelope.operationId),
        semanticDigest: Buffer.from(envelope.claimedSemanticRequestDigest).toString("hex"),
        tokenId: claims.tokenId,
        bindingId: claims.bindingId,
        plannedAtMs: String(now),
        expiresAtMs: claims.expiresAt.toString(),
        presentationTokenBase64url: Buffer.from(token).toString("base64url"),
        envelopeBase64url: Buffer.from(
          encodeSemanticMutationEnvelopeV2(envelope)
        ).toString("base64url"),
        attribution: attribution.writeAttribution
      };
    },
    activatePlan: (plan) => activatePlannedAttempt(input, plan, false),
    activateRecoveryPlan: async (plan, witness) => {
      if (!input.runAuthorizedRecoveryPlan) {
        throw new Error("AUTHORITY_ATTEMPT_RECOVERY_AUTHORIZATION_UNAVAILABLE");
      }
      if (!boundedText(witness.outerOpId, 512)
        || !/^[a-f0-9]{64}$/u.test(witness.outerRequestDigest)
        || !Number.isSafeInteger(witness.outerGeneration)
        || witness.outerGeneration < 1) {
        throw new Error("AUTHORITY_ATTEMPT_OUTER_RECOVERY_WITNESS_INVALID");
      }
      return input.runAuthorizedRecoveryPlan(
        witness,
        (candidate) => {
          assertRecoveryOutcomeBindsPlan(input.config, plan, witness, candidate);
          return activatePlannedAttempt(input, plan, true);
        }
      );
    }
  };
}

function assertRecoveryOutcomeBindsPlan(
  config: AuthorityProductionRepoConfigV1,
  plan: ProductionAuthorityAttemptPlanV1,
  witness: ProductionAuthorityOuterRecoveryWitnessV1,
  candidate: RepoWriteProceedingOutcomeV1
): void {
  const outcome = decodeRepoWriteOutcomeV1(candidate);
  if (outcome.phase !== "PROCEEDING") {
    throw new Error("AUTHORITY_ATTEMPT_RECOVERY_PROCEEDING_REQUIRED");
  }
  if (outcome.repoId !== config.repoId
    || outcome.workspaceId !== config.workspaceId
    || outcome.generation !== config.authorityGeneration
    || witness.outerOpId !== outcome.outerOpId
    || witness.outerRequestDigest !== outcome.requestDigest
    || witness.outerGeneration !== outcome.generation) {
    throw new Error("AUTHORITY_ATTEMPT_RECOVERY_OUTER_BINDING_MISMATCH");
  }
  if (outcome.innerOpId !== plan.innerOpId
    || outcome.authoritySemanticDigest !== plan.semanticDigest
    || stableStringify(outcome.recoveryContext) !== stableStringify(plan)) {
    throw new Error("AUTHORITY_ATTEMPT_RECOVERY_PLAN_BINDING_MISMATCH");
  }
  const authenticatedActor = outcome.authenticatedContext.actor as Record<string, unknown>;
  if (plan.attribution.actor.principal.personId !== authenticatedActor.personId
    || plan.attribution.principalSource.kind !== "daemon-authenticated"
    || plan.attribution.principalSource.providerId !== authenticatedActor.providerId) {
    throw new Error("AUTHORITY_ATTEMPT_RECOVERY_ACTOR_BINDING_MISMATCH");
  }
}

export function attemptFromProgressAppendPlan(
  plan: ProductionAuthorityProgressAppendPlanV1
): AuthorizedOperationAttemptV2 {
  if (plan.commandKind !== "progress-append") {
    throw new Error(`AUTHORITY_PROGRESS_APPEND_PLAN_REQUIRED:${plan.commandKind}`);
  }
  return attemptFromPlan(plan);
}

function activatePlannedAttempt(
  input: Parameters<typeof createProductionAuthorityAttemptPlanner>[0],
  plan: ProductionAuthorityAttemptPlanV1,
  recovery: boolean
): AuthorizedOperationAttemptV2 {
  const attempt = attemptFromPlan(plan);
  const token = verifyActorAxesBindingV2(
    attempt.presentationToken,
    input.bindingRuntime.proofKeys
  );
  const envelope = decodeSemanticMutationEnvelopeV2(attempt.envelope);
  if (operationIdDiagnosticV2(envelope.operationId) !== plan.innerOpId) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_OPERATION_MISMATCH");
  }
  if (Buffer.from(envelope.claimedSemanticRequestDigest).toString("hex") !== plan.semanticDigest) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_DIGEST_MISMATCH");
  }
  if (token.claims.issuedAt.toString() !== plan.plannedAtMs) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_TIME_MISMATCH");
  }
  if (token.claims.tokenId !== plan.tokenId || token.claims.bindingId !== plan.bindingId
    || token.claims.expiresAt.toString() !== plan.expiresAtMs) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_TOKEN_AXES_MISMATCH");
  }
  if (token.header.issuer !== input.config.issuer
    || token.claims.workspaceId !== input.config.workspaceId
    || token.claims.deviceId !== input.config.deviceId
    || token.claims.viewId !== input.config.viewId
    || token.claims.authorityGeneration !== BigInt(input.config.authorityGeneration)
    || !sameProtocolSchemaTupleV2(token.claims.schemaTuple, input.config.schemaTuple)) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_TOKEN_CONFIG_MISMATCH");
  }
  if (!recovery && (!sameRevocationEpochs(
    token.claims.revocationEpochs,
    token.claims.executorAgentId === null
      ? { ...input.config.revocationEpochs, executor: 0n }
      : input.config.revocationEpochs
  ) || !Buffer.from(token.claims.channelNonceDigest).equals(
    Buffer.from(input.context.channelBinding.digest)
  ))) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_TOKEN_CURRENT_ADMISSION_MISMATCH");
  }
  if (token.claims.notBefore !== token.claims.issuedAt
    || token.claims.expiresAt !== token.claims.issuedAt + 5n * 60_000n
    || token.claims.maxOperations !== 1) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_TOKEN_ADMISSION_MISMATCH");
  }
  validateEnvelopeBindingV2(envelope, token.claims);
  assertMutationClaimMatchesV2(envelope, envelope.claimedMutationSet);
  if (!Buffer.from(envelope.binding.admissionTokenRef.tokenDigest).equals(
    Buffer.from(actorAxesBindingTokenDigestV2(attempt.presentationToken))
  ) || envelope.binding.admissionTokenRef.tokenId !== token.claims.tokenId) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_TOKEN_REF_MISMATCH");
  }
  if (!Buffer.from(encodeCanonicalCbor(
    envelope.operationId.namespace as unknown as CanonicalCborValue
  )).equals(Buffer.from(encodeCanonicalCbor(
    input.config.operationNamespace as unknown as CanonicalCborValue
  )))) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_NAMESPACE_MISMATCH");
  }
  if (!sameProtocolSchemaTupleV2(envelope.schemaTuple, input.config.schemaTuple)) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_ENVELOPE_SCHEMA_MISMATCH");
  }
  if (token.claims.principalPersonId !== plan.attribution.actor.principal.personId
    || token.claims.executorAgentId !== (plan.attribution.actor.executor?.id ?? null)) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_ATTRIBUTION_MISMATCH");
  }
  const register = recovery
    ? input.bindingRuntime.registerRecoveryIssuedToken
    : input.bindingRuntime.registerIssuedToken;
  register({
    claims: token.claims,
    token: attempt.presentationToken,
    attribution: plan.attribution
  });
  return attempt;
}

function attemptFromPlan(
  plan: ProductionAuthorityAttemptPlanV1
): AuthorizedOperationAttemptV2 {
  if (plan.schema !== productionAuthorityAttemptPlanV1Schema) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_SCHEMA_INVALID");
  }
  if (!plan.commandKind || !plan.targetEntityId.trim()
    || !plan.requestId.trim() || !plan.innerOpId.trim()
    || !plan.tokenId.trim() || !plan.bindingId.trim()
    || !/^[a-f0-9]{64}$/u.test(plan.semanticDigest)
    || !/^(0|[1-9][0-9]*)$/u.test(plan.plannedAtMs)
    || !/^(0|[1-9][0-9]*)$/u.test(plan.expiresAtMs)) {
    throw new Error("AUTHORITY_ATTEMPT_PLAN_FIELD_INVALID");
  }
  return {
    requestId: plan.requestId,
    presentationToken: exactBase64url(plan.presentationTokenBase64url, "presentationToken"),
    envelope: exactBase64url(plan.envelopeBase64url, "envelope")
  };
}

function exactBase64url(value: string, field: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`AUTHORITY_ATTEMPT_PLAN_BASE64URL_INVALID:${field}`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(`AUTHORITY_ATTEMPT_PLAN_BASE64URL_NON_CANONICAL:${field}`);
  }
  return decoded;
}

function sameRevocationEpochs(
  left: AuthorityProductionRepoConfigV1["revocationEpochs"],
  right: AuthorityProductionRepoConfigV1["revocationEpochs"]
): boolean {
  return left.global === right.global
    && left.workspace === right.workspace
    && left.device === right.device
    && left.view === right.view
    && left.principal === right.principal
    && left.executor === right.executor;
}

function boundedText(value: string, maximum: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !value.includes("\0");
}

function resourceScopeWire(scope: {
  readonly kind: "entity-ref";
  readonly entityRef: RegistryEntityRefV2;
} | {
  readonly kind: "portable-path";
  readonly path: string;
}): CanonicalCborValue {
  if (scope.kind === "portable-path") return { kind: scope.kind, path: scope.path };
  return {
    kind: scope.kind,
    entityRef: {
      registryVersion: scope.entityRef.registryVersion,
      entityKind: scope.entityRef.entityKind,
      canonicalRef: scope.entityRef.canonicalRef
    }
  };
}

function canonicalBindingResourceScopes(
  scopes: ReadonlyArray<Parameters<typeof resourceScopeWire>[0]>
): ReadonlyArray<Parameters<typeof resourceScopeWire>[0]> {
  const keyed = new Map<string, Parameters<typeof resourceScopeWire>[0]>();
  for (const scope of scopes) {
    keyed.set(
      Buffer.from(encodeCanonicalCbor(resourceScopeWire(scope))).toString("hex"),
      scope
    );
  }
  return [...keyed.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
}

function canonicalBindingTextSet(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort((left, right) => Buffer.compare(
    Buffer.from(encodeCanonicalCbor(left)),
    Buffer.from(encodeCanonicalCbor(right))
  ));
}
