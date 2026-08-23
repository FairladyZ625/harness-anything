import type { StatusWordRegistration } from "./status-vocabulary-types.ts";
import { domainStatusWords } from "./status-word-register-domain.ts";
import { executionAndRelationStatusWords } from "./status-word-register-execution.ts";
import { runtimeAndRecoveryStatusWords } from "./status-word-register-runtime.ts";
import { presentationStatusWords } from "./status-word-register-presentation.ts";

/** Ordered cross-entity status registrations, assembled from bounded domains. */
export const statusWordRegister: readonly StatusWordRegistration[] = [
  ...domainStatusWords,
  ...executionAndRelationStatusWords,
  ...runtimeAndRecoveryStatusWords,
  ...presentationStatusWords,
];
