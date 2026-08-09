import type { DaemonAuthenticationContext } from "./auth-context.ts";
import type { TransportAuthenticationResult } from "./json-rpc-stream.ts";
import { shellArgument } from "../shell-argument.ts";

export interface SshForcedCommandBootstrapInput {
  readonly personId: string;
  readonly canonicalRoot: string;
}

export interface SshForcedCommandBootstrapFrame extends SshForcedCommandBootstrapInput {
  readonly type: "harness-daemon.ssh-forced-command/v1";
}

export interface SshAuthorityWireBootstrapFrame extends SshForcedCommandBootstrapInput {
  readonly type: "harness-daemon.ssh-forced-command/v2";
  readonly streamProtocol: "harness-authority-wire/v1";
}

export type SshAuthenticatedBootstrapFrame =
  | SshForcedCommandBootstrapFrame
  | SshAuthorityWireBootstrapFrame;

export type AcceptSshForcedCommand = (frame: SshAuthenticatedBootstrapFrame) => boolean;

export function sshForcedCommandBootstrapFrame(
  input: SshForcedCommandBootstrapInput
): SshForcedCommandBootstrapFrame {
  return {
    type: "harness-daemon.ssh-forced-command/v1",
    personId: input.personId,
    canonicalRoot: input.canonicalRoot
  };
}

export function sshAuthorityWireBootstrapFrame(
  input: SshForcedCommandBootstrapInput
): SshAuthorityWireBootstrapFrame {
  return {
    type: "harness-daemon.ssh-forced-command/v2",
    streamProtocol: "harness-authority-wire/v1",
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
      return {
        ok: false,
        code: "forced_command_malformed",
        message: "The SSH forced-command authentication frame is invalid because personId or canonicalRoot is missing. Reconnect through the configured relay with `ha daemon connect --stdio`; custom clients must send harness-daemon.ssh-forced-command/v1 with both fields."
      };
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

export function authenticateSshAuthorityWireFrame(
  frame: unknown,
  authContext: DaemonAuthenticationContext,
  accept: AcceptSshForcedCommand = () => true
): TransportAuthenticationResult {
  if (!isSshAuthorityWireBootstrapFrame(frame)) {
    const malformed = isAuthorityWireFrameType(frame);
    return {
      ok: false,
      code: malformed ? "authority_wire_bootstrap_malformed" : "authority_wire_bootstrap_required",
      message: malformed
        ? "The required authority-wire bootstrap is invalid; reconnect with `ha daemon connect --stdio --authority-wire`."
        : "The required authority-wire bootstrap is missing; use `ha daemon connect --stdio --authority-wire`."
    };
  }
  if (!accept(frame)) {
    const root = shellArgument(frame.canonicalRoot);
    return {
      ok: false,
      code: "authority_wire_repo_unavailable",
      message: `The requested canonical root ${JSON.stringify(frame.canonicalRoot)} is unavailable to this authority service. Run \`ha --root ${root} daemon status --json\` on the authority host to inspect its registered state. Do not register a second repo id or start, stop, or restart a daemon based on this error.`
    };
  }
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

export function isSshAuthorityWireBootstrapFrame(value: unknown): value is SshAuthorityWireBootstrapFrame {
  return isAuthorityWireFrameType(value)
    && (value as { readonly streamProtocol?: unknown }).streamProtocol === "harness-authority-wire/v1"
    && typeof (value as { readonly personId?: unknown }).personId === "string"
    && (value as { readonly personId: string }).personId.length > 0
    && typeof (value as { readonly canonicalRoot?: unknown }).canonicalRoot === "string"
    && (value as { readonly canonicalRoot: string }).canonicalRoot.length > 0;
}

function isForcedCommandFrameType(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { readonly type?: unknown }).type === "harness-daemon.ssh-forced-command/v1";
}

export function isAuthorityWireFrameType(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { readonly type?: unknown }).type === "harness-daemon.ssh-forced-command/v2";
}

function isSshForcedCommandBootstrapFrame(value: unknown): value is SshForcedCommandBootstrapFrame {
  return isForcedCommandFrameType(value)
    && typeof (value as { readonly personId?: unknown }).personId === "string"
    && (value as { readonly personId: string }).personId.length > 0
    && typeof (value as { readonly canonicalRoot?: unknown }).canonicalRoot === "string"
    && (value as { readonly canonicalRoot: string }).canonicalRoot.length > 0;
}
