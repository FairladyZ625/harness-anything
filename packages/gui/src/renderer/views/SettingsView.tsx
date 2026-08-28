import { useEffect, useState } from "react";
import { CloudSlash } from "@phosphor-icons/react";
import { useTheme, type ThemeMode, type UiScale } from "../theme";
import { t, useI18n, type MessageKey } from "../i18n/index.tsx";
import { STATUS_META } from "../components/badges";
import { BTN, Section, Row, Segmented, Toggle, Kbd } from "../components/ui/widgets";
import { readTimeZoneOverride, supportedTimeZones, systemTimeZone, writeTimeZoneOverride } from "../model/time.ts";
import { useSettingsMutation, useSettingsQuery } from "../settings-data.ts";
import { useCatalogSnapshot } from "../catalog-data.ts";
import type { CatalogPresetRow, SettingsSuccess } from "../api-client.ts";

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
  | "repository"
  | "appearance"
  | "language"
  | "shortcuts"
  | "notifications"
  | "data"
  | "terminal"
  | "privacy"
  | "sync";
type SettingsDraft = SettingsSuccess["settings"];

const SETTINGS_TABS: { id: SettingsTab; labelKey: MessageKey; descKey: MessageKey }[] = [
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
  { id: "terminal", labelKey: "views.settingsView.tabTerminal", descKey: "views.settingsView.tabTerminalDesc" },
  { id: "privacy", labelKey: "views.settingsView.tabPrivacy", descKey: "views.settingsView.tabPrivacyDesc" },
  { id: "sync", labelKey: "views.settingsView.tabSync", descKey: "views.settingsView.tabSyncDesc" },
];

const SYNC_FEATURE_KEYS: readonly MessageKey[] = [
  "views.settingsView.syncFeatureMultiDevice",
  "views.settingsView.syncFeatureRemoteAccess",
  "views.settingsView.syncFeatureMobileReview",
];

