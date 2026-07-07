import { useState } from "react";
import type { AdapterInfo, TaskRow } from "../model/types";
import { AdapterCard } from "../components/adapter/AdapterCard";
import { AdapterContextRail } from "../components/adapter/AdapterContextRail";

export function AdaptersView({
  adapters,
  tasks,
}: {
  adapters: AdapterInfo[];
  tasks: TaskRow[];
}) {
  const riskAdapter =
    adapters.find((a) => a.unmappedRaw.length > 0) ??
    adapters.find((a) => a.freshness !== "fresh") ??
    adapters[0];
  const [focusedEngine, setFocusedEngine] = useState(riskAdapter?.engine);
  const focusedAdapter =
    adapters.find((a) => a.engine === focusedEngine) ?? riskAdapter ?? adapters[0];

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <h1 className="ui-title font-mono font-semibold">引擎 / Adapter</h1>
        <p className="mt-0.5 text-[11px] text-text-faint">
          GUI 不直接调外部引擎 API；刷新 = 触发 check 等价调用落缓存。
        </p>
      </header>
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="flex min-w-0 flex-col gap-3">
          {adapters.map((a) => (
            <AdapterCard
              key={a.engine}
              adapter={a}
              projectedCount={tasks.filter((t) => t.engine === a.engine).length}
              focused={a.engine === focusedAdapter.engine}
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
    </div>
  );
}
