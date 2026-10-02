import { Toggle } from "../components/primitives/Toggle.tsx";
import { SegCtl } from "../components/primitives/SegCtl.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { useState } from "react";
import { CloudSlash } from "@phosphor-icons/react";
import { useTheme, type ThemeMode, type UiScale } from "../theme";
import { useMotionPreference, type MotionPreference } from "../motion-config.tsx";
import { t, useI18n, type MessageKey } from "../i18n/index.tsx";
import { STATUS_META } from "../components/badges";
import { Section, Row, Kbd } from "../components/ui/widgets";
import {
  formatDuration,
  formatRelative,
  formatTime,
  readTimeDisplayPrefs,
  supportedTimeZones,
  systemTimeZone,
  writeTimeDisplayPrefs,
  type DateFormatPref,
  type TimeDisplayPrefs,
} from "../model/time.ts";
import { useSettingsMutation } from "../settings-data.ts";
import type { SystemRepoRow } from "../api-client.ts";
import { RepositoriesAndConnectionsView } from "./settings/RepositoriesAndConnectionsView.tsx";
import { RepositorySettingsPanel } from "./settings/RepositorySettingsPanel.tsx";

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

const MOTION_OPTIONS: { key: MotionPreference; labelKey: MessageKey }[] = [
  { key: "system", labelKey: "views.settingsView.motionSystem" },
  { key: "on", labelKey: "views.settingsView.motionOn" },
  { key: "off", labelKey: "views.settingsView.motionOff" },
];

// 时间显示的预览样张:固定在过去(避开「今天」省略日期的收束),相对样张取 3 小时前。
const DATE_FORMAT_OPTIONS: readonly DateFormatPref[] = ["iso", "month-day", "long"];
const DATE_FORMAT_SAMPLE = "2026-09-18T11:02:00.000Z";
const RELATIVE_SAMPLE = Date.now() - 3 * 3_600_000;

// 已实现的快捷键(其余 ⌘K/⌘1..5/R/X 暂未实现,已从此清单移除以免假承诺)。
const SHORTCUTS: { keys: string[]; descKey: MessageKey }[] = [
  { keys: ["Esc"], descKey: "views.settingsView.shortcutClosePreviewDrawer" },
  { keys: ["Enter"], descKey: "views.settingsView.shortcutOpenTaskDetail" },
];

