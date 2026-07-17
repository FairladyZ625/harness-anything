import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function inspectDaemonLogContract(root, paths, routeContracts, violations) {
  const route = routeContracts.find((entry) => entry.id === "daemon.logs.list");
  const expectedRoute = {
    method: "GET",
    path: "/api/daemon/logs",
    inputSchemaId: "daemon-log-list-input/v1",
    outputSchemaId: "daemon-log-page/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    service: "DaemonLogService",
    serviceMethod: "list",
    auth: "local-session-token",
    commandClass: "repo-read"
  };
  if (!route) {
    violations.push(`${paths.registryPath}: missing required daemon.logs.list route`);
  } else {
    for (const [field, expected] of Object.entries(expectedRoute)) {
      if (route[field] !== expected) violations.push(`${paths.registryPath}: daemon.logs.list ${field} must be ${expected}`);
    }
  }
  const serverPath = path.join(root, paths.daemonLogHandlerPath);
  if (!existsSync(serverPath)) {
    violations.push(`${paths.daemonLogHandlerPath}: missing daemon log handler file`);
    return;
  }
  const serverSource = readFileSync(serverPath, "utf8");
  if (!serverSource.includes("service.list")) {
    violations.push(`${paths.daemonLogHandlerPath}: missing daemon handler assertion services.DaemonLogService.list`);
  }
}
