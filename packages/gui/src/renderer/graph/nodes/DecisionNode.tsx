import { Handle, Position } from '@xyflow/react';

export function DecisionNode({ data, selected }: any) {
  const isLoop = data.loop;
  const isDimmed = data.dimmed;
  const cycleWarning = data.cycleWarning;

  return (
    <div 
      className="w-[140px] h-[52px] flex flex-col justify-center relative cursor-pointer box-border pl-3 group transition-all duration-200"
      style={{
        backgroundColor: 'var(--color-surface)',
        opacity: isDimmed ? 0.4 : 1,
        clipPath: 'polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)',
        borderLeft: `4px solid ${isLoop ? '#f97316' : selected ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
        boxShadow: selected || isLoop ? `inset 0 0 0 1px ${isLoop ? '#f97316' : 'var(--color-accent)'}` : 'inset 0 0 0 1px var(--color-border)',
      }}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
      {cycleWarning && (
        <span
          title="INV-3: relation cycle detected; traversal is truncated"
          className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-danger font-mono text-[10px] font-bold text-white"
        >
          !
        </span>
      )}
      
      <div className="absolute inset-0 bg-accent opacity-[0.05] group-hover:opacity-10 pointer-events-none" />
      
      <span className="font-mono text-[9px] text-accent leading-tight flex items-center gap-1">
        <span className="text-[12px]">◆</span> {data.decisionId}
      </span>
      <span className="text-[11px] font-medium text-text truncate w-full leading-snug mt-0.5 pr-2">
        {data.title}
      </span>
    </div>
  );
}
