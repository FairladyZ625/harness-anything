import { useEffect, useState } from "react";
import { CloudSlash } from "@phosphor-icons/react";
import { useTheme, type ThemeMode, type UiScale } from "../theme";
import { t, useI18n, type MessageKey } from "../i18n/index.tsx";
import { STATUS_META } from "../components/badges";
import {
  BTN,
  Section,
  Row,
  Segmented,
  Toggle,
  Kbd,
  SettingSelect,
  type SelectorOption,
} from "../components/ui/widgets";
import { readTimeZoneOverride, supportedTimeZones, systemTimeZone, writeTimeZoneOverride } from "../model/time.ts";
import { useSettingsMutation, useSettingsQuery } from "../settings-data.ts";
import { useCatalogSnapshot } from "../catalog-data.ts";
import type { CatalogPresetRow, SystemRepoRow } from "../api-client.ts";
import {
  formatStringArrayInput,
  parseStringArrayInput,
  settingsFormRows,
  settingsPayloadFromDraft,
  type SettingsDraft,
  type SettingsFieldValue,
} from "../settings-form.ts";
import { RepositoriesAndConnectionsView } from "./settings/RepositoriesAndConnectionsView.tsx";

// i18n(task_bff1b8d6):设置页文案一律走 locales(同 task_9f39e256 的 tab 机制),
// 模块级清单只留 id/key,文案键(labelKey/descKey)在渲染期经 t() 取。
const THEME_OPTIONS: { key: ThemeMode; labelKey: MessageKey }[] = [
  { key: "dark", labelKey: "views.settingsView.themeDark" },
  { key: "light", labelKey: "views.settingsView.themeLight" },
  { key: "system", labelKey: "views.settingsView.themeSystem" },
];

const SCALE_OPTIONS: { key: UiScale; labelKey: MessageKey }[] = [
  { key: "compact", labelKey: "views.settingsView.scaleCompact" },
  { key: "standard", labelKey: "views.settingsView.scaleStandard" },
  { key: "comfortable", labelKey: "views.settingsView.scaleComfortable" },
];

// 已实现的快捷键(其余 ⌘K/⌘1..5/R/X 暂未实现,已从此清单移除以免假承诺)。
const SHORTCUTS: { keys: string[]; descKey: MessageKey }[] = [
  { keys: ["Esc"], descKey: "views.settingsView.shortcutClosePreviewDrawer" },
  { keys: ["Enter"], descKey: "views.settingsView.shortcutOpenTaskDetail" },
];

type SettingsTab =
  | "repositories"
  | "repository"
  | "appearance"
  | "language"
  | "shortcuts"
  | "notifications"
  | "data"
  | "privacy"
  | "sync";
const SETTINGS_TABS: { id: SettingsTab; labelKey: MessageKey; descKey: MessageKey }[] = [
  {
    id: "repositories",
    labelKey: "views.settingsView.tabRepositories",
    descKey: "views.settingsView.tabRepositoriesDesc",
  },
  { id: "repository", labelKey: "views.settingsView.tabRepository", descKey: "views.settingsView.tabRepositoryDesc" },
  { id: "appearance", labelKey: "views.settingsView.tabAppearance", descKey: "views.settingsView.tabAppearanceDesc" },
  { id: "language", labelKey: "views.settingsView.tabLanguage", descKey: "views.settingsView.tabLanguageDesc" },
  { id: "shortcuts", labelKey: "views.settingsView.tabShortcuts", descKey: "views.settingsView.tabShortcutsDesc" },
  {
    id: "notifications",
    labelKey: "views.settingsView.tabNotifications",
    descKey: "views.settingsView.tabNotificationsDesc",
  },
  { id: "data", labelKey: "views.settingsView.tabData", descKey: "views.settingsView.tabDataDesc" },
  { id: "privacy", labelKey: "views.settingsView.tabPrivacy", descKey: "views.settingsView.tabPrivacyDesc" },
  { id: "sync", labelKey: "views.settingsView.tabSync", descKey: "views.settingsView.tabSyncDesc" },
];

