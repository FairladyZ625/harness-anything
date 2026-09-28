import {
  SETTINGS_DECLARATION_RUNTIME,
  repositorySettings,
  type RepositorySettingsV1,
  type SettingsV1,
} from "./settings.ts";

/** Flat action-input view of the repository settings for derived rendering surfaces (GUI settings
 * form). Keys mirror the settings update action fields; the closeout gate booleans carry the
 * effective values (explicit override, else the strict-profile baseline) exactly like the update
 * compile treats an omitted-but-materialized override. */
export function repositorySettingsActionValues(read: SettingsV1 | RepositorySettingsV1): {
  readonly [field: string]: string | number | boolean | readonly string[] | NonNullable<RepositorySettingsV1["roles"]>;
} {
  return SETTINGS_DECLARATION_RUNTIME.actionValues({
    ...repositorySettings(read),
    ...(Object.hasOwn(read, "locale") ? { locale: (read as SettingsV1).locale } : {}),
  }) as {
    readonly [field: string]:
      | string
      | number
      | boolean
      | readonly string[]
      | NonNullable<RepositorySettingsV1["roles"]>;
  };
}
