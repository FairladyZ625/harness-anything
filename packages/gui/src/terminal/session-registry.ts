// Contract-only compatibility facade. PTY processes, registry state, persistence,
// and lifecycle implementation are owned by packages/daemon/src/terminal.
export type * from "../../../application/src/terminal-session-contract.ts";

import type * as TerminalContract from "../../../application/src/terminal-session-contract.ts";

export interface TerminalSessionService {
  readonly createSession: (payload: TerminalContract.CreateTerminalSessionPayload) => TerminalContract.TerminalSessionDetailResult;
  readonly listSessions: () => TerminalContract.TerminalSessionListResult;
  readonly getSession: (payload: TerminalContract.TerminalSessionIdPayload) => TerminalContract.TerminalSessionDetailResult;
  readonly attachSession: (payload: TerminalContract.TerminalSessionIdPayload) => TerminalContract.TerminalAttachPolicyResult;
  readonly detachSession: (payload: TerminalContract.TerminalSessionIdPayload) => TerminalContract.TerminalSessionDetailResult;
  readonly terminateSession: (payload: TerminalContract.TerminateTerminalSessionPayload) => TerminalContract.TerminalSessionDetailResult;
  readonly writeSession: (payload: TerminalContract.WriteTerminalSessionPayload) => TerminalContract.TerminalSessionDetailResult;
  readonly readSession: (payload: TerminalContract.ReadTerminalSessionPayload) => TerminalContract.TerminalOutputReadResult | Promise<TerminalContract.TerminalOutputReadResult>;
  readonly resizeSession: (payload: TerminalContract.ResizeTerminalSessionPayload) => TerminalContract.TerminalSessionDetailResult;
  readonly closeSession: (payload: TerminalContract.TerminalSessionIdPayload) => TerminalContract.TerminalSessionDetailResult;
}

export type TerminalSessionInfo = TerminalContract.TerminalSessionInfo;
export type TerminalSessionFailure = TerminalContract.TerminalSessionFailure;
export type TerminalSessionIdPayload = TerminalContract.TerminalSessionIdPayload;
export type CreateTerminalSessionPayload = TerminalContract.CreateTerminalSessionPayload;
export type ReadTerminalSessionPayload = TerminalContract.ReadTerminalSessionPayload;
export type TerminalOutputReadResult = TerminalContract.TerminalOutputReadResult;
export type ResizeTerminalSessionPayload = TerminalContract.ResizeTerminalSessionPayload;
export type TerminalSessionDetailResult = TerminalContract.TerminalSessionDetailResult;
export type TerminalSessionListResult = TerminalContract.TerminalSessionListResult;
export type TerminalAttachPolicyResult = TerminalContract.TerminalAttachPolicyResult;
export type TerminateTerminalSessionPayload = TerminalContract.TerminateTerminalSessionPayload;
export type WriteTerminalSessionPayload = TerminalContract.WriteTerminalSessionPayload;
