// @slice-activation PLT-Boundary W2 exports daemon-owned production authority admission to CLI composition consumers.
import type {
  AuthorityCutoverControlService,
  AuthoritySubmissionService
} from "@harness-anything/application";

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
    ...(service.resumeV2 ? {
      resumeV2: (recovery: Parameters<NonNullable<AuthoritySubmissionService["resumeV2"]>>[0]) =>
        control.runDuringOpenAdmission(() => service.resumeV2!(recovery))
    } : {}),
    getOperation: service.getOperation
  };
}
