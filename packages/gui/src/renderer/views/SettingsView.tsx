import { useState } from "react";
import { ArrowsClockwise, CloudSlash } from "@phosphor-icons/react";
import { useTheme, type ThemeMode, type UiScale } from "../theme";
import { STATUS_META } from "../components/badges";
import { BTN, Section, Row, Segmented, Toggle, Kbd } from "../components/ui/widgets";
import { useRebuildGovernanceMutation } from "../task-data";
import { t, useI18n, type Locale } from "../i18n/index.tsx";

const THEME_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: "dark", get label() { return t("views.settingsView.darkColor"); } },
  { key: "light", get label() { return t("views.settingsView.brightColor"); } },
  { key: "system", get label() { return t("views.settingsView.followSystem"); } },
];

const SCALE_OPTIONS: { key: UiScale; label: string }[] = [
  { key: "compact", get label() { return t("views.settingsView.compact"); } },
  { key: "standard", get label() { return t("views.settingsView.standard"); } },
  { key: "comfortable", get label() { return t("views.settingsView.loose"); } },
];

// 已实现的快捷键(其余 ⌘K/⌘1..5/R/X 暂未实现,已从此清单移除以免假承诺)。
const SHORTCUTS: { keys: string[]; desc: string }[] = [
  { keys: ["Esc"], get desc() { return t("views.settingsView.closePreviewDrawer"); } },
  { keys: ["Enter"], get desc() { return t("views.settingsView.openTaskDetailsList"); } },
];

type SettingsTab =
  | "appearance"
  | "language"
  | "shortcuts"
  | "notifications"
  | "data"
  | "terminal"
  | "privacy"
  | "sync";

const SETTINGS_TABS: { id: SettingsTab; label: string; desc: string }[] = [
  { id: "appearance", get label() { return t("views.settingsView.appearance"); }, get desc() { return t("views.settingsView.themesStatusColors"); } },
  { id: "language", get label() { return t("views.settingsView.language"); }, get desc() { return t("views.settingsView.interfaceCopywriting"); } },
  { id: "shortcuts", get label() { return t("views.settingsView.shortcutKeys"); }, get desc() { return t("views.settingsView.globalOperations"); } },
  { id: "notifications", get label() { return t("views.settingsView.notification"); }, get desc() { return t("views.settingsView.archiveReadyReminder"); } },
  { id: "data", get label() { return t("views.settingsView.data"); }, get desc() { return t("views.settingsView.cachingProjection"); } },
  { id: "terminal", get label() { return t("views.settingsView.terminal"); }, get desc() { return t("views.settingsView.shellPreferences"); } },
  { id: "privacy", get label() { return t("views.settingsView.privacy"); }, get desc() { return t("views.settingsView.localDefault"); } },
  { id: "sync", get label() { return t("views.settingsView.accountSynchronization"); }, get desc() { return t("views.settingsView.v2Capabilities"); } },
];

