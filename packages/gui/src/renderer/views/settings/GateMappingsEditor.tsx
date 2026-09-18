import { t, type MessageKey } from "../../i18n/index.tsx";
import { SettingSelect, Toggle } from "../../components/ui/widgets";
import type { CatalogGateMappingsDescriptor } from "../../api-client-catalog.ts";
import type { GateMappingDraft, GateMappingIssue, GateMappingRowIssue } from "../../gate-mapping-form.ts";

const ISSUE_COPY: Readonly<Record<GateMappingIssue, MessageKey>> = {
  gateIdPattern: "views.settingsView.gateIssue.gateIdPattern",
  gateIdDuplicate: "views.settingsView.gateIssue.gateIdDuplicate",
  adapterUnknown: "views.settingsView.gateIssue.adapterUnknown",
  adapterFieldMissing: "views.settingsView.gateIssue.adapterFieldMissing",
  adapterFieldUnexpected: "views.settingsView.gateIssue.adapterFieldUnexpected",
  governanceNotAllowed: "views.settingsView.gateIssue.governanceNotAllowed",
  coverageInvalid: "views.settingsView.gateIssue.coverageInvalid",
  selectionInvalid: "views.settingsView.gateIssue.selectionInvalid",
  internalGateAdapter: "views.settingsView.gateIssue.internalGateAdapter",
};

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
  fieldInput = "w-full rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text",
  fieldLabel = "block ui-micro text-text-faint",
  // SettingSelect 固定 w-72:单元格内撑满列宽,标签才落在控件上方、两列等宽。
  selectCell = `${fieldLabel} [&_select]:w-full [&_select]:mt-0.5`;

/**
 * 门映射编辑面:每个声明的门一行草稿,adapter 四选一(含 none=移除声明的门),option
 * 字段集由目录快照的 gateMappings 描述面(kernel completion-contract 投影)驱动——
 * adapter 必须声明的字段才渲染,治理修饰只在可承载的 adapter 上出现且只能为 true。
 * 非法组合在判定层(gate-mapping-form)算出,这里只如实显示并由调用方挡提交。
 */
