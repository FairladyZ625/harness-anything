const decisionIdSortAlphabet = [
    ...new Set([..."-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"].map((c) => c.toLowerCase())),
  ].sort((left, right) => left.localeCompare(right)),
  decisionIdSortRanks = new Map(decisionIdSortAlphabet.map((character, rank) => [character, rank])),
  lowercaseSortWeight = "a".localeCompare("A") < 0 ? "!" : '"',
  uppercaseSortWeight = lowercaseSortWeight === "!" ? '"' : "!";

/** Encodes the ASCII identifier collation used by localeCompare into a SQLite BINARY-sortable key. */
export function decisionIdSortKey(decisionId: string): string {
  const primary: string[] = [],
    caseWeight: string[] = [];
  for (const character of decisionId) {
    const rank = decisionIdSortRanks.get(character.toLowerCase());
    if (rank === undefined) throw new Error(`decision id contains unsupported character ${JSON.stringify(character)}`);
    primary.push(String.fromCharCode(33 + rank));
    caseWeight.push(character >= "A" && character <= "Z" ? uppercaseSortWeight : lowercaseSortWeight);
  }
  return `${primary.join("")} ${caseWeight.join("")}`;
}

export function decisionLegacyId(decisionId: string): string | undefined {
  const match = /(?:^|_)E([1-9][0-9]*)(?:_|$)/u.exec(decisionId);
  return match ? `E${Number(match[1])}` : undefined;
}
