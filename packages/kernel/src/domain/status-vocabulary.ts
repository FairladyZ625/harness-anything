/** Cross-entity status vocabulary public surface. */
export type {
  StatusDivergence,
  StatusEntity,
  StatusVocabulary,
  StatusWordRegistration,
} from "./status-vocabulary-types.ts";
export { statusWordRegister } from "./status-word-register.ts";
export { statusVocabularies } from "./status-vocabulary-catalog.ts";

import type { StatusEntity } from "./status-vocabulary-types.ts";
import { statusWordRegister } from "./status-word-register.ts";

export function statusWords(
  entity: StatusEntity,
  field?: string,
): readonly string[] {
  return statusWordRegister
    .filter(
      (row) =>
        row.entity === entity && (field === undefined || row.field === field),
    )
    .map((row) => row.word);
}

export function statusMeaning(
  word: string,
  entity: StatusEntity,
): string | undefined {
  return statusWordRegister.find(
    (row) => row.word === word && row.entity === entity,
  )?.meaning;
}
