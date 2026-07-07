import { Funnel, SquaresFour, Graph } from "@phosphor-icons/react";

export type EntityType = 'decision' | 'task' | 'fact';

export interface GraphFilters {
  modules: Set<string>;
  types: Set<EntityType>;
}

interface Props {
  filters: GraphFilters;
  setFilters: (f: GraphFilters | ((prev: GraphFilters) => GraphFilters)) => void;
  availableModules: string[];
}

export function GraphFilterPanel({ filters, setFilters, availableModules }: Props) {
  const toggleModule = (mod: string) => {
    setFilters(prev => {
      const next = new Set(prev.modules);
      if (next.has(mod)) {
        next.delete(mod);
      } else {
        next.add(mod);
      }
      return { ...prev, modules: next };
    });
  };

  const toggleType = (t: EntityType) => {
    setFilters(prev => {
      const next = new Set(prev.types);
      if (next.has(t)) {
        next.delete(t);
      } else {
        next.add(t);
      }
      return { ...prev, types: next };
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface shadow-sm w-[260px] pointer-events-auto">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Funnel weight="duotone" className="text-text-muted" />
        <span className="font-mono text-xs font-semibold text-text">Filters</span>
      </div>
      
      <div className="px-3 pb-3 flex flex-col gap-4">
        {/* Module Filter */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono uppercase tracking-wide">
            <SquaresFour weight="bold" />
            <span>Modules</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {availableModules.map(mod => {
              const active = filters.modules.has(mod);
              return (
                <button
                  key={mod}
                  onClick={() => toggleModule(mod)}
                  className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    active 
                      ? "bg-accent/10 text-accent border border-accent/30" 
                      : "bg-surface-raised text-text-muted border border-border hover:bg-border/50"
                  }`}
                >
                  {mod}
                </button>
              );
            })}
          </div>
        </div>

        {/* Entity Type Filter */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono uppercase tracking-wide">
            <Graph weight="bold" />
            <span>Entity Types</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(['decision', 'task', 'fact'] as const).map(t => {
              const active = filters.types.has(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    active 
                      ? "bg-stale/10 text-stale border border-stale/30" 
                      : "bg-surface-raised text-text-muted border border-border hover:bg-border/50"
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
