import type { GuiBridgeHandlerImplementation, TerminalGuiBridgeMethod } from "./service-bridge.ts";

/**
 * Terminal GUI-bridge handler table — extracted from `service-bridge.ts` so
 * that file stays under the file-complexity cap. Maps each terminal bridge
 * method to its service method + invoker. Type-only imports back to
 * `service-bridge.ts` keep this a one-directional runtime dependency.
 */
export const terminalBridgeHandlerImplementations = {
  terminalCreate: {
    serviceMethod: "createSession",
    invoke: ({ service, payload }) => service.terminalCreate(payload)
  },
  terminalList: {
    serviceMethod: "listSessions",
    invoke: ({ service }) => service.terminalList()
  },
  terminalGet: {
    serviceMethod: "getSession",
    invoke: ({ service, payload }) => service.terminalGet(payload)
  },
  terminalAttach: {
    serviceMethod: "attachSession",
    invoke: ({ service, payload }) => service.terminalAttach(payload)
  },
  terminalDetach: {
    serviceMethod: "detachSession",
    invoke: ({ service, payload }) => service.terminalDetach(payload)
  },
  terminalTerminate: {
    serviceMethod: "terminateSession",
    invoke: ({ service, payload }) => service.terminalTerminate(payload)
  },
  terminalWrite: {
    serviceMethod: "writeSession",
    invoke: ({ service, payload }) => service.terminalWrite(payload)
  },
  terminalRead: {
    serviceMethod: "readSession",
    invoke: ({ service, payload }) => service.terminalRead(payload)
  },
  terminalResize: {
    serviceMethod: "resizeSession",
    invoke: ({ service, payload }) => service.terminalResize(payload)
  },
  terminalExit: {
    serviceMethod: "closeSession",
    invoke: ({ service, payload }) => service.terminalExit(payload)
  }
} as const satisfies Record<TerminalGuiBridgeMethod, GuiBridgeHandlerImplementation>;
