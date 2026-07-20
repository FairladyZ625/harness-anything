const registeredDaemonProtocolHandlers = new Set([
  "packages/daemon/src/authority/forced-command-session.ts"
]);

export function isDaemonProtocolHandler(relativePath) {
  return relativePath.startsWith("packages/daemon/src/protocol/")
    || registeredDaemonProtocolHandlers.has(relativePath);
}

export function daemonProtocolHandlerViolations(relativePath, text) {
  if (!isDaemonProtocolHandler(relativePath)) return [];
  const violations = [];
  if (/from\s+["'][^"']*(?:packages\/kernel\/src\/store|packages\/adapters|@harness-anything\/adapter-)[^"']*["']/.test(text)) {
    violations.push(`${relativePath}: daemon protocol handlers must not import store or adapter implementations`);
  }
  if (/\bWriteCoordinator\.(?:enqueue|flush)\s*\(|\bcoordinator\.(?:enqueue|flush)\s*\(|\.(?:writeDocument|archivePackage)\s*\(/.test(text)) {
    violations.push(`${relativePath}: daemon protocol handlers must not perform write coordination or authored writes directly`);
  }
  if (/switch\s*\([^)]*status[^)]*\)|if\s*\([^)]*status[^)]*(?:===|!==|==|!=)/i.test(text)) {
    violations.push(`${relativePath}: daemon protocol handlers must not infer business state from status values`);
  }
  return violations;
}
