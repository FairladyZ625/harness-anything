import type { ProjectHarnessSettings } from "../commands/settings.ts";

export function daemonServeAdmissionOptions(settings: ProjectHarnessSettings): {
  readonly admissionMaxBytes?: number;
} {
  const maxBytes = settings.daemon?.admission?.maxBytes;
  return maxBytes === undefined ? {} : { admissionMaxBytes: maxBytes };
}
