import { Handle, Position } from '@xyflow/react';

export function FactNode({ data, selected }: any) {
  const isLoop = data.loop;
  const isDimmed = data.dimmed;
  const cycleWarning = data.cycleWarning;

  return (
    <div 
      className="w-[140px] h-[40px] flex items-center relative cursor-pointer box-border rounded-full border bg-surface-raised px-3 shadow-sm transition-all duration-200 group"
      style={{ 
        opacity: isDimmed ? 0.4 : 1,
        borderColor: isLoop ? '#f97316' : selected ? 'var(--color-stale)' : 'var(--color-border-strong)',
        boxShadow: selected || isLoop ? `0 0 0 2px ${isLoop ? '#f97316' : 'var(--color-stale)'}` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
      {cycleWarning && (
        <span
          title="INV-3: relation cycle detected; traversal is truncated"
          className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-danger font-mono text-[10px] font-bold text-white"
        >
          !
        </span>
      )}
      
      <div className="w-[10px] h-[10px] rounded-full shrink-0 mr-2 bg-stale" />
      <div className="flex flex-col min-w-0 flex-1 justify-center">
        <span className="font-mono text-[9px] text-text-faint truncate leading-none mb-1">
          {data.sub}
        </span>
        <span className="text-[11px] font-medium text-text truncate leading-none">
          {data.label}
        </span>
      </div>
      
      <div className="absolute inset-0 rounded-full ring-2 ring-stale opacity-0 group-hover:opacity-50 transition-opacity" />
    </div>
  );
}
