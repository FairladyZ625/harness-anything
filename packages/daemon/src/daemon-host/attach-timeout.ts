export const DEFAULT_DAEMON_ATTACH_TIMEOUT_MS = 60_000;
export const MAX_DAEMON_ATTACH_TIMEOUT_MS = 2_147_483_647;
export const DAEMON_ATTACH_TIMEOUT_ENV = "HARNESS_DAEMON_ATTACH_TIMEOUT_MS";

export function parseDaemonAttachTimeoutMs(
  raw: string | number | undefined,
  source = DAEMON_ATTACH_TIMEOUT_ENV,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_DAEMON_ATTACH_TIMEOUT_MS) {
      throw new Error(
        `Invalid ${source}: ${String(raw)} (expected a positive integer <= ${MAX_DAEMON_ATTACH_TIMEOUT_MS}).`,
      );
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/u.test(trimmed)) {
    throw new Error(
      `Invalid ${source}: ${JSON.stringify(raw)} (expected a positive integer <= ${MAX_DAEMON_ATTACH_TIMEOUT_MS}).`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DAEMON_ATTACH_TIMEOUT_MS) {
    throw new Error(
      `Invalid ${source}: ${JSON.stringify(raw)} (expected a positive integer <= ${MAX_DAEMON_ATTACH_TIMEOUT_MS}).`,
    );
  }
  return parsed;
}

export function configuredDaemonAttachTimeoutMs(raw: number | undefined): number {
  return parseDaemonAttachTimeoutMs(raw, "attachTimeoutMs") ?? DEFAULT_DAEMON_ATTACH_TIMEOUT_MS;
}

export function resolveDaemonAttachTimeoutMs(
  env: Readonly<Record<string, string | undefined>>,
  override?: string | number,
): number {
  const parsed =
    override !== undefined
      ? parseDaemonAttachTimeoutMs(override, "--attach-timeout-ms")
      : parseDaemonAttachTimeoutMs(env[DAEMON_ATTACH_TIMEOUT_ENV], DAEMON_ATTACH_TIMEOUT_ENV);
  return parsed ?? DEFAULT_DAEMON_ATTACH_TIMEOUT_MS;
}
