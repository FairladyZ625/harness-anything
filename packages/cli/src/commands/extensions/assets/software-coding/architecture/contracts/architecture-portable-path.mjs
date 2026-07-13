export function portablePathKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function findPortableCollisions(paths) {
  const grouped = new Map();
  for (const candidate of new Set(paths)) {
    const key = portablePathKey(candidate);
    const entries = grouped.get(key) ?? [];
    entries.push(candidate);
    grouped.set(key, entries);
  }
  return [...grouped.entries()].flatMap(([canonicalPath, entries]) => entries.length > 1
    ? [{ canonicalPath, paths: entries.sort(compareArchitectureText) }]
    : []);
}

export function compareArchitectureText(leftInput, rightInput) {
  const leftPoints = [...String(leftInput).normalize("NFC")].map((character) => character.codePointAt(0));
  const rightPoints = [...String(rightInput).normalize("NFC")].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}
