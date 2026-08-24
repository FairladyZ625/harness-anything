const sourceIdentityPattern = /\/\*\s*@gate-identity\s+([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\s*\*\/\s*$/u;

export function readSourceIdentity(node, sourceFile, gateId) {
  const start = node.getStart(sourceFile);
  const prefix = sourceFile.text.slice(Math.max(0, start - 256), start);
  const match = sourceIdentityPattern.exec(prefix);
  return match?.[1] === gateId ? match[2] : null;
}
