import type {
  AuthorityCutoverControlService,
  AuthoritySubmissionService
} from "../../../application/src/index.ts";

export function gateCutoverAdmission(
  service: AuthoritySubmissionService,
  control: AuthorityCutoverControlService
): AuthoritySubmissionService {
  return {
    submit: (envelope) => control.runDuringOpenAdmission(() => service.submit(envelope)),
    ...(service.submitV2 ? {
      submitV2: (attempt: Parameters<NonNullable<AuthoritySubmissionService["submitV2"]>>[0]) =>
        control.runDuringOpenAdmission(() => service.submitV2!(attempt))
    } : {}),
    getOperation: service.getOperation
  };
}
