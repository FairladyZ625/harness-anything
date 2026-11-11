export function assertFactAdmissionAtCut(row: { archived: boolean }) {
  return row.archived;
}
export const archiveAllowed = (row: { archived: boolean }) => row.archived !== true;
