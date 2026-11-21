import {
  SETTINGS_DECLARATION_RUNTIME,
  localSettings,
  repositorySettings,
  type RepositorySettingsV1,
  type SettingsV1,
} from "./settings.ts";
import type { CommandInterception } from "./command-interceptions.ts";

/** Flat action-input view of the repository settings for derived rendering surfaces (GUI settings
 * form). Keys mirror the settings update action fields; the closeout gate booleans carry the
 * effective values (explicit override, else the strict-profile baseline) exactly like the update
 * compile treats an omitted-but-materialized override. */
export function repositorySettingsActionValues(read: SettingsV1 | RepositorySettingsV1): {
  readonly [field: string]:
    | string
    | number
    | boolean
    | readonly string[]
    | readonly CommandInterception[]
    | NonNullable<RepositorySettingsV1["roles"]>;
} {
  // The daemon's settings read merges the local fields (locale, GUI deadlines) into one view; a
  // repository-only caller contributes none of them and gets no local values.
  const merged = read as SettingsV1,
    repository = repositorySettings(read),
    local = Object.hasOwn(merged, "locale")
      ? localSettings(merged as unknown as Readonly<Record<string, unknown>>)
      : undefined;
  return SETTINGS_DECLARATION_RUNTIME.actionValues({
    ...repository,
    ...local,
    runtime: { ...repository.runtime, ...local?.runtime },
    decisions: { ...repository.decisions, ...local?.decisions },
  }) as {
    readonly [field: string]:
      | string
      | number
      | boolean
      | readonly string[]
      | readonly CommandInterception[]
      | NonNullable<RepositorySettingsV1["roles"]>;
  };
}