export function SettingsView({ repoId }: { readonly repoId: string }) {
  const { mode, setMode, uiScale, setUiScale } = useTheme();
  const { locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>("repository");
  const [notifyOnReady, setNotifyOnReady] = useState(true);
  const [timeZoneOverride, setTimeZoneOverride] = useState(() => readTimeZoneOverride() ?? "");
  const settingsQuery = useSettingsQuery(repoId);
  const settingsMutation = useSettingsMutation(repoId);
  const catalogQuery = useCatalogSnapshot(repoId);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setDraft(settingsQuery.data.settings);
    setLocale(settingsQuery.data.settings.locale);
  }, [settingsQuery.data, setLocale]);

  const updateDraft = (
    field: keyof Pick<SettingsDraft, "defaultVertical" | "defaultPreset" | "defaultProfile">,
    value: string,
  ) => setDraft((current) => (current ? { ...current, [field]: value } : current));

  // 仓库设置的每个字段取值面都是可枚举的,枚举来源是 daemon 目录快照,不是手打字符串。
  // 目录读不到时选择器停用(fail closed),不回退成自由文本输入。
  const snapshot = catalogQuery.data,
    catalogBlocked = catalogQuery.isPending || !!catalogQuery.error,
    verticalOptions = selectorOptions(
      (snapshot?.verticals ?? []).map((row) => ({
        value: row.id,
        label:
          row.available && row.valid ? row.id : t("views.settingsView.catalogUnavailableOption", { value: row.id }),
      })),
      draft?.defaultVertical,
    ),
    presetOptions = selectorOptions(
      (snapshot?.presets ?? [])
        .filter((row) => row.verticalId === draft?.defaultVertical)
        .map((row) => ({
          value: row.id,
          label: row.validity === "valid" ? `${row.id} · ${row.title}` : `${row.id} · ${row.validity}`,
        })),
      draft?.defaultPreset,
    ),
    selectedPreset = (snapshot?.presets ?? []).find(
      (row) => row.id === draft?.defaultPreset && row.verticalId === draft?.defaultVertical,
    ),
    profileOptions = selectorOptions(
      cataloguedProfiles(selectedPreset).map((profile) => ({
        value: profile.id,
        label: `${profile.id} · ${profile.title}`,
      })),
      draft?.defaultProfile,
    ),
    taskScaffoldOptions = selectorOptions(
      (snapshot?.scaffolds.task ?? []).map((value) => ({ value })),
      draft?.scaffolds.task,
    ),
    repositoryScaffoldOptions = selectorOptions(
      (snapshot?.scaffolds.repository ?? []).map((value) => ({ value })),
      draft?.scaffolds.repository,
    );

  const chooseVertical = (verticalId: string) =>
    setDraft((current) => {
      if (!current) return current;
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
      if (!current) return current;
      const row = (snapshot?.presets ?? []).find(
        (candidate) => candidate.id === presetId && candidate.verticalId === current.defaultVertical,
      );
      return selectPreset(current, presetId, row);
    });

  const renderActivePanel = () => {
    switch (activeTab) {
      case "repository":
        if (settingsQuery.error)
          return (
            <Section title={t("views.settingsView.sectionRepository")}>
              <div className="p-4 text-danger">{String(settingsQuery.error)}</div>
            </Section>
          );
        if (settingsQuery.isPending || !draft)
          return (
            <Section title={t("views.settingsView.sectionRepository")}>
              <div className="p-4 text-text-faint">{t("views.settingsView.readingSettings")}</div>
            </Section>
          );
        return (
          <Section
            title={t("views.settingsView.sectionRepository")}
            action={
              <button
                className={BTN}
                disabled={settingsMutation.isPending}
                onClick={() =>
                  settingsMutation.mutate({
                    defaultVertical: draft.defaultVertical,
                    defaultPreset: draft.defaultPreset,
                    defaultProfile: draft.defaultProfile,
                    taskScaffold: draft.scaffolds.task,
                    repositoryScaffold: draft.scaffolds.repository,
                  })
                }
              >
                {settingsMutation.isPending
                  ? t("views.settingsView.submitPending")
                  : t("views.settingsView.submitToRepository")}
              </button>
            }
          >
            <Row
              label={t("views.settingsView.defaultVerticalLabel")}
              desc={t("views.settingsView.verticalDescription")}
            >
              <SettingSelect
                label={t("views.settingsView.defaultVerticalLabel")}
                testId="settings-vertical-select"
                value={draft.defaultVertical}
                disabled={catalogBlocked}
                options={verticalOptions}
                onChange={chooseVertical}
              />
            </Row>
            <Row label={t("views.settingsView.defaultPresetLabel")} desc={t("views.settingsView.presetDescription")}>
              <SettingSelect
                label={t("views.settingsView.defaultPresetLabel")}
                testId="settings-preset-select"
                value={draft.defaultPreset}
                disabled={catalogBlocked}
                options={presetOptions}
                onChange={choosePreset}
              />
            </Row>
            <Row label={t("views.settingsView.defaultProfileLabel")} desc={t("views.settingsView.profileDescription")}>
              <SettingSelect
                label={t("views.settingsView.defaultProfileLabel")}
                testId="settings-profile-select"
                value={draft.defaultProfile}
                disabled={catalogBlocked}
                options={profileOptions}
                onChange={(value) => updateDraft("defaultProfile", value)}
              />
            </Row>
            <Row
              label={t("views.settingsView.taskScaffoldLabel")}
              desc={t("views.settingsView.taskScaffoldDescription")}
            >
              <SettingSelect
                label={t("views.settingsView.taskScaffoldLabel")}
                testId="settings-task-scaffold-select"
                value={draft.scaffolds.task}
                disabled={catalogBlocked}
                options={taskScaffoldOptions}
                onChange={(value) => setDraft({ ...draft, scaffolds: { ...draft.scaffolds, task: value } })}
              />
            </Row>
            <Row
              label={t("views.settingsView.repositoryScaffoldLabel")}
              desc={t("views.settingsView.repositoryScaffoldDescription")}
            >
              <SettingSelect
                label={t("views.settingsView.repositoryScaffoldLabel")}
                testId="settings-repository-scaffold-select"
                value={draft.scaffolds.repository}
                disabled={catalogBlocked}
                options={repositoryScaffoldOptions}
                onChange={(value) => setDraft({ ...draft, scaffolds: { ...draft.scaffolds, repository: value } })}
              />
            </Row>
            <Row label={t("views.settingsView.ownershipLabel")} desc={t("views.settingsView.ownershipDescription")}>
              <span className="font-mono text-[12px] text-text-muted">
                settings/{draft.settingsId} · {draft.schema}
              </span>
            </Row>
            {catalogQuery.error ? (
              <div className="px-3 py-2 text-[12px] text-danger">
                {t("views.settingsView.catalogUnavailableHint", { error: String(catalogQuery.error) })}
              </div>
            ) : null}
            {settingsMutation.error ? (
              <div className="px-3 py-2 text-[12px] text-danger">{String(settingsMutation.error)}</div>
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
                className="rounded border border-border bg-surface-raised px-2 py-1 font-mono text-[12px] text-text"
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
                    <span className="font-mono text-[12px] text-text-muted">{meta.label}</span>
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
                className="rounded border border-border bg-surface-raised px-2 py-1 text-[12px] text-text"
                value={locale}
                onChange={(event) => {
                  const next = event.currentTarget.value as "zh-CN" | "en-US";
                  setLocale(next);
                  setDraft((current) => (current ? { ...current, locale: next } : current));
                  settingsMutation.mutate({ locale: next });
                }}
              >
                <option value="zh-CN">{t("views.settingsView.chinese")}</option>
                <option value="en-US">{t("views.settingsView.english")}</option>
              </select>
            </Row>
            {settingsMutation.error ? (
              <div className="px-3 py-2 text-[12px] text-danger">{String(settingsMutation.error)}</div>
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
                      {i > 0 && <span className="text-[11px] text-text-faint">–</span>}
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
              <span className="max-w-full break-all font-mono text-[11px] text-text-muted">
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
      case "terminal":
        return (
          <Section title={t("views.settingsView.sectionTerminal")}>
            <Row label={t("views.settingsView.defaultShellLabel")}>
              <span className="font-mono text-[13px] text-text-muted">/bin/zsh</span>
            </Row>
            <Row label={t("views.settingsView.fontLabel")}>
              <span className="font-mono text-[13px] text-text-muted">Geist Mono</span>
            </Row>
            <Row label={t("views.settingsView.fontSizeLabel")}>
              <span className="font-mono text-[13px] text-text-muted">15</span>
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
                <span className="font-mono text-[12px]">·</span>
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
              <span className="text-[14px] font-semibold">{t(tab.labelKey)}</span>
              <span className="mt-0.5 hidden text-[12px] text-text-faint lg:block">{t(tab.descKey)}</span>
            </button>
          ))}
        </nav>

        <div className="min-w-0">{renderActivePanel()}</div>
      </div>
    </div>
  );
}

function SettingSelect({
  label,
  testId,
  value,
  options,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly options: readonly SelectorOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className={[
        "w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1",
        "font-mono text-[12px] text-text disabled:cursor-not-allowed disabled:opacity-40",
      ].join(" ")}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface SelectorOption {
  readonly value: string;
  readonly label: string;
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
