import { useEffect, useState } from "react";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { BTN, Section, Row, SettingSelect, Toggle, type SelectorOption } from "../../components/ui/widgets";
import { useSettingsMutation, useSettingsQuery } from "../../settings-data.ts";
import { useCatalogSnapshot } from "../../catalog-data.ts";
import type { CatalogPresetRow } from "../../api-client.ts";
import {
  formatStringArrayInput,
  parseStringArrayInput,
  settingsFormRows,
  settingsPayloadFromDraft,
  type SettingsDraft,
  type SettingsFieldValue,
} from "../../settings-form.ts";

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

/** 仓库设置面板:字段面由 settings 动作契约派生,本文件只承担渲染、目录联动与提交。 */
export function RepositorySettingsPanel({
  repoId,
  onLocaleLoaded,
}: {
  readonly repoId: string | null;
  readonly onLocaleLoaded: (locale: "zh-CN" | "en-US") => void;
}) {
  const settingsQuery = useSettingsQuery(repoId);
  const settingsMutation = useSettingsMutation(repoId);
  const catalogQuery = useCatalogSnapshot(repoId);
  const [draft, setDraft] = useState<SettingsDraft>({});

  useEffect(() => {
    if (!settingsQuery.data) return;
    setDraft(settingsQuery.data.values);
    onLocaleLoaded(settingsQuery.data.settings.locale);
  }, [settingsQuery.data]);

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
