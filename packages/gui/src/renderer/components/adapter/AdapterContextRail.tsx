import { PlugsConnected } from "@phosphor-icons/react";
import type { AdapterInfo, TaskRow } from "../../model/types";
import { CHIP, SECTION_LABEL } from "./shared";
import { t } from "../../i18n/index.tsx";

export function AdapterContextRail({
  adapters,
  focusedAdapter,
  tasks,
}: {
  adapters: AdapterInfo[];
  focusedAdapter: AdapterInfo;
  tasks: TaskRow[];
}) {
  const projectedCount = tasks.filter((task) => task.engine === focusedAdapter.engine).length;
  return (
    <aside className="sticky top-4 hidden self-start rounded-lg border border-border bg-surface px-3 py-3 lg:block">
      <div className="flex items-center justify-between gap-2">
        <span className={SECTION_LABEL}>{t("components.adapterContextRail.registryContext")}</span>
        <PlugsConnected className="text-[15px] text-text-faint" />
      </div>

      <div className="mt-3 border-b border-border pb-3">
        <div className="text-[10px] text-text-faint">{t("components.adapterContextRail.currentFocus")}</div>
        <div className="mt-1 text-[13px] font-semibold text-text">{focusedAdapter.displayName}</div>
        <div className="mt-1 flex gap-1">
          <span className={CHIP}>{focusedAdapter.engine}</span>
          <span className={CHIP}>{focusedAdapter.writable ? t("components.adapterContextRail.writable") : t("components.adapterContextRail.readOnly")}</span>
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="font-mono text-[17px] font-semibold text-text">{projectedCount}</div>
        <div className="text-[10px] text-text-faint">{t("components.adapterContextRail.tasksCurrentProjection")}</div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">{t("components.adapterContextRail.capabilities")}</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {focusedAdapter.capabilities.map((capability) => (
            <span key={capability} className={CHIP}>{capability}</span>
          ))}
        </div>
      </div>

      <div className="pt-3">
        <div className="text-[10px] text-text-faint">{t("components.adapterContextRail.realRegistrationItem")}</div>
        <div className="mt-1.5 flex flex-col gap-1">
          {adapters.map((adapter) => (
            <div key={adapter.engine} className="flex items-center gap-2 text-[11px]">
              <span className="font-mono text-text-muted">{adapter.engine}</span>
              <span className="ml-auto font-mono text-text-faint">{t("components.adapterContextRail.capabilityCount", { count: adapter.capabilities.length })}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