const SYNC_FEATURE_KEYS: readonly MessageKey[] = [
  "views.settingsView.syncFeatureMultiDevice",
  "views.settingsView.syncFeatureRemoteAccess",
  "views.settingsView.syncFeatureMobileReview",
];

// 字段文案注册表:只登记文案,不登记结构——字段集合、控件类型、取值面全部从
// catalog snapshot 的 settingsFields(daemon 与 settings 动作目录同一单源)派生。
// 未登记文案的字段回落显示字段名(mono),新字段零改动即可用。
const FIELD_COPY: Readonly<Record<string, { readonly labelKey: MessageKey; readonly descKey: MessageKey }>> = {
  defaultVertical: {
    labelKey: "views.settingsView.defaultVerticalLabel",
    descKey: "views.settingsView.verticalDescription",
  },
  defaultPreset: {
    labelKey: "views.settingsView.defaultPresetLabel",
    descKey: "views.settingsView.presetDescription",
  },
  defaultProfile: {
    labelKey: "views.settingsView.defaultProfileLabel",
    descKey: "views.settingsView.profileDescription",
  },
  defaultReviewer: {
    labelKey: "views.settingsView.defaultReviewerLabel",
    descKey: "views.settingsView.defaultReviewerDescription",
  },
  reviewIndependence: {
    labelKey: "views.settingsView.reviewIndependenceLabel",
    descKey: "views.settingsView.reviewIndependenceDescription",
  },
  reviewReturnBudget: {
    labelKey: "views.settingsView.reviewReturnBudgetLabel",
    descKey: "views.settingsView.reviewReturnBudgetDescription",
  },
  taskScaffold: {
    labelKey: "views.settingsView.taskScaffoldLabel",
    descKey: "views.settingsView.taskScaffoldDescription",
  },
  repositoryScaffold: {
    labelKey: "views.settingsView.repositoryScaffoldLabel",
    descKey: "views.settingsView.repositoryScaffoldDescription",
  },
  walFlushAdaptive: {
    labelKey: "views.settingsView.walFlushAdaptiveLabel",
    descKey: "views.settingsView.walFlushAdaptiveDescription",
  },
  walFlushEvents: {
    labelKey: "views.settingsView.walFlushEventsLabel",
    descKey: "views.settingsView.walFlushEventsDescription",
  },
  walFlushBytes: {
    labelKey: "views.settingsView.walFlushBytesLabel",
    descKey: "views.settingsView.walFlushBytesDescription",
  },
  walFlushMilliseconds: {
    labelKey: "views.settingsView.walFlushMillisecondsLabel",
    descKey: "views.settingsView.walFlushMillisecondsDescription",
  },
  ciWorkflows: {
    labelKey: "views.settingsView.ciWorkflowsLabel",
    descKey: "views.settingsView.ciWorkflowsDescription",
  },
  closeoutProfile: {
    labelKey: "views.settingsView.closeoutProfileLabel",
    descKey: "views.settingsView.closeoutProfileDescription",
  },
  closeoutReview: {
    labelKey: "views.settingsView.closeoutReviewLabel",
    descKey: "views.settingsView.closeoutGateDescription",
  },
  closeoutConsent: {
    labelKey: "views.settingsView.closeoutConsentLabel",
    descKey: "views.settingsView.closeoutGateDescription",
  },
  closeoutFactDisposition: {
    labelKey: "views.settingsView.closeoutFactDispositionLabel",
    descKey: "views.settingsView.closeoutGateDescription",
  },
  closeoutCodeDoc: {
    labelKey: "views.settingsView.closeoutCodeDocLabel",
    descKey: "views.settingsView.closeoutGateDescription",
  },
  restoreDrillRetention: {
    labelKey: "views.settingsView.restoreDrillRetentionLabel",
    descKey: "views.settingsView.restoreDrillRetentionDescription",
  },
};

