import { Effect } from "effect";
import {
  actorAxesBindingTokenDigestV2,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  operationIdDiagnosticV2,
  type AuthorityOperationReceipt,
  type AuthorizedOperationAttemptV2,
  type ProtocolSchemaTupleV2
} from "../../../application/src/index.ts";
import {
  entityRegistry,
  taskEntityId
} from "../../../kernel/src/index.ts";
import {
  v2Claims,
  v2CommittedEventPublisher,
  v2Envelope
} from "../../../daemon/test/authority-v2-fixtures.ts";
import { daemonActorAttribution } from "../../src/composition/actor-attribution.ts";
import { createDaemonAuthorityCommandSubmissionV2 } from "../../src/daemon/authority-command-submission.ts";

const workspaceId = "workspace-command-service";
const channelNonceDigest = Buffer.alloc(32, 12);
const schemaTuple: ProtocolSchemaTupleV2 = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
  localState: 1, applyJournal: 1
};

export function authorityCommandAttemptFixture(): {
  readonly attempt: AuthorizedOperationAttemptV2;
  readonly expectedOpId: string;
} {
  const claims = v2Claims(workspaceId, channelNonceDigest, schemaTuple);
  const tokenDigest = Buffer.alloc(32, 6);
  const envelope = v2Envelope(claims, tokenDigest, "task-command-service", "command service\n", 4);
  return {
    attempt: {
      requestId: "command-service-v2",
      presentationToken: Buffer.from("server-bound-token"),
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    },
    expectedOpId: operationIdDiagnosticV2(envelope.operationId)
  };
}

export async function submitThroughActualAuthorityServiceV2(): Promise<AuthorityOperationReceipt> {
  const secret = Buffer.from("command-service-authority-secret");
  const claims = v2Claims(workspaceId, channelNonceDigest, schemaTuple);
  const token = issueActorAxesBindingV2(claims, {
    algorithm: "HMAC-SHA-256",
    issuer: "authority.test",
    keyId: "command-service-key",
    secret
  });
  const tokenDigest = actorAxesBindingTokenDigestV2(token);
  const envelope = v2Envelope(claims, tokenDigest, "task-command-service-actual", "actual adapter\n", 8);
  const service = createAuthoritySubmissionService({
    workspaceId,
    coordinatorFactory: {
      create: () => {
        let opCount = 0;
        return {
          enqueue: (operation) => Effect.sync(() => {
            opCount += 1;
            return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
          }),
          flush: (reason) => Effect.succeed({ reason, opCount, committed: true, watermark: "commit-after" }),
          recover: Effect.succeed({ replayedOps: 0 })
        };
      }
    },
    tokenVerifier: { verify: async () => { throw new Error("legacy authority path must not run"); } },
    operationRegistry: createInMemoryAuthorityOperationRegistry(),
    replicaChangeLog: createInMemoryReplicaChangeLog(),
    publicationInspector: {
      currentHead: async () => "commit-before",
      inspectPublishedHead: async () => ({ commitSha: "commit-after", parentCommits: ["commit-before"] })
    },
    fenceWitness: { assertHeld: async () => undefined },
    now: () => "2026-07-16T00:00:00.000Z",
    v2: {
      schemaTuple,
      channelNonceDigest,
      bindingRuntime: {
        proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret }) },
        validatePresentationToken: async (input) => input.tokenId === claims.tokenId
          && Buffer.from(input.tokenDigest).equals(Buffer.from(tokenDigest)),
        getBinding: async () => ({
          bindingId: claims.bindingId,
          principalPersonId: claims.principalPersonId,
          executorAgentId: claims.executorAgentId,
          workspaceId: claims.workspaceId,
          deviceId: claims.deviceId,
          viewId: claims.viewId,
          sessionId: claims.sessionId,
          active: true,
          attribution: {
            actor: {
              principal: { kind: "person", personId: claims.principalPersonId },
              executor: { kind: "agent", id: claims.executorAgentId! }
            },
            principalSource: {
              kind: "daemon-authenticated",
              providerId: "authority.test",
              credentialFingerprint: "sha256:redacted"
            },
            executorSource: "client-asserted"
          }
        }),
        currentAuthorityGeneration: () => claims.authorityGeneration,
        currentRevocationEpochs: async () => claims.revocationEpochs,
        nowMs: () => 2_000n,
        consumeOperation: async () => true,
        validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId
          && Buffer.from(input.tokenDigest).equals(Buffer.from(tokenDigest))
      },
      entityRegistrations: [{
        ...entityRegistry.task,
        mutationContract: { status: "ready", actions: ["update"] },
        semanticDiff: { status: "ready", compile: () => [] },
        projectionFacet: {
          status: "ready",
          project: () => undefined,
          resolveCanonicalRef: () => ({})
        }
      }],
      semanticCompiler: {
        compile: async (candidate) => {
          if (candidate.intent.kind !== "typed" || candidate.intent.canonicalPayload.kind !== "inline") {
            throw new Error("typed inline payload required");
          }
          const payload = JSON.parse(Buffer.from(candidate.intent.canonicalPayload.bytes).toString("utf8")) as {
            readonly taskId: string;
            readonly body: string;
          };
          return {
            mutationPlan: {
              registryVersion: 1,
              mutations: [{ entityKind: "task", identity: { taskId: payload.taskId }, action: "update" }]
            },
            operation: {
              opId: "authority-overrides-this",
              entityId: taskEntityId(payload.taskId),
              kind: "doc_write",
              payload: { path: "notes.md", body: payload.body }
            },
            decodedBytes: BigInt(candidate.intent.canonicalPayload.bytes.length)
          };
        }
      },
      operationNamespaceVerifier: { verify: async () => undefined },
      committedEventPublisher: v2CommittedEventPublisher()
    }
  });
  return createDaemonAuthorityCommandSubmissionV2({
    authorityService: service,
    attemptCompiler: {
      compile: async ({ canonicalEntityId }) => {
        if (canonicalEntityId !== taskEntityId("task-command-service-actual")) {
          throw new Error("canonical entity identity mismatch");
        }
        return {
          requestId: "actual-command-service-v2",
          presentationToken: token,
          envelope: encodeSemanticMutationEnvelopeV2(envelope)
        };
      }
    }
  }).submit({
    command: {
      rootDir: "/repo",
      json: true,
      action: {
        kind: "new-task",
        title: "Actual Authority Adapter",
        titleProvided: true,
        slug: "actual-authority-adapter"
      }
    },
    attribution: daemonActorAttribution({
      personId: claims.principalPersonId,
      displayName: "Authenticated Person",
      primaryEmail: "person@example.test",
      roles: ["writer"],
      providerId: "authority.test",
      resolvedCredential: {
        kind: "ssh-forced-command-person",
        issuer: "authority.test",
        subject: claims.principalPersonId
      }
    }, { kind: "agent", id: claims.executorAgentId! }),
    currentSession: {
      runtime: "codex",
      sessionId: claims.sessionId,
      source: "manual",
      detectedAt: "2026-07-16T00:00:00.000Z"
    },
    canonicalEntityId: taskEntityId("task-command-service-actual")
  });
}
