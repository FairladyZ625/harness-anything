import { Handle, Position } from '@xyflow/react';

export function TaskNode({ data, selected }: any) {
  const isLoop = data.loop;
  const isDimmed = data.dimmed;
  const cycleWarning = data.cycleWarning;

  return (
    <div 
      className="w-[120px] h-[48px] rounded-md flex relative cursor-pointer box-border"
      style={{
        backgroundColor: 'var(--color-surface-raised)',
        borderColor: isLoop ? '#f97316' : selected ? 'var(--color-accent)' : 'var(--color-border-strong)',
        borderWidth: isLoop ? '2.5px' : selected ? '2px' : '1px',
        borderStyle: 'solid',
        opacity: isDimmed ? 0.18 : 1,
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
      <div 
        className="w-[3px] h-[36px] mt-1.5 ml-[3px] rounded-[1.5px]" 
        style={{ backgroundColor: data.color }} 
      />
      <div className="flex flex-col ml-2 mt-1.5">
        <span className="font-mono text-[10px] text-[var(--color-text-muted)] leading-tight">{data.taskId}</span>
        <span className="text-[10.5px] text-[var(--color-text)] truncate w-[90px] leading-snug mt-0.5">{data.title}</span>
      </div>
    </div>
  );
}
