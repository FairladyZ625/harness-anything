import {
  decodeSemanticMutationEnvelopeV2,
  operationIdDiagnosticV2,
  type AuthorityOperationReceipt,
  type AuthoritySubmissionService,
  type ProductionAuthorityCompilerHostServices
} from "@harness-anything/application";
import { stableStringify } from "@harness-anything/kernel";
import {
  assertAuthorityReceiptOperation,
  assertCompleteAuthorityReceiptV2,
  type DaemonAuthorityCommandSubmissionV2
} from "../authority-command-submission.ts";
import type {
  ProductionAuthorityCommandPlanInput,
  ProductionAuthorityCommandSubmissionInput,
  ProductionCanonicalAttemptCompilerV2,
  ProductionProgressAppendCompileInput
} from "./production-authority-attempt-compiler.ts";
import { createProductionCanonicalAttemptCompiler } from "./production-authority-attempt-compiler.ts";
import type {
  ProductionAuthorityAttemptPlanV1,
  ProductionAuthorityOuterRecoveryWitnessV1,
  ProductionAuthorityProgressAppendPlanV1
} from "./production-authority-attempt-plan.ts";
import type { AuthorityConnectionContext } from "../../protocol/connection-context.ts";
import type {
  AuthorityProductionRepoConfigV1,
  DurableAuthorityBindingRuntimeV2
} from "./authority-production-state.ts";
import type { openAuthorityProductionKeyMaterial } from "./authority-production-state.ts";

export interface ProductionPlannedCommandSubmission {
  readonly submit: (
    input: ProductionAuthorityCommandSubmissionInput
  ) => Promise<AuthorityOperationReceipt>;
}

export function createProductionProgressAppendConnectionBinding(input: {
  readonly material: {
    readonly config: AuthorityProductionRepoConfigV1;
    readonly keyStore: ReturnType<typeof openAuthorityProductionKeyMaterial>["keyStore"];
    readonly keyRegistry: ReturnType<typeof openAuthorityProductionKeyMaterial>["registry"];
    readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
    readonly authoredRoot: string;
  };
  readonly writerGeneration?: number;
  readonly context: AuthorityConnectionContext;
  readonly hostServices: ProductionAuthorityCompilerHostServices;
  readonly authorityService: AuthoritySubmissionService;
  readonly runAuthorizedRecoveryPlan?: Parameters<
    typeof createProductionCanonicalAttemptCompiler
  >[0]["runAuthorizedRecoveryPlan"];
}) {
  const compiler = createProductionCanonicalAttemptCompiler({
    ...input.material,
    ...(input.writerGeneration ? { writerGeneration: input.writerGeneration } : {}),
    context: input.context,
    hostServices: input.hostServices,
    ...(input.runAuthorizedRecoveryPlan ? {
      runAuthorizedRecoveryPlan: input.runAuthorizedRecoveryPlan
    } : {})
  });
  const plannedCommandSubmission =
    createProductionPlannedCommandSubmissionFactory({
      repoId: input.material.config.repoId,
      authorityGeneration: input.material.config.authorityGeneration,
      authorityService: input.authorityService,
      compiler
    });
  return {
    compiler,
    planCommand: compiler.planCommand,
    plannedCommandSubmission,
    planProgressAppend: compiler.planProgressAppend,
    plannedProgressAppendSubmission:
      createProductionProgressAppendSubmissionFactory({
        repoId: input.material.config.repoId,
        authorityGeneration: input.material.config.authorityGeneration,
        authorityService: input.authorityService,
        compiler
      })
  };
}

export function createProductionPlannedCommandSubmissionFactory(input: {
  readonly repoId: string;
  readonly authorityGeneration: number;
  readonly authorityService: AuthoritySubmissionService;
  readonly compiler: ProductionCanonicalAttemptCompilerV2;
}) {
  return (attempt: {
    readonly expected: ProductionAuthorityCommandPlanInput;
    readonly plan: ProductionAuthorityAttemptPlanV1;
    readonly recovery?: ProductionAuthorityOuterRecoveryWitnessV1;
  }): ProductionPlannedCommandSubmission =>
    createProductionPlannedCommandSubmission({
      ...input,
      ...attempt
    });
}

export function createProductionProgressAppendSubmissionFactory(input: {
  readonly repoId: string;
  readonly authorityGeneration: number;
  readonly authorityService: AuthoritySubmissionService;
  readonly compiler: ProductionCanonicalAttemptCompilerV2;
}) {
  return (attempt: {
    readonly expected: ProductionProgressAppendCompileInput;
    readonly plan: ProductionAuthorityProgressAppendPlanV1;
    readonly recovery?: ProductionAuthorityOuterRecoveryWitnessV1;
  }): DaemonAuthorityCommandSubmissionV2 =>
    createProductionProgressAppendSubmission({
      ...input,
      ...attempt
    });
}

