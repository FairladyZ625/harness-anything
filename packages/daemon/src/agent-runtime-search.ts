/**
 * The one session-search matcher: daemon group-member filtering and the GUI's round-row
 * filtering call this same function so a query that hits a group also keeps its rows
 * visible (multi-token AND, substring, case-insensitive). The field list is the caller's
 * half of the contract — `commonSearch` in agent-runtime-session-groups.ts and the round/
 * orphan lists in SessionGroupList.tsx must stay the same vocabulary.
 */
export function agentRuntimeSearchMatches(fields: readonly unknown[], tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = fields
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
