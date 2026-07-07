import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export function InteractiveEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  selected,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  return (
    <>
      <BaseEdge 
        path={edgePath} 
        markerEnd={markerEnd} 
        style={{
          ...style,
          strokeWidth: selected ? 4 : style.strokeWidth || 2,
          stroke: selected ? 'var(--color-accent)' : style.stroke,
        }} 
        className="transition-all duration-200 ease-in-out"
      />
      {/* Invisible thick path for hovering and clicking */}
      <path
        d={edgePath}
        fill="none"
        strokeOpacity={0}
        strokeWidth={20}
        className="cursor-pointer"
        onMouseEnter={(e) => {
          // Find the visible sibling path and highlight it
          const el = e.currentTarget.previousElementSibling as SVGPathElement;
          if (el && !selected) {
            el.style.stroke = 'var(--color-accent)';
            el.style.strokeWidth = '4';
            el.style.filter = 'drop-shadow(0 0 4px rgba(255, 107, 0, 0.5))';
          }
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget.previousElementSibling as SVGPathElement;
          if (el && !selected) {
            el.style.stroke = style.stroke as string || '#999';
            el.style.strokeWidth = String(style.strokeWidth || 2);
            el.style.filter = 'none';
          }
        }}
      />
    </>
  );
}
