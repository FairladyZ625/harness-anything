import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

export const observed: RuntimeInstallationWitness = {
  installationId: "codex-installation-test",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.146.1",
  observedAt: "2026-08-15T00:00:00.000Z",
};

export function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
