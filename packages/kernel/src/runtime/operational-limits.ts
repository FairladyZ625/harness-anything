const DEFAULT_GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const DEFAULT_PROJECTION_MAX_CHANGED_PATHS = 50_000;

export function resolveGitMaxBufferBytes(env: NodeJS.ProcessEnv = process.env): number {
  return resolveBoundedPositiveInteger(
    "HARNESS_GIT_MAX_BUFFER_BYTES",
    env.HARNESS_GIT_MAX_BUFFER_BYTES,
    DEFAULT_GIT_MAX_BUFFER_BYTES,
    1024 * 1024 * 1024
  );
}

export function resolveProjectionMaxChangedPaths(env: NodeJS.ProcessEnv = process.env): number {
  return resolveBoundedPositiveInteger(
    "HARNESS_PROJECTION_MAX_CHANGED_PATHS",
    env.HARNESS_PROJECTION_MAX_CHANGED_PATHS,
    DEFAULT_PROJECTION_MAX_CHANGED_PATHS,
    1_000_000
  );
}

function resolveBoundedPositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  hardMaximum: number
): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/u.test(raw.trim())) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > hardMaximum) {
    throw new Error(`${name} must be between 1 and ${hardMaximum}.`);
  }
  return parsed;
}
