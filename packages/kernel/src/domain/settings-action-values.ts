import { repositorySettings, type RepositorySettingsV1, type SettingsV1 } from "./settings.ts";

/** Flat action-input view of the repository settings for derived rendering surfaces (GUI settings
 * form). Keys mirror the settings update action fields; the closeout gate booleans carry the
 * effective values (explicit override, else the strict-profile baseline) exactly like the update
 * compile treats an omitted-but-materialized override. */
export function repositorySettingsActionValues(read: SettingsV1 | RepositorySettingsV1): {
  readonly [field: string]: string | number | boolean | readonly string[];
} {
  const settings = repositorySettings(read),
    closeoutGate = (gate: keyof NonNullable<RepositorySettingsV1["closeout"]["overrides"]>) =>
      settings.closeout.overrides?.[gate] ?? settings.closeout.profile === "strict";
  return {
    defaultVertical: settings.defaultVertical,
    defaultPreset: settings.defaultPreset,
    defaultProfile: settings.defaultProfile,
    ...(settings.defaultReviewer !== undefined ? { defaultReviewer: settings.defaultReviewer } : {}),
    reviewIndependence: settings.reviewIndependence,
    reviewReturnBudget: settings.reviewReturnBudget,
    taskScaffold: settings.scaffolds.task,
    repositoryScaffold: settings.scaffolds.repository,
    walFlushAdaptive: settings.walFlush.adaptive,
    walFlushEvents: settings.walFlush.events,
    walFlushBytes: settings.walFlush.bytes,
    walFlushMilliseconds: settings.walFlush.milliseconds,
    ciWorkflows: settings.ci.workflows,
    closeoutProfile: settings.closeout.profile,
    closeoutReview: closeoutGate("review"),
    closeoutConsent: closeoutGate("consent"),
    closeoutFactDisposition: closeoutGate("factDisposition"),
    closeoutCodeDoc: closeoutGate("codeDoc"),
    restoreDrillRetention: settings.restoreDrillRetention,
  };
}
