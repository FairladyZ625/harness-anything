import { useState } from "react";
import type { AdapterInfo, TaskRow } from "../model/types";
import { AdapterCard } from "../components/adapter/AdapterCard";
import { AdapterContextRail } from "../components/adapter/AdapterContextRail";
import { t } from "../i18n/index.tsx";

export function AdaptersView({
  adapters,
  tasks,
  loading,
  failed,
}: {
  adapters: AdapterInfo[];
  tasks: TaskRow[];
  loading: boolean;
  failed: boolean;
}) {
  const initialAdapter = adapters[0];
  const [focusedEngine, setFocusedEngine] = useState(initialAdapter?.engine);
  const focusedAdapter =
    adapters.find((a) => a.engine === focusedEngine) ?? initialAdapter;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <h1 className="ui-title font-mono font-semibold">{t("views.adaptersView.engineAdapter")}</h1>
        <p className="mt-0.5 text-[11px] text-text-faint">
          {t("views.adaptersView.onlyProviderMetadataActuallyRegisteredCurrentCode")}</p>
      </header>
      {loading && <p className="p-4 text-sm text-text-muted">{t("views.adaptersView.readingAdapterRegistry")}</p>}
      {failed && <p className="p-4 text-sm text-danger">{t("views.adaptersView.adapterRegistryReadFailed")}</p>}
      {!loading && !failed && adapters.length === 0 && <p className="p-4 text-sm text-text-muted">{t("views.adaptersView.noAdapterRegistered")}</p>}
      {!loading && !failed && adapters.length > 0 &&
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="flex min-w-0 flex-col gap-3">
          {adapters.map((a) => (
            <AdapterCard
              key={a.engine}
              adapter={a}
              projectedCount={tasks.filter((t) => t.engine === a.engine).length}
              focused={a.engine === focusedAdapter?.engine}
              onFocus={() => setFocusedEngine(a.engine)}
            />
          ))}
        </section>

        {focusedAdapter && (
          <AdapterContextRail
            adapters={adapters}
            focusedAdapter={focusedAdapter}
            tasks={tasks}
          />
        )}
      </div>
      }
    </div>
  );
}
