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
    const isNewFile = Boolean(mode?.startsWith("new file mode "));
    const isDeletedFile = Boolean(mode?.startsWith("deleted file mode "));
    if (/^(new file|deleted file) mode [0-7]{6}$/u.test(mode)) line++;
    if (/^index [\da-f]+\.\.[\da-f]+(?: [0-7]{6})?$/u.test(lines[line])) line++;
    const before = isNewFile ? "/dev/null" : `a/${file}`;
    const after = isDeletedFile ? "/dev/null" : `b/${file}`;
    if (lines[line++] !== `--- ${before}` || lines[line++] !== `+++ ${after}`) {
      return `expected unified diff file markers for ${file}`;
    }

    let hunks = 0;
    while (line < lines.length && !lines[line].startsWith("diff --git ")) {
      const hunk = hunkHeader.exec(lines[line++]);
      if (!hunk) return `expected a hunk header at line ${line}`;
      const [, oldStartRaw, oldCountRaw = "1", newStartRaw, newCountRaw = "1"] = hunk;
      if (![oldStartRaw, oldCountRaw, newStartRaw, newCountRaw].every((part) => Number.isSafeInteger(Number(part)))) {
        return `invalid hunk range at line ${line}`;
      }
      const oldStart = Number(oldStartRaw);
      const oldCount = Number(oldCountRaw);
      const newStart = Number(newStartRaw);
      const newCount = Number(newCountRaw);
      if (isNewFile && (oldStart !== 0 || oldCount !== 0)) {
        return `new file ${file} depends on old contents at line ${line}`;
      }
      if (isDeletedFile && (newStart !== 0 || newCount !== 0)) {
        return `deleted file ${file} still has contents at line ${line}`;
      }
      if (!isNewFile && (oldCount === 0 ? oldStart !== 0 : oldStart <= 0)) {
        return `invalid old hunk start for ${file} at line ${line}`;
      }
      if (!isDeletedFile && (newCount === 0 ? newStart !== 0 : newStart <= 0)) {
        return `invalid new hunk start for ${file} at line ${line}`;
      }
      let removed = oldCount;
      let added = newCount;
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
