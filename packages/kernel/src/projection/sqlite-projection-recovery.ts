import { isRecoverableProjectionDatabaseError, sqliteErrorDetail } from "./sqlite-projection-error.ts";

export type ProjectionDatabaseRecovery<A> =
  | { readonly recovered: false }
  | { readonly recovered: true; readonly value: A };

export function updateProjectionWithRecovery<A>(
  update: () => void,
  rebuild: () => A
): ProjectionDatabaseRecovery<A> {
  try {
    update();
    return { recovered: false };
  } catch (error) {
    if (!isRecoverableProjectionDatabaseError(error)) throw error;
    try {
      return { recovered: true, value: rebuild() };
    } catch (rebuildError) {
      throw new Error(
        `Projection recovery rebuild failed after ${sqliteErrorDetail(error)}: ${sqliteErrorDetail(rebuildError)}`,
        { cause: rebuildError }
      );
    }
  }
}
