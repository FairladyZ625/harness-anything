import { inspect } from "node:util";
import { Effect } from "effect";

export function annotateProjectionSqliteStatement<A, E, R>(
  statement: string,
  table: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Error, R> {
  return Effect.mapError(effect, (error) => new Error(
    `SQLite statement ${statement} failed for table ${table}: ${sqliteErrorDetail(error)}`,
    { cause: error }
  ));
}

export function isRecoverableProjectionDatabaseError(error: unknown): boolean {
  const detail = `${sqliteErrorDetail(error)}\n${inspect(error, { depth: 8, breakLength: Infinity })}`;
  return [
    /\bSQLITE_CORRUPT\b/u,
    /\bSQLITE_NOTADB\b/u,
    /\bSQLITE_SCHEMA\b/u,
    /database disk image is malformed/iu,
    /malformed database schema/iu,
    /file is not a database/iu,
    /no such table/iu,
    /no such column/iu,
    /has no column named/iu
  ].some((pattern) => pattern.test(detail));
}

export function sqliteErrorDetail(error: unknown): string {
  const details: string[] = [];
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as { readonly code?: unknown; readonly message?: unknown; readonly cause?: unknown };
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const detail = [code, message].filter(Boolean).join(": ");
    if (detail && !details.includes(detail)) details.push(detail);
    current = nestedErrorCause(record);
  }
  if (details.length > 1) {
    const [driver, ...causes] = details;
    return `${causes.reverse().join(" <- ")} (driver: ${driver})`;
  }
  if (details.length === 1) return details[0]!;
  return inspect(error, { depth: 6, breakLength: Infinity });
}

function nestedErrorCause(record: object & { readonly cause?: unknown }): unknown {
  if (record.cause) return record.cause;
  for (const key of Object.getOwnPropertySymbols(record)) {
    if (key.description !== "effect/Runtime/FiberFailure/Cause") continue;
    const effectCause = (record as Record<symbol, unknown>)[key];
    if (!effectCause || typeof effectCause !== "object") continue;
    const failure = (effectCause as { readonly failure?: unknown }).failure;
    if (failure) return failure;
  }
  return undefined;
}
