export function copiedProtocolReceiptAcceptance(value: { status?: string; outcome?: string }): readonly string[] {
  if (value.status === "settled_no_write" && value.outcome !== "no_changes" && value.outcome !== "applied")
    return ["settled_no_write requires no_changes or applied"];
  return [];
}
