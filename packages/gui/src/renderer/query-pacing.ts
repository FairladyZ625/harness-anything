import { guiQueryPacing } from "../api/renderer-dto.ts";

export const QUERY_PACING_MS = guiQueryPacing.defaultValue.intervals;
export const LEDGER_PROBE_FOCUS_REFETCH = guiQueryPacing.defaultValue.ledgerProbeFocusRefetch;
export const rendererQueryDefaults = guiQueryPacing.defaultValue.queryDefaults;
