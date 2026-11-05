/** A dictionary slot is an allocation address. Digests and replay audits compare the
 * exact word it addresses, preserving every posting column and exposing dangling slots.
 * Unreferenced dictionary addresses have no search meaning and are excluded, like free index pages.
 */
export function pgProjectionStoredRows(table: string): { readonly from: string; readonly row: string } {
  if (table === "ha_decision_read_status")
    return { from: `${table} projection`, row: "to_jsonb(projection)-'generation'" };
  if (table === "ha_search_terms")
    return {
      from: `(SELECT DISTINCT word.tenant_id,word.project_id,word.policy_epoch,word.readers,word.term_key,word.term
        FROM ha_search_terms word WHERE EXISTS (SELECT 1 FROM ha_decision_positions position
          WHERE (position.tenant_id,position.project_id,position.policy_epoch,position.term_slot,position.term_key)
            =(word.tenant_id,word.project_id,word.policy_epoch,word.term_slot,word.term_key))) projection`,
      row: "to_jsonb(projection)",
    };
  if (table === "ha_decision_positions")
    return {
      from: `ha_decision_positions projection LEFT JOIN ha_search_terms dictionary
      ON (dictionary.tenant_id,dictionary.project_id,dictionary.policy_epoch,dictionary.term_slot)
        =(projection.tenant_id,projection.project_id,projection.policy_epoch,projection.term_slot)`,
      row: "(to_jsonb(projection)-'term_slot')||jsonb_build_object('term',dictionary.term)",
    };
  return { from: `${table} projection`, row: "to_jsonb(projection)" };
}