export function GateMappingsEditor({
  drafts,
  descriptor,
  issues,
  disabled,
  onChange,
}: {
  readonly drafts: readonly GateMappingDraft[];
  readonly descriptor: CatalogGateMappingsDescriptor;
  readonly issues: readonly GateMappingRowIssue[];
  readonly disabled: boolean;
  readonly onChange: (next: readonly GateMappingDraft[]) => void;
}) {
  const updateRow = (row: number, patch: Partial<GateMappingDraft>) =>
      onChange(drafts.map((draft, index) => (index === row ? { ...draft, ...patch } : draft))),
    chooseAdapter = (row: number, adapter: string) =>
      onChange(
        drafts.map((draft, index) => {
          if (index !== row) return draft;
          // 只保留新 adapter 声明面内的字段:option 集必须与 adapter 恰好一致,
          // 治理修饰在不可承载的 adapter 上直接清除——提交从不携带非法键。
          const allowed = descriptor.adapterFields[adapter] ?? [],
            governable = descriptor.governableAdapters.includes(adapter),
            next: Record<string, unknown> = { gateId: draft.gateId, adapter };
          for (const field of allowed)
            if (draft[field as keyof GateMappingDraft] !== undefined)
              next[field] = draft[field as keyof GateMappingDraft];
          if (governable) {
            if (draft.mandatorySignoff === true) next.mandatorySignoff = true;
            if (draft.allowOverride === true) next.allowOverride = true;
          }
          return next as unknown as GateMappingDraft;
        }),
      );
  return (
    <div data-testid="gate-mappings-editor" className="grid gap-2">
      {drafts.map((draft, row) => {
        const fields = descriptor.adapterFields[draft.adapter] ?? [],
          governable = descriptor.governableAdapters.includes(draft.adapter),
          rowIssues = issues.filter((issue) => issue.row === row),
          // 内建对账门由系统见证,只能映射到 none——adapter 选择器直接收窄到合法面。
          adapterOptions = (draft.gateId === descriptor.internalGateId ? ["none"] : descriptor.adapters).map(
            (value) => ({ value, label: value }),
          );
        return (
          <div
            key={row}
            data-testid={`gate-mapping-row-${row}`}
            className="rounded-md border border-border bg-surface-raised/40 p-2.5"
          >
            <div className="flex items-start gap-2">
              <div className="grid flex-1 grid-cols-2 gap-2">
                <label className={fieldLabel}>
                  {t("views.settingsView.gateIdLabel")}
                  <input
                    data-testid={`gate-mapping-${row}-gateId`}
                    className={`mt-0.5 ${fieldInput}`}
                    value={draft.gateId}
                    disabled={disabled}
                    onChange={(event) => updateRow(row, { gateId: event.currentTarget.value.trim() })}
                  />
                </label>
                <label className={selectCell}>
                  {t("views.settingsView.gateAdapterLabel")}
                  <SettingSelect
                    label={`gate-${row}-adapter`}
                    testId={`gate-mapping-${row}-adapter`}
                    value={draft.adapter}
                    options={adapterOptions}
                    disabled={disabled}
                    onChange={(value) => chooseAdapter(row, value)}
                  />
                </label>
                {fields.includes("appliesTo") && (
                  <label className={selectCell}>
                    {t("views.settingsView.gateAppliesToLabel")}
                    <SettingSelect
                      label={`gate-${row}-appliesTo`}
                      testId={`gate-mapping-${row}-appliesTo`}
                      value={draft.appliesTo ?? descriptor.appliesTo[0] ?? ""}
                      options={descriptor.appliesTo.map((value) => ({ value, label: value }))}
                      disabled={disabled}
                      onChange={(value) => updateRow(row, { appliesTo: value })}
                    />
                  </label>
                )}
                {fields.includes("branch") && (
                  <label className={fieldLabel}>
                    {t("views.settingsView.gateBranchLabel")}
                    <GateTextField
                      testId={`gate-mapping-${row}-branch`}
                      value={draft.branch ?? ""}
                      disabled={disabled}
                      onChange={(value) => updateRow(row, { branch: value })}
                    />
                  </label>
                )}
                {fields.includes("event") && (
                  <label className={fieldLabel}>
                    {t("views.settingsView.gateEventLabel")}
                    <GateTextField
                      testId={`gate-mapping-${row}-event`}
                      value={draft.event ?? ""}
                      disabled={disabled}
                      onChange={(value) => updateRow(row, { event: value })}
                    />
                  </label>
                )}
                {fields.includes("command") && (
                  <label className={`col-span-2 ${fieldLabel}`}>
                    {t("views.settingsView.gateCommandLabel")}
                    <GateTextField
                      testId={`gate-mapping-${row}-command`}
                      value={draft.command ?? ""}
                      disabled={disabled}
                      onChange={(value) => updateRow(row, { command: value })}
                    />
                  </label>
                )}
                {fields.includes("coverage") && (
                  <label className={selectCell}>
                    {t("views.settingsView.gateCoverageLabel")}
                    <SettingSelect
                      label={`gate-${row}-coverage`}
                      testId={`gate-mapping-${row}-coverage`}
                      value={draft.coverage ?? "descendant"}
                      options={[
                        { value: "exact", label: "exact" },
                        { value: "descendant", label: "descendant" },
                      ]}
                      disabled={disabled}
                      onChange={(value) => updateRow(row, { coverage: value })}
                    />
                  </label>
                )}
                {fields.includes("selection") && (
                  <label className={selectCell}>
                    {t("views.settingsView.gateSelectionLabel")}
                    <SettingSelect
                      label={`gate-${row}-selection`}
                      testId={`gate-mapping-${row}-selection`}
                      value="newest"
                      options={[{ value: "newest", label: "newest" }]}
                      disabled
                      onChange={() => undefined}
                    />
                  </label>
                )}
                {governable && (
                  <>
                    <label
                      data-testid={`gate-mapping-${row}-mandatorySignoff`}
                      className="inline-flex items-start gap-1.5 ui-micro text-text-muted"
                    >
                      <Toggle
                        checked={draft.mandatorySignoff === true}
                        disabled={disabled}
                        onChange={(enabled) =>
                          updateRow(row, enabled ? { mandatorySignoff: true } : { mandatorySignoff: undefined })
                        }
                      />
                      {t("views.settingsView.gateMandatorySignoffLabel")}
                    </label>
                    <label
                      data-testid={`gate-mapping-${row}-allowOverride`}
                      className="inline-flex items-start gap-1.5 ui-micro text-text-muted"
                    >
                      <Toggle
                        checked={draft.allowOverride === true}
                        disabled={disabled}
                        onChange={(enabled) =>
                          updateRow(row, enabled ? { allowOverride: true } : { allowOverride: undefined })
                        }
                      />
                      {t("views.settingsView.gateAllowOverrideLabel")}
                    </label>
                  </>
                )}
              </div>
              <button
                type="button"
                data-testid={`gate-mapping-${row}-remove`}
                disabled={disabled}
                onClick={() => onChange(drafts.filter((_draft, index) => index !== row))}
                className={`rounded px-2 py-1 ui-micro text-text-faint transition-colors duration-100 hover:bg-surface-raised hover:text-danger disabled:opacity-40 ${focusRing}`}
              >
                {t("views.settingsView.gateRemoveLabel")}
              </button>
            </div>
            {rowIssues.length > 0 && (
              <ul data-testid={`gate-mapping-${row}-issues`} className="mt-1.5 ui-micro text-danger">
                {rowIssues.map((issue, index) => (
                  <li key={index}>{t(ISSUE_COPY[issue.issue], { field: issue.field ?? "" })}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div>
        <button
          type="button"
          data-testid="gate-mapping-add"
          disabled={disabled}
          onClick={() => {
            // 新行先给出合法骨架:adapter 必填字段占位,编辑时逐字段收敛。
            const adapter = descriptor.adapters.find((candidate) => candidate !== "none") ?? "none";
            onChange([
              ...drafts,
              {
                gateId: "",
                adapter,
                ...Object.fromEntries(
                  (descriptor.adapterFields[adapter] ?? []).map((field) => [
                    field,
                    field === "selection" ? "newest" : "",
                  ]),
                ),
              },
            ]);
          }}
          className={`rounded-md border border-border px-2.5 py-1 ui-micro text-text-muted transition-colors duration-100 hover:bg-surface-raised hover:text-text disabled:opacity-40 ${focusRing}`}
        >
          {t("views.settingsView.gateAddLabel")}
        </button>
      </div>
    </div>
  );
}

function GateTextField({
  testId,
  value,
  disabled,
  onChange,
}: {
  readonly testId: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <input
      data-testid={testId}
      className={`mt-0.5 ${fieldInput}`}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}
