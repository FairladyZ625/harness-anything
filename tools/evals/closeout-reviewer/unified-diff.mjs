// The fixtures contain text-only Git diffs over unquoted, repository-relative paths.
const fileHeader = /^diff --git a\/([\w./-]+) b\/\1$/u;
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

export function unifiedDiffIssue(diff) {
  if (typeof diff !== "string" || !diff.endsWith("\n")) return "expected a newline-terminated unified diff";
  const lines = diff.slice(0, -1).split("\n");
  let line = 0;
  while (line < lines.length) {
    const file = fileHeader.exec(lines[line++])?.[1];
    if (!file) return `expected a Git file header at line ${line}`;
    const mode = lines[line];
    if (/^(new file|deleted file) mode [0-7]{6}$/u.test(mode)) line++;
    if (/^index [\da-f]+\.\.[\da-f]+(?: [0-7]{6})?$/u.test(lines[line])) line++;
    const before = mode?.startsWith("new file") ? "/dev/null" : `a/${file}`;
    const after = mode?.startsWith("deleted file") ? "/dev/null" : `b/${file}`;
    if (lines[line++] !== `--- ${before}` || lines[line++] !== `+++ ${after}`) {
      return `expected unified diff file markers for ${file}`;
    }

    let hunks = 0;
    while (line < lines.length && !lines[line].startsWith("diff --git ")) {
      const hunk = hunkHeader.exec(lines[line++]);
      if (!hunk) return `expected a hunk header at line ${line}`;
      const [, oldStart, oldCount = "1", newStart, newCount = "1"] = hunk;
      if (![oldStart, oldCount, newStart, newCount].every((part) => Number.isSafeInteger(Number(part)))) {
        return `invalid hunk range at line ${line}`;
      }
      let removed = Number(oldCount);
      let added = Number(newCount);
      let changed = false;
      const start = line;
      while (line < lines.length && /^[- +]/u.test(lines[line])) {
        const prefix = lines[line++][0];
        if (prefix !== "+") removed--;
        if (prefix !== "-") added--;
        if (prefix !== " ") changed = true;
      }
      if (removed !== 0 || added !== 0 || !changed) return `hunk line counts or changes are invalid at line ${start}`;
      hunks++;
    }
    if (hunks === 0) return `missing unified diff hunk for ${file}`;
  }
  return null;
}
