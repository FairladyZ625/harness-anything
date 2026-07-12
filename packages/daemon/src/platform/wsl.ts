import { createHash } from "node:crypto";

export interface WslDetectionInput {
  readonly hostPlatform: NodeJS.Platform;
  readonly osRelease?: string;
  readonly procVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WslDetection {
  readonly isWsl: boolean;
  readonly distroName?: string;
}

export function detectWsl(input: WslDetectionInput): WslDetection {
  if (input.hostPlatform !== "linux") return { isWsl: false };
  const env = input.env ?? {};
  const marker = `${input.osRelease ?? ""}\n${input.procVersion ?? ""}`.toLowerCase();
  const isWsl = env.WSL_INTEROP !== undefined
    || env.WSL_DISTRO_NAME !== undefined
    || marker.includes("microsoft");
  if (!isWsl) return { isWsl: false };
  return { isWsl: true, distroName: env.WSL_DISTRO_NAME?.trim() || "unknown-distro" };
}

export interface WslViewIdentityInput {
  readonly workspaceId: string;
  readonly distroName: string;
  readonly linuxMachineId: string;
  readonly actorId?: string;
}

export function deriveWslViewId(input: WslViewIdentityInput): string {
  const encoded = JSON.stringify([
    "harness-wsl-view-id/v1",
    input.workspaceId,
    input.distroName,
    input.linuxMachineId,
    input.actorId ?? ""
  ]);
  return `view_wsl_${createHash("sha256").update(encoded).digest("hex").slice(0, 32)}`;
}
