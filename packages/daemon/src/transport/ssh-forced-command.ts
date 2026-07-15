import type { DaemonAuthenticationContext } from "./auth-context.ts";
import type { TransportAuthenticationResult } from "./json-rpc-stream.ts";

export interface SshForcedCommandBootstrapInput {
  readonly personId: string;
  readonly canonicalRoot: string;
}

export interface SshForcedCommandBootstrapFrame extends SshForcedCommandBootstrapInput {
  readonly type: "harness-daemon.ssh-forced-command/v1";
}

export type AcceptSshForcedCommand = (frame: SshForcedCommandBootstrapFrame) => boolean;

export function sshForcedCommandBootstrapFrame(
  input: SshForcedCommandBootstrapInput
): SshForcedCommandBootstrapFrame {
  return {
    type: "harness-daemon.ssh-forced-command/v1",
    personId: input.personId,
    canonicalRoot: input.canonicalRoot
  };
}

export function authenticateSshForcedCommandFrame(
  frame: unknown,
  authContext: DaemonAuthenticationContext,
  accept: AcceptSshForcedCommand = () => true
): TransportAuthenticationResult {
  if (!isSshForcedCommandBootstrapFrame(frame)) {
    if (isForcedCommandFrameType(frame)) {
      return { ok: false, code: "forced_command_malformed", message: "Malformed SSH forced-command authentication frame." };
    }
    return { ok: true, authContext, forwardFrame: true };
  }
  if (!accept(frame)) return { ok: true, authContext };
  return {
    ok: true,
    authContext: {
      ...authContext,
      sshForcedCommand: {
        personId: frame.personId,
        canonicalRoot: frame.canonicalRoot,
        source: "sshd-authorized-keys-forced-command"
      }
    }
  };
}

function isForcedCommandFrameType(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { readonly type?: unknown }).type === "harness-daemon.ssh-forced-command/v1";
}

function isSshForcedCommandBootstrapFrame(value: unknown): value is SshForcedCommandBootstrapFrame {
  return isForcedCommandFrameType(value)
    && typeof (value as { readonly personId?: unknown }).personId === "string"
    && (value as { readonly personId: string }).personId.length > 0
    && typeof (value as { readonly canonicalRoot?: unknown }).canonicalRoot === "string"
    && (value as { readonly canonicalRoot: string }).canonicalRoot.length > 0;
}
