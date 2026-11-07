// Initial inventory for the first ForwardingPort slice. Entries are fingerprints, not exemptions:
// production counts may only decrease. Slice 4 removes this file when all forwarding construction
// has moved behind the port.
export const fleetForwardingBoundaryBaseline = Object.freeze({
  "packages/cli/src/daemon/fleet-command-route.ts": Object.freeze({
    readFleetEdgeConfig: 3,
    edgeRuntimeFor: 0,
    fromFileSpecialCase: 0,
    bodyFileSpecialCase: 0,
    idsFileSpecialCase: 0,
  }),
  "packages/daemon/src/fleet-edge-task.ts": Object.freeze({
    readFleetEdgeConfig: 2,
    edgeRuntimeFor: 0,
    fromFileSpecialCase: 0,
    bodyFileSpecialCase: 0,
    idsFileSpecialCase: 0,
  }),
  "packages/daemon/src/daemon-host-open.ts": Object.freeze({
    readFleetEdgeConfig: 11,
    edgeRuntimeFor: 7,
    fromFileSpecialCase: 0,
    bodyFileSpecialCase: 0,
    idsFileSpecialCase: 0,
  }),
  "packages/daemon/src/protocol/json-rpc-server.ts": Object.freeze({
    readFleetEdgeConfig: 0,
    edgeRuntimeFor: 0,
    fromFileSpecialCase: 0,
    bodyFileSpecialCase: 0,
    idsFileSpecialCase: 0,
  }),
});
