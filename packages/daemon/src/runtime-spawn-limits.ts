import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

// Compatibility exports for callers that need the process budget names. The shared
// Policy declaration is the only source of the values.
export const { providerErrorLimit, resumeAdmissionTimeoutMs, exitNotificationTimeoutMs } =
  daemonRuntimePolicy.defaultValue.process;