export function createProductionProgressAppendSubmission(input: {
  readonly repoId: string;
  readonly authorityGeneration: number;
  readonly authorityService: AuthoritySubmissionService;
  readonly compiler: ProductionCanonicalAttemptCompilerV2;
  readonly expected: ProductionProgressAppendCompileInput;
  readonly plan: ProductionAuthorityProgressAppendPlanV1;
  readonly recovery?: ProductionAuthorityOuterRecoveryWitnessV1;
}): DaemonAuthorityCommandSubmissionV2 {
  if (input.plan.commandKind !== "progress-append") {
    throw new Error(`AUTHORITY_PROGRESS_APPEND_PLAN_REQUIRED:${input.plan.commandKind}`);
  }
  const {
    canonicalEntityId: _canonicalEntityId,
    ...expected
  } = input.expected;
  return createProductionPlannedCommandSubmission({
    ...input,
    expected
  });
}

export function createProductionPlannedCommandSubmission(input: {
  readonly repoId: string;
  readonly authorityGeneration: number;
  readonly authorityService: AuthoritySubmissionService;
  readonly compiler: ProductionCanonicalAttemptCompilerV2;
  readonly expected: ProductionAuthorityCommandPlanInput;
  readonly plan: ProductionAuthorityAttemptPlanV1;
  readonly recovery?: ProductionAuthorityOuterRecoveryWitnessV1;
}): ProductionPlannedCommandSubmission {
  let submitted = false;
  return {
    submit: async (actual) => {
      if (submitted) {
        throw new Error("AUTHORITY_PLANNED_SUBMISSION_REUSED");
      }
      const {
        canonicalEntityId,
        ...actualPlanInput
      } = actual;
      if (canonicalEntityId !== input.plan.targetEntityId
        || stableStringify(actualPlanInput) !== stableStringify(input.expected)) {
        throw new Error("AUTHORITY_PLANNED_INPUT_MISMATCH");
      }
      submitted = true;
      const attempt = input.recovery
        ? await input.compiler.activateRecoveryCommand(input.plan, input.recovery)
        : input.compiler.activatePlannedCommand(input.plan);
      const envelope = decodeSemanticMutationEnvelopeV2(attempt.envelope);
      const expectedOpId = operationIdDiagnosticV2(envelope.operationId);
      const receipt = input.recovery
        ? await resumePlannedCommand({ ...input, recovery: input.recovery }, attempt)
        : await submitPlannedCommand(input.authorityService, attempt);
      assertCompleteAuthorityReceiptV2(receipt);
      assertAuthorityReceiptOperation(receipt, expectedOpId);
      return receipt;
    }
  };
}

async function submitPlannedCommand(
  service: AuthoritySubmissionService,
  attempt: Parameters<NonNullable<AuthoritySubmissionService["submitV2"]>>[0]
) {
  if (!service.submitV2) throw new Error("AUTHORITY_V2_NOT_NEGOTIATED");
  return service.submitV2(attempt);
}

async function resumePlannedCommand(
  input: Parameters<typeof createProductionPlannedCommandSubmission>[0] & {
    readonly recovery: ProductionAuthorityOuterRecoveryWitnessV1;
  },
  attempt: Parameters<NonNullable<AuthoritySubmissionService["resumeV2"]>>[0]["attempt"]
) {
  if (!input.authorityService.resumeV2) {
    throw new Error("AUTHORITY_RECOVERY_AUTHORIZATION_UNAVAILABLE");
  }
  return input.authorityService.resumeV2({
    schema: "authority-recovery-attempt/v1",
    attempt,
    witness: {
      repoId: input.repoId,
      outerOpId: input.recovery.outerOpId,
      outerRequestDigest: input.recovery.outerRequestDigest,
      outerGeneration: input.recovery.outerGeneration,
      authorityGeneration: input.authorityGeneration,
      requestId: input.plan.requestId,
      workspaceId: decodeSemanticMutationEnvelopeV2(attempt.envelope).workspaceId,
      opId: input.plan.innerOpId,
      semanticDigest: input.plan.semanticDigest,
      admittedAtMs: input.plan.plannedAtMs,
      canonicalRequestEnvelope: input.plan.envelopeBase64url,
      attribution: input.plan.attribution
    }
  });
}