type SettingsTab =
  | "repositories"
  | "repository"
  | "appearance"
  | "timeDisplay"
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
  {
    id: "timeDisplay",
    labelKey: "views.settingsView.tabTimeDisplay",
    descKey: "views.settingsView.tabTimeDisplayDesc",
  },
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
  const { preference: motionPreference, setPreference: setMotionPreference } = useMotionPreference();
  const { locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(repoId === null ? "repositories" : "repository");
  const [notifyOnReady, setNotifyOnReady] = useState(true);
  const [timePrefs, setTimePrefs] = useState<TimeDisplayPrefs>(() => readTimeDisplayPrefs());
  const updateTimePrefs = (partial: Partial<TimeDisplayPrefs>) => {
    const next = { ...timePrefs, ...partial };
    writeTimeDisplayPrefs(next);
    setTimePrefs(next);
  };
  const settingsMutation = useSettingsMutation(repoId);
  const renderActivePanel = () => {
    switch (activeTab) {
      case "repositories":
        return <RepositoriesAndConnectionsView repos={repos} activeRepoId={repoId} onOpenProject={onOpenProject} />;
      case "repository":
        return <RepositorySettingsPanel repoId={repoId} onLocaleLoaded={setLocale} />;
      case "appearance":
        return (
          <Section title={t("views.settingsView.sectionAppearance")}>
            <Row label={t("views.settingsView.themeLabel")} desc={t("views.settingsView.themeDescription")}>
              <SegCtl
                value={mode}
                options={THEME_OPTIONS.map(({ key, labelKey }) => ({ value: key, label: t(labelKey) }))}
                onChange={setMode}
              />
            </Row>
            <Row label={t("views.settingsView.motionLabel")} desc={t("views.settingsView.motionDescription")}>
              <SegCtl
                value={motionPreference}
                options={MOTION_OPTIONS.map(({ key, labelKey }) => ({ value: key, label: t(labelKey) }))}
                onChange={setMotionPreference}
              />
            </Row>
            <Row label={t("views.settingsView.uiScaleLabel")} desc={t("views.settingsView.uiScaleDescription")}>
              <SegCtl
                value={uiScale}
                options={SCALE_OPTIONS.map(({ key, labelKey }) => ({ value: key, label: t(labelKey) }))}
                onChange={setUiScale}
              />
            </Row>
            <Row
              label={t("views.settingsView.statusColorsLabel")}
              desc={t("views.settingsView.statusColorsDescription")}
            >
              <div className="flex flex-wrap items-center gap-3">
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
      case "timeDisplay":
        return (
          <Section title={t("views.settingsView.sectionTimeDisplay")}>
            <Row
              label={t("views.settingsView.timeZoneLabel")}
              desc={t("views.settingsView.timeZoneDescription", { system: systemTimeZone() })}
            >
              <select
                aria-label={t("views.settingsView.timeZoneLabel")}
                className="rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
                value={timePrefs.timeZone ?? ""}
                onChange={(event) => updateTimePrefs({ timeZone: event.currentTarget.value || null })}
              >
                <option value="">{t("views.settingsView.timeZoneFollowSystem")}</option>
                {supportedTimeZones().map((timeZone) => (
                  <option key={timeZone} value={timeZone}>
                    {timeZone}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("views.settingsView.dateFormatLabel")} desc={t("views.settingsView.dateFormatDescription")}>
              <SegCtl
                value={timePrefs.dateFormat}
                options={DATE_FORMAT_OPTIONS.map((dateFormat) => ({
                  value: dateFormat,
                  // 选项标签即实时预览:固定样张在当前时区与小时制下的实际写法。
                  label:
                    formatTime(DATE_FORMAT_SAMPLE, { style: "date-time", prefs: { ...timePrefs, dateFormat } }) ??
                    dateFormat,
                }))}
                onChange={(dateFormat) => updateTimePrefs({ dateFormat })}
              />
            </Row>
            <Row label={t("views.settingsView.hourCycleLabel")}>
              <SegCtl
                value={timePrefs.hour12 ? "h12" : "h23"}
                options={[
                  {
                    value: "h23" as const,
                    label:
                      formatTime(DATE_FORMAT_SAMPLE, { style: "time", prefs: { ...timePrefs, hour12: false } }) ??
                      t("views.settingsView.hourCycle24"),
                  },
                  {
                    value: "h12" as const,
                    label:
                      formatTime(DATE_FORMAT_SAMPLE, { style: "time", prefs: { ...timePrefs, hour12: true } }) ??
                      t("views.settingsView.hourCycle12"),
                  },
                ]}
                onChange={(next) => updateTimePrefs({ hour12: next === "h12" })}
              />
            </Row>
            <Row label={t("views.settingsView.listStyleLabel")} desc={t("views.settingsView.listStyleDescription")}>
              <SegCtl
                value={timePrefs.listStyle}
                options={[
                  {
                    value: "relative" as const,
                    label: formatRelative(RELATIVE_SAMPLE, { prefs: timePrefs }),
                  },
                  {
                    value: "absolute" as const,
                    label:
                      formatTime(new Date(RELATIVE_SAMPLE).toISOString(), {
                        style: "date-time",
                        prefs: timePrefs,
                      }) ?? t("views.settingsView.listStyleAbsolute"),
                  },
                ]}
                onChange={(listStyle) => updateTimePrefs({ listStyle })}
              />
            </Row>
            <Row label={t("views.settingsView.timePreviewLabel")}>
              <span className="font-mono ui-meta text-text-muted">
                {formatRelative(RELATIVE_SAMPLE)} · {formatTime(DATE_FORMAT_SAMPLE, { style: "date-time-seconds" })} ·{" "}
                {formatDuration(4 * 60_000 + 45_000)}
              </span>
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
              <Button disabled tip={t("views.settingsView.notSupportedYet")}>
                {t("views.settingsView.rebindAction")}
              </Button>
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
              <Toggle
                label={t("views.settingsView.notifyCloseoutReadyLabel")}
                checked={notifyOnReady}
                onChange={setNotifyOnReady}
                disabled
              />
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
              <Button disabled tip={t("views.settingsView.notSupportedYet")}>
                {t("views.settingsView.exportAction")}
              </Button>
            </Row>
          </Section>
        );
      case "privacy":
        return (
          <Section title={t("views.settingsView.sectionPrivacy")}>
            <Row label={t("views.settingsView.telemetryLabel")} desc={t("views.settingsView.telemetryDescription")}>
              <Toggle label={t("views.settingsView.telemetryLabel")} checked={false} disabled />
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
              <Button disabled tip={t("views.settingsView.syncV2Title")}>
                {t("views.settingsView.syncSignInAction")}
              </Button>
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
        <h1 className="ui-title font-semibold">{t("settings.title")}</h1>
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
