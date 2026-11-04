/** Exclusive UTF-8/C-collation boundary; wildcard characters remain literal path bytes. */
export function prefixUpperBound(prefix: string): string | null {
  const points = Array.from(prefix, (character) => character.codePointAt(0)!);
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index]!;
    if (point < 0x10ffff) {
      const next = point === 0xd7ff ? 0xe000 : point + 1;
      return (
        points
          .slice(0, index)
          .map((value) => String.fromCodePoint(value))
          .join("") + String.fromCodePoint(next)
      );
    }
  }
  return null;
}