export function SettingsView({
  repoId,
  repos,
  onOpenProject,
}: {
  /** 当前仓;无仓(首次运行的空态)时为 null,仓库设置页停用、仓库与连接页照常可用。 */
  readonly repoId: string | null;
  readonly repos: readonly SystemRepoRow[];
  readonly onOpenProject: (repoId: string) => void;
}) {
  const { mode, setMode, uiScale, setUiScale } = useTheme();
  const { locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(repoId === null ? "repositories" : "repository");
  const [notifyOnReady, setNotifyOnReady] = useState(true);
  const [timeZoneOverride, setTimeZoneOverride] = useState(() => readTimeZoneOverride() ?? "");
  const settingsQuery = useSettingsQuery(repoId);
  const settingsMutation = useSettingsMutation(repoId);
  const catalogQuery = useCatalogSnapshot(repoId);
  const [draft, setDraft] = useState<SettingsDraft>({});

  useEffect(() => {
    if (!settingsQuery.data) return;
    setDraft(settingsQuery.data.values);
    setLocale(settingsQuery.data.settings.locale);
  }, [settingsQuery.data, setLocale]);

  // 仓库设置的字段面来自 settings 动作契约(目录快照的 settingsFields,daemon 与动作目录
  // 同一单源);目录选择器(vertical/preset/profile/scaffold)的选项来自 daemon 目录快照。
  // 两者都不是手打清单。目录读不到时选择器停用(fail closed),不回退成自由文本输入。
  const snapshot = catalogQuery.data,
    catalogBlocked = catalogQuery.isPending || !!catalogQuery.error,
    rows = settingsFormRows(snapshot?.settingsFields ?? []),
    verticalOptions = selectorOptions(
      (snapshot?.verticals ?? []).map((row) => ({
        value: row.id,
        label:
          row.available && row.valid ? row.id : t("views.settingsView.catalogUnavailableOption", { value: row.id }),
      })),
      typeof draft.defaultVertical === "string" ? draft.defaultVertical : undefined,
    ),
    presetOptions = selectorOptions(
      (snapshot?.presets ?? [])
        .filter((row) => row.verticalId === draft.defaultVertical)
        .map((row) => ({
          value: row.id,
          label: row.validity === "valid" ? `${row.id} · ${row.title}` : `${row.id} · ${row.validity}`,
        })),
      typeof draft.defaultPreset === "string" ? draft.defaultPreset : undefined,
    ),
    selectedPreset = (snapshot?.presets ?? []).find(
      (row) => row.id === draft.defaultPreset && row.verticalId === draft.defaultVertical,
    ),
    profileOptions = selectorOptions(
      cataloguedProfiles(selectedPreset).map((profile) => ({
        value: profile.id,
        label: `${profile.id} · ${profile.title}`,
      })),
      typeof draft.defaultProfile === "string" ? draft.defaultProfile : undefined,
    ),
    taskScaffoldOptions = selectorOptions(
      (snapshot?.scaffolds.task ?? []).map((value) => ({ value })),
      typeof draft.taskScaffold === "string" ? draft.taskScaffold : undefined,
    ),
    repositoryScaffoldOptions = selectorOptions(
      (snapshot?.scaffolds.repository ?? []).map((value) => ({ value })),
      typeof draft.repositoryScaffold === "string" ? draft.repositoryScaffold : undefined,
    );

  const updateDraft = (field: string, value: SettingsFieldValue | undefined) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const chooseVertical = (verticalId: string) =>
    setDraft((current) => {
      const next = { ...current, defaultVertical: verticalId },
        presets = (snapshot?.presets ?? []).filter((row) => row.verticalId === verticalId && row.validity === "valid"),
        defaultPresetId = snapshot?.defaults.verticalId === verticalId ? snapshot.defaults.presetId : undefined,
        row =
          presets.find((candidate) => candidate.id === current.defaultPreset) ??
          presets.find((candidate) => candidate.id === defaultPresetId) ??
          presets[0];
      return row ? selectPreset(next, row.id, row) : next;
    });

  const choosePreset = (presetId: string) =>
    setDraft((current) => {
      const row = (snapshot?.presets ?? []).find(
        (candidate) => candidate.id === presetId && candidate.verticalId === current.defaultVertical,
      );
      return selectPreset(current, presetId, row);
    });

  const renderActivePanel = () => {
    switch (activeTab) {
      case "repositories":
        return <RepositoriesAndConnectionsView repos={repos} activeRepoId={repoId} onOpenProject={onOpenProject} />;
      case "repository":
        if (repoId === null)
          return (
            <Section title={t("views.settingsView.sectionRepository")}>
              <div className="p-4 ui-meta text-text-faint">{t("views.settingsView.repositoryTabNeedsRepo")}</div>
            </Section>
          );
        if (settingsQuery.error)
          return (
            <Section title={t("views.settingsView.sectionRepository")}>
              <div className="p-4 text-danger">{String(settingsQuery.error)}</div>
            </Section>
          );
        if (settingsQuery.isPending)
          return (
            <Section title={t("views.settingsView.sectionRepository")}>
              <div className="p-4 ui-meta text-text-faint">{t("views.settingsView.readingSettings")}</div>
            </Section>
          );
        return (
          <Section
            title={t("views.settingsView.sectionRepository")}
            action={
              <button
                className={BTN}
                disabled={settingsMutation.isPending}
                onClick={() => settingsMutation.mutate(settingsPayloadFromDraft(draft, snapshot?.settingsFields ?? []))}
              >
                {settingsMutation.isPending
                  ? t("views.settingsView.submitPending")
                  : t("views.settingsView.submitToRepository")}
              </button>
            }
          >
            {rows.length === 0 ? (
              <div className="p-4 ui-meta text-text-faint">{t("views.settingsView.readingSettings")}</div>
            ) : (
              rows.map((row) => {
                const copy = FIELD_COPY[row.field],
                  label = copy ? t(copy.labelKey) : row.field,
                  description = copy ? t(copy.descKey) : undefined;
                return (
                  <Row key={row.field} label={label} desc={description}>
                    {renderFieldControl(row, {
                      draft,
                      catalogBlocked,
                      verticalOptions,
                      presetOptions,
                      profileOptions,
                      taskScaffoldOptions,
                      repositoryScaffoldOptions,
                      chooseVertical,
                      choosePreset,
                      updateDraft,
                    })}
                  </Row>
                );
              })
            )}
            <Row label={t("views.settingsView.ownershipLabel")} desc={t("views.settingsView.ownershipDescription")}>
              <span className="font-mono ui-meta text-text-muted">
                settings/{settingsQuery.data.settings.settingsId} · {settingsQuery.data.settings.schema}
              </span>
            </Row>
            {catalogQuery.error ? (
              <div className="px-3 py-2 ui-meta text-danger">
                {t("views.settingsView.catalogUnavailableHint", { error: String(catalogQuery.error) })}
              </div>
            ) : null}
            {settingsMutation.error ? (
              <div className="px-3 py-2 ui-meta text-danger">{String(settingsMutation.error)}</div>
            ) : null}
          </Section>
        );
      case "appearance":
        return (
          <Section title={t("views.settingsView.sectionAppearance")}>
            <Row label={t("views.settingsView.themeLabel")} desc={t("views.settingsView.themeDescription")}>
              <Segmented
                value={mode}
                options={THEME_OPTIONS.map(({ key, labelKey }) => ({ key, label: t(labelKey) }))}
                onChange={setMode}
              />
            </Row>
            <Row label={t("views.settingsView.uiScaleLabel")} desc={t("views.settingsView.uiScaleDescription")}>
              <Segmented
                value={uiScale}
                options={SCALE_OPTIONS.map(({ key, labelKey }) => ({ key, label: t(labelKey) }))}
                onChange={setUiScale}
              />
            </Row>
            <Row
              label={t("views.settingsView.timeZoneLabel")}
              desc={t("views.settingsView.timeZoneDescription", { system: systemTimeZone() })}
            >
              <select
                aria-label={t("views.settingsView.timeZoneLabel")}
                className="rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
                value={timeZoneOverride}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  writeTimeZoneOverride(next || null);
                  setTimeZoneOverride(next);
                }}
              >
                <option value="">{t("views.settingsView.timeZoneFollowSystem")}</option>
                {supportedTimeZones().map((timeZone) => (
                  <option key={timeZone} value={timeZone}>
                    {timeZone}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              label={t("views.settingsView.statusColorsLabel")}
              desc={t("views.settingsView.statusColorsDescription")}
            >
              <div className="flex flex-wrap items-center justify-end gap-3">
                {Object.entries(STATUS_META).map(([key, meta]) => (
                  <span key={key} className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
                    <span className="font-mono ui-meta text-text-muted">{meta.label}</span>
                  </span>
                ))}
              </div>
            </Row>
          </Section>
        );
      case "language":
        return (
          <Section title={t("views.settingsView.sectionLanguage")}>
            <Row label={t("settings.language")} desc={t("views.settingsView.languageDescription")}>
              <select
                aria-label={t("views.settingsView.tabLanguage")}
                className="rounded border border-border bg-surface-raised px-2 py-1 ui-meta text-text"
                value={locale}
                onChange={(event) => {
                  const next = event.currentTarget.value as "zh-CN" | "en-US";
                  setLocale(next);
                  settingsMutation.mutate({ locale: next });
                }}
              >
                <option value="zh-CN">{t("views.settingsView.chinese")}</option>
                <option value="en-US">{t("views.settingsView.english")}</option>
              </select>
            </Row>
            {settingsMutation.error ? (
              <div className="px-3 py-2 ui-meta text-danger">{String(settingsMutation.error)}</div>
            ) : null}
          </Section>
        );
      case "shortcuts":
        return (
          <Section
            title={t("views.settingsView.sectionShortcuts")}
            action={
              <button disabled title={t("views.settingsView.notSupportedYet")} className={BTN}>
                {t("views.settingsView.rebindAction")}
              </button>
            }
          >
            {SHORTCUTS.map((s) => (
              <div
                key={s.descKey}
                className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0"
              >
                <span className="flex w-28 shrink-0 items-center gap-1">
                  {s.keys.map((k, i) => (
                    <span key={k} className="inline-flex items-center gap-1">
                      {i > 0 && <span className="ui-micro text-text-faint">–</span>}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </span>
                <span className="ui-meta text-text-muted">{t(s.descKey)}</span>
              </div>
            ))}
          </Section>
        );
      case "notifications":
        return (
          <Section title={t("views.settingsView.sectionNotifications")}>
            <Row
              label={t("views.settingsView.notifyCloseoutReadyLabel")}
              desc={t("views.settingsView.notifyCloseoutReadyDescription")}
            >
              <Toggle checked={notifyOnReady} onChange={setNotifyOnReady} disabled />
            </Row>
          </Section>
        );
      case "data":
        return (
          <Section title={t("views.settingsView.sectionData")}>
            <Row
              label={t("views.settingsView.cacheDirectoryLabel")}
              desc={t("views.settingsView.cacheDirectoryDescription")}
            >
              <span className="max-w-full break-all font-mono ui-micro text-text-muted">
                .harness/cache/task.sqlite
              </span>
            </Row>
            <Row
              label={t("views.settingsView.exportDiagnosticsLabel")}
              desc={t("views.settingsView.exportDiagnosticsDescription")}
            >
              <button disabled title={t("views.settingsView.notSupportedYet")} className={BTN}>
                {t("views.settingsView.exportAction")}
              </button>
            </Row>
          </Section>
        );
      case "privacy":
        return (
          <Section title={t("views.settingsView.sectionPrivacy")}>
            <Row label={t("views.settingsView.telemetryLabel")} desc={t("views.settingsView.telemetryDescription")}>
              <Toggle checked={false} disabled />
            </Row>
          </Section>
        );
      case "sync":
        return (
          <Section title={t("views.settingsView.sectionSync")}>
            <div className="flex items-center gap-3 border-b border-border px-3 py-2.5">
              <CloudSlash weight="duotone" className="shrink-0 text-xl text-text-faint" />
              <p className="ui-meta min-w-0 flex-1 text-text-muted">
                {t("views.settingsView.syncLocalModeDescription")}
              </p>
              <button disabled title={t("views.settingsView.syncV2Title")} className={BTN}>
                {t("views.settingsView.syncSignInAction")}
              </button>
            </div>
            {SYNC_FEATURE_KEYS.map((featureKey) => (
              <div
                key={featureKey}
                className={[
                  "ui-meta flex items-center gap-2 border-b border-border px-3 py-1.5",
                  "text-text-faint last:border-b-0",
                ].join(" ")}
              >
                <span className="font-mono ui-meta">·</span>
                {t(featureKey)}
              </div>
            ))}
          </Section>
        );
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <h1 className="ui-title font-mono font-semibold">{t("settings.title")}</h1>
        <p className="ui-meta mt-0.5 text-text-faint">{t("views.settingsView.headerDescription")}</p>
      </header>

      <div
        data-testid="settings-content"
        className="grid w-full grid-cols-1 gap-4 p-4 lg:grid-cols-[12rem_minmax(0,1fr)]"
      >
        <nav
          className={[
            "flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1",
            "lg:flex-col lg:overflow-visible",
          ].join(" ")}
        >
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex shrink-0 flex-col rounded-md px-2.5 py-2 text-left ${
                activeTab === tab.id
                  ? "bg-surface-raised text-text"
                  : "text-text-muted hover:bg-surface-raised/50 hover:text-text"
              }`}
            >
              <span className="ui-body font-semibold">{t(tab.labelKey)}</span>
              <span className="mt-0.5 hidden ui-meta text-text-faint lg:block">{t(tab.descKey)}</span>
            </button>
          ))}
        </nav>

        <div className="min-w-0">{renderActivePanel()}</div>
      </div>
    </div>
  );
}

interface FieldControlProps {
  readonly draft: SettingsDraft;
  readonly catalogBlocked: boolean;
  readonly verticalOptions: readonly SelectorOption[];
  readonly presetOptions: readonly SelectorOption[];
  readonly profileOptions: readonly SelectorOption[];
  readonly taskScaffoldOptions: readonly SelectorOption[];
  readonly repositoryScaffoldOptions: readonly SelectorOption[];
  readonly chooseVertical: (verticalId: string) => void;
  readonly choosePreset: (presetId: string) => void;
  readonly updateDraft: (field: string, value: SettingsFieldValue | undefined) => void;
}

// 稳定 testId:测试与 e2e 探针引用的选择器/输入框沿用历史命名;未登记字段回落
// settings-<field>-select / settings-<field>-input 的通用命名。
const FIELD_TEST_IDS: Readonly<Record<string, string>> = {
  defaultVertical: "settings-vertical-select",
  defaultPreset: "settings-preset-select",
  defaultProfile: "settings-profile-select",
  taskScaffold: "settings-task-scaffold-select",
  repositoryScaffold: "settings-repository-scaffold-select",
  walFlushEvents: "settings-wal-flush-events",
  walFlushBytes: "settings-wal-flush-bytes",
  walFlushMilliseconds: "settings-wal-flush-milliseconds",
};

/** 单字段的控件:widget 由契约类型派生;目录选择器是五个字段的 GUI 特有联动。 */
function renderFieldControl(
  row: { readonly field: string; readonly widget: string; readonly options: readonly string[] | null },
  props: FieldControlProps,
) {
  const { draft, catalogBlocked, updateDraft } = props,
    testId = FIELD_TEST_IDS[row.field];
  switch (row.widget) {
    case "catalog-select": {
      const selector = catalogSelector(row.field, props);
      if (!selector) return <span className="ui-meta text-text-faint">{row.field}</span>;
      return (
        <SettingSelect
          label={row.field}
          testId={testId ?? `settings-${row.field}-select`}
          value={typeof draft[row.field] === "string" ? (draft[row.field] as string) : ""}
          disabled={catalogBlocked}
          options={selector.options}
          onChange={selector.onChange}
        />
      );
    }
    case "enum-select":
      return (
        <SettingSelect
          label={row.field}
          testId={testId ?? `settings-${row.field}-select`}
          value={typeof draft[row.field] === "string" ? (draft[row.field] as string) : ""}
          options={selectorOptions(
            (row.options ?? []).map((value) => ({ value })),
            typeof draft[row.field] === "string" ? (draft[row.field] as string) : undefined,
          )}
          onChange={(value) => updateDraft(row.field, value)}
        />
      );
    case "toggle":
      return <Toggle checked={draft[row.field] === true} onChange={(enabled) => updateDraft(row.field, enabled)} />;
    case "number": {
      const value = draft[row.field];
      return (
        <SettingNumberInput
          label={row.field}
          testId={testId ?? `settings-${row.field}-input`}
          value={typeof value === "number" ? value : 1}
          onChange={(next) => updateDraft(row.field, next)}
        />
      );
    }
    case "string-array":
      return (
        <input
          aria-label={row.field}
          data-testid={testId ?? `settings-${row.field}-input`}
          type="text"
          className="w-64 rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
          value={formatStringArrayInput(draft[row.field])}
          onChange={(event) => updateDraft(row.field, parseStringArrayInput(event.currentTarget.value))}
        />
      );
    default: {
      const value = draft[row.field];
      return (
        <input
          aria-label={row.field}
          data-testid={testId ?? `settings-${row.field}-input`}
          type="text"
          className="w-64 rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateDraft(row.field, event.currentTarget.value.trim())}
        />
      );
    }
  }
}

/** 目录选择器五个字段各自的选项与联动;字段不在注册表内时回落 nil(防御,正常不可达)。 */
function catalogSelector(
  field: string,
  props: FieldControlProps,
): { readonly options: readonly SelectorOption[]; readonly onChange: (value: string) => void } | null {
  switch (field) {
    case "defaultVertical":
      return { options: props.verticalOptions, onChange: props.chooseVertical };
    case "defaultPreset":
      return { options: props.presetOptions, onChange: props.choosePreset };
    case "defaultProfile":
      return { options: props.profileOptions, onChange: (value) => props.updateDraft(field, value) };
    case "taskScaffold":
      return { options: props.taskScaffoldOptions, onChange: (value) => props.updateDraft(field, value) };
    case "repositoryScaffold":
      return { options: props.repositoryScaffoldOptions, onChange: (value) => props.updateDraft(field, value) };
    default:
      return null;
  }
}

function SettingNumberInput({
  label,
  testId,
  value,
  onChange,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <input
      aria-label={label}
      data-testid={testId}
      type="number"
      min={1}
      step={1}
      className="w-36 rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
      value={value}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isSafeInteger(next) && next > 0) onChange(next);
      }}
    />
  );
}

/** 目录取值面 + 当前值取并集:当前值不在目录里也照实显示并保留可提交,
 * 否则一个指向尚未创建文件/未登记 preset 的既有设置会凭空变成空选择。 */
function selectorOptions(
  catalogued: ReadonlyArray<{ readonly value: string; readonly label?: string }>,
  current: string | undefined,
): readonly SelectorOption[] {
  const options = catalogued.map((row) => ({ value: row.value, label: row.label ?? row.value }));
  if (current && !options.some((option) => option.value === current))
    options.push({ value: current, label: t("views.settingsView.catalogMissingOption", { value: current }) });
  return options;
}

/** preset/profile 一致性只在这里收敛:vertical 与 preset 两种切换都复用同一条联动。 */
function selectPreset(current: SettingsDraft, presetId: string, row: CatalogPresetRow | undefined): SettingsDraft {
  const profiles = cataloguedProfiles(row),
    keepProfile = !row || profiles.length === 0 || profiles.some((profile) => profile.id === current.defaultProfile);
  return {
    ...current,
    defaultPreset: presetId,
    defaultProfile: keepProfile ? current.defaultProfile : (row.defaultProfile ?? current.defaultProfile),
  };
}

/** preset 行的 profile 取值面;清单为空时退到该 preset 的 defaultProfile,
 * 两者都没有(目录行不可解析)则交由并集逻辑只保留当前值。 */
function cataloguedProfiles(
  row:
    | {
        readonly profiles: ReadonlyArray<{ readonly id: string; readonly title: string }>;
        readonly defaultProfile: string | null;
      }
    | undefined,
): ReadonlyArray<{ readonly id: string; readonly title: string }> {
  if (!row) return [];
  if (row.profiles.length > 0) return row.profiles;
  return row.defaultProfile ? [{ id: row.defaultProfile, title: row.defaultProfile }] : [];
}
