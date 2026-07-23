import type { AuthoritySubmissionService } from "@harness-anything/application";
import {
  answerAttestationChallenge,
  createAttestationChallenge,
  verifyAttestationAssertion
} from "../../attestation/handshake.ts";
import { createTransportObservedAttestationAdapter } from "../../attestation/transport-observed-adapter.ts";
import type { AuthorityConnectionContext } from "../../protocol/connection-context.ts";

export function attestSubmissionService(
  service: AuthoritySubmissionService,
  context: AuthorityConnectionContext
): AuthoritySubmissionService {
  const assertAttested = () => assertTransportObservedAttestation(context);
  return {
    submit: async (envelope) => {
      await assertAttested();
      return service.submit(envelope);
    },
    ...(service.submitV2 ? {
      submitV2: async (attempt: Parameters<NonNullable<AuthoritySubmissionService["submitV2"]>>[0]) => {
        await assertAttested();
        return service.submitV2!(attempt);
      }
    } : {}),
    getOperation: async (workspaceId, opId) => {
      await assertAttested();
      return service.getOperation(workspaceId, opId);
    }
  };
}

async function assertTransportObservedAttestation(context: AuthorityConnectionContext): Promise<void> {
  const channel = Buffer.from(context.channelBinding.digest).toString("hex");
  const adapter = createTransportObservedAttestationAdapter(context);
  const challenge = createAttestationChallenge({ verifierRole: "broker", channelBinding: channel });
  const assertion = await answerAttestationChallenge(
    challenge,
    context.actor.resolvedCredential,
    adapter.proofProvider
  );
  await verifyAttestationAssertion({
    challenge,
    assertion,
    observedCredential: context.actor.resolvedCredential,
    verifier: adapter.proofVerifier
  });
}
