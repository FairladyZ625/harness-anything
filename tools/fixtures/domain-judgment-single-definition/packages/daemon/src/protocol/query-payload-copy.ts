export function copiedProtocolQueryWindow(value: {
  changedAfterRevision?: number;
  updatedAfter?: string;
  updatedBefore?: string;
}): boolean {
  return Number(value.changedAfterRevision) < 0 || (value.updatedAfter ?? "") > (value.updatedBefore ?? "");
}
