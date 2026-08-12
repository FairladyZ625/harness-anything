import { currentDaemonProtocolVersion } from "./version.ts";

export { currentDaemonProtocolVersion };
export const jsonRpcMethodContracts = Object.freeze([
  { method: "protocol.hello", requiresRepo: false },
  { method: "daemon.status", requiresRepo: false },
  { method: "daemon.repo.bootstrap", requiresRepo: false },
  { method: "daemon.repo.register", requiresRepo: false },
  { method: "daemon.repo.unregister", requiresRepo: false },
  { method: "repo.task.run", requiresRepo: true }
]);