export function SettingsView() {
  const { mode, setMode, uiScale, setUiScale } = useTheme();
  const { locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const [notifyOnReady, setNotifyOnReady] = useState(true);
  // 重建投影 = 重读本地投影缓存(路径A:hook 已就绪,底层只 queryTaskProjection 不写盘重算)。
  const rebuildMutation = useRebuildGovernanceMutation();

  const renderActivePanel = () => {
    switch (activeTab) {
      case "appearance":
        return (
          <Section title={t("views.settingsView.appearance")}>
            <Row
              label={t("views.settingsView.topic")}
              desc={t("views.settingsView.oklchDualThemeSixStateStateColor")}
            >
              <Segmented value={mode} options={THEME_OPTIONS} onChange={setMode} />
            </Row>
            <Row
              label={t("views.settingsView.interfaceScaling")}
              desc={t("views.settingsView.proportionatelyAdjustBodyTitleSwimlaneControlDensity")}
            >
              <Segmented
                value={uiScale}
                options={SCALE_OPTIONS}
                onChange={setUiScale}
              />
            </Row>
            <Row label={t("views.settingsView.statusColor")} desc={t("views.settingsView.colorChangesRealTimeAsThemeSwitches")}>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {Object.entries(STATUS_META).map(([key, meta]) => (
                  <span key={key} className="inline-flex items-center gap-1">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: meta.color }}
                    />
                    <span className="font-mono text-[12px] text-text-muted">
                      {meta.label}
                    </span>
                  </span>
                ))}
              </div>
            </Row>
          </Section>
        );
      case "language":
        return (
          <Section title={t("views.settingsView.language")}>
            <Row label={t("views.settingsView.interfaceLanguage")} desc={t("views.settingsView.interfaceLanguageDescription")}>
              <Segmented
                value={locale}
                options={[
                  { key: "zh-CN" as Locale, label: t("views.settingsView.chinese") },
                  { key: "en-US" as Locale, label: t("views.settingsView.english") },
                ]}
                onChange={setLocale}
              />
            </Row>
          </Section>
        );
      case "shortcuts":
        return (
          <Section
            title={t("views.settingsView.shortcutKeys")}
            action={
              <button disabled title={t("views.settingsView.prototypeNotSupportedYet")} className={BTN}>
                {t("views.settingsView.rebind")}</button>
            }
          >
            {SHORTCUTS.map((s) => (
              <div
                key={s.desc}
                className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0"
              >
                <span className="flex w-28 shrink-0 items-center gap-1">
                  {s.keys.map((k, i) => (
                    <span key={k} className="inline-flex items-center gap-1">
                      {i > 0 && (
                        <span className="text-[10px] text-text-faint">–</span>
                      )}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </span>
                <span className="ui-meta text-text-muted">{s.desc}</span>
              </div>
            ))}
          </Section>
        );
      case "notifications":
        return (
          <Section title={t("views.settingsView.notification")}>
            <Row
              label={t("views.settingsView.archiveReadyDesktopNotification")}
              desc={t("views.settingsView.sendDesktopNotificationWhenCloseoutReadinessReadyElectron")}
            >
              <Toggle checked={notifyOnReady} onChange={setNotifyOnReady} disabled />
            </Row>
          </Section>
        );
      case "data":
        return (
          <Section title={t("views.settingsView.data")}>
            <Row label={t("views.settingsView.cacheDirectory")} desc={t("views.settingsView.localProjectionCacheSqlite")}>
              <span className="max-w-full break-all font-mono text-[11px] text-text-muted">
                ~/.harness/cache/projections.db
              </span>
            </Row>
            <Row label={t("views.settingsView.reconstructProjection")} desc={t("views.settingsView.rereadLocalProjectionCacheNoRecalculationNo")}>
              {rebuildMutation.isError && (
                <span className="ui-meta text-danger">
                  {t("views.settingsView.rereadFailed")}{(rebuildMutation.error as Error)?.message ?? t("views.settingsView.bridgeDidNotReturn")}
                </span>
              )}
              {rebuildMutation.isPending && (
                <span className="ui-meta text-accent">{t("views.settingsView.rereading")}</span>
              )}
              <button
                onClick={() => rebuildMutation.mutate()}
                disabled={rebuildMutation.isPending}
                className={BTN}
              >
                <span className="inline-flex items-center gap-1">
                  <ArrowsClockwise weight="bold" className="text-[12px]" />
                  {t("views.settingsView.rereadProjection")}</span>
              </button>
            </Row>
            <Row label={t("views.settingsView.exportDiagnosticInformation")} desc={t("views.settingsView.packagingLogsProjectedSnapshotsTroubleshooting")}>
              <button disabled title={t("views.settingsView.prototypeNotSupportedYet")} className={BTN}>
                {t("views.settingsView.export")}</button>
            </Row>
          </Section>
        );
      case "terminal":
        return (
          <Section title={t("views.settingsView.terminal")}>
            <Row label={t("views.settingsView.defaultShell")}>
              <span className="font-mono text-[13px] text-text-muted">
                /bin/zsh
              </span>
            </Row>
            <Row label={t("views.settingsView.font")}>
              <span className="font-mono text-[13px] text-text-muted">
                Geist Mono
              </span>
            </Row>
            <Row label={t("views.settingsView.fontSize")}>
              <span className="font-mono text-[13px] text-text-muted">15</span>
            </Row>
          </Section>
        );
      case "privacy":
        return (
          <Section title={t("views.settingsView.privacy")}>
            <Row label={t("views.settingsView.telemetry")} desc={t("views.settingsView.offByDefaultPrototypeDoesNotCollect")}>
              <Toggle checked={false} disabled />
            </Row>
          </Section>
        );
      case "sync":
        return (
          <Section title={t("views.settingsView.accountSynchronization")}>
            <div className="flex items-center gap-3 border-b border-border px-3 py-2.5">
              <CloudSlash
                weight="duotone"
                className="shrink-0 text-xl text-text-faint"
              />
              <p className="ui-meta min-w-0 flex-1 text-text-muted">
                {t("views.settingsView.localModeMultiTerminalSynchronizationAccountSystem")}</p>
              <button disabled title={t("views.settingsView.v2Provides")} className={BTN}>
                {t("views.settingsView.login")}</button>
            </div>
            {[t("views.settingsView.multiDeviceSync"), t("views.settingsView.remoteProjectAccess"), t("views.settingsView.mobileReview")].map((f) => (
              <div
                key={f}
                className="ui-meta flex items-center gap-2 border-b border-border px-3 py-1.5 text-text-faint last:border-b-0"
              >
                <span className="font-mono text-[12px]">·</span>
                {f}
              </div>
            ))}
          </Section>
        );
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <h1 className="ui-title font-mono font-semibold">{t("views.settingsView.settings")}</h1>
        <p className="ui-meta mt-0.5 text-text-faint">
          {t("views.settingsView.applicationPreferencesMostItemsPrototypeExceptTheme")}</p>
      </header>

      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1 lg:flex-col lg:overflow-visible">
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
              <span className="text-[14px] font-semibold">{tab.label}</span>
              <span className="mt-0.5 hidden text-[12px] text-text-faint lg:block">
                {tab.desc}
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0">{renderActivePanel()}</div>
      </div>
    </div>
  );
}
