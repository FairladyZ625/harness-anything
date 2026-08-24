// The trailing `[\s(]*` lets an opening parenthesis sit between the marker and
// the node it identifies. Prettier introduces exactly that when it wraps a
// multi-line condition:
//
//     !filters.includeArchived &&
//     /* @gate-identity check-gui-status-judgments/gui-status-033 */
//     (task.packageDisposition !== "active" || ...)
//
// With a bare `\s*$` the marker stopped resolving the moment the formatter added
// that paren, and the gate reported the site as both a brand-new judgment and a
// stale baseline entry — while telling the reader to "remove it rather than
// transferring the exemption", which is the one action that would have made the
// gate go green by dropping a real exemption on the floor. Only whitespace and
// opening parens are allowed through, so any real token between the marker and a
// node still means that node is not the marked one.
const sourceIdentityPattern = /\/\*\s*@gate-identity\s+([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\s*\*\/[\s(]*$/u;

export function readSourceIdentity(node, sourceFile, gateId) {
  const start = node.getStart(sourceFile);
  const prefix = sourceFile.text.slice(Math.max(0, start - 256), start);
  const match = sourceIdentityPattern.exec(prefix);
  return match?.[1] === gateId ? match[2] : null;
}
