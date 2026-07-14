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
