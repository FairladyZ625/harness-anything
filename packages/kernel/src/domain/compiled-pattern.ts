// One compiled RegExp per distinct pattern string, bounded by the schemas and kind contracts
// the process has validated; shared by every identity/pattern check in the domain.
const compiledPatterns = new Map<string, RegExp>();

export function compiledPattern(pattern: string): RegExp {
  const cached = compiledPatterns.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(pattern, "u");
  compiledPatterns.set(pattern, compiled);
  return compiled;
}
