import type {
  DaemonControlService,
  DaemonLogService,
  DaemonStatusService,
  LocalControllerService
} from "../../../application/src/index.ts";
import type { TerminalSessionService } from "../../../application/src/terminal-session-contract.ts";

export type ApiRouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "WS";
export type ApiRouteAuth = "local-session-token" | "ssh-tunnel-local-token" | "none";
export type ApiServiceName = "DaemonControlService" | "DaemonLogService" | "DaemonStatusService" | "LocalControllerService" | "TerminalSessionService";
export type ApiServiceMethod = keyof DaemonControlService | keyof DaemonLogService | keyof DaemonStatusService | keyof LocalControllerService | keyof TerminalSessionService;

export interface ApiRouteContract {
  readonly id: string;
  readonly method: ApiRouteMethod;
  readonly path: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId?: string;
  readonly errorSchemaId: string;
  readonly service: ApiServiceName;
  readonly serviceMethod: ApiServiceMethod;
  readonly auth: ApiRouteAuth;
  readonly guiBridgeMethod?: string;
  readonly leaseRequired?: boolean;
  readonly commandClass?: "admin" | "repo-read" | "repo-write" | "arbiter";
}

export interface ApiSchemaContract {
  readonly id: string;
  readonly owner: "application" | "daemon" | "gui";
  readonly typeName: string;
}

export interface DeferredGuiBridgeContract {
  readonly guiBridgeMethod: string;
  readonly service: "LocalControllerService";
  readonly serviceMethod: keyof LocalControllerService;
  readonly reason: string;
}

export interface TerminalGuiBridgeContract {
  readonly guiBridgeMethod: string;
  readonly routeId: string;
  readonly serviceMethod: keyof TerminalSessionService;
}
