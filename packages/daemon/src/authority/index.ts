// @slice-activation TW-01 forced-command authority transport consumed by TW-02/TW-03 brokers.
export {
  authorityWireFrameType,
  isAuthorityRequestFrame,
  isAuthorityServerFrame,
  sameAuthorityProtocol
} from "./protocol.ts";
export type {
  AuthorityGetOperationFrame,
  AuthorityHelloFrame,
  AuthorityHelloResult,
  AuthorityNegotiatedProtocol,
  AuthorityReplicaChangeFrame,
  AuthorityRequestFrame,
  AuthorityResponseFrame,
  AuthorityServerFrame,
  AuthorityStreamClosedFrame,
  AuthoritySubmitFrame,
  AuthoritySubmitV2Frame
} from "./protocol.ts";
export { serveAuthorityForcedCommand } from "./forced-command-session.ts";
export type {
  AuthorityForcedCommandOptions,
  AuthorityForcedCommandSession,
  AuthorityTransportObserver
} from "./forced-command-session.ts";
