import { createContext, useContext, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { animate } from "motion";
import { useEntryMotion } from "../../motion-config.tsx";
import { MOTION_DURATION, MOTION_EASE } from "../../motion-tokens.ts";

/** 切换入场的上浮位移(px)是形状参数,不进 token;时长/错开/封顶见 MOTION_DURATION。 */
const ENTRY_DISTANCE = 7;
const PageEntryContext = createContext<string | null>(null);

/** Identity is navigation intent, never component lifetime or query readiness. */
function useEntryBoundary(identity: string, pageIdentity: string | null) {
  const element = useRef<HTMLDivElement>(null);
  const previous = useRef(identity);
  const previousPage = useRef(pageIdentity);
  const { enabled, reduced } = useEntryMotion();
  useLayoutEffect(() => {
    const switched = previous.current !== identity;
    const pageSwitched = previousPage.current !== pageIdentity;
    previous.current = identity;
    previousPage.current = pageIdentity;
    if (!switched || pageSwitched || !enabled || !element.current) return;
    const regions = [...element.current.querySelectorAll<HTMLElement>("[data-entry-region]")];
    const targets = regions.length ? regions : [element.current];
    const animations = targets.map((target, index) =>
      animate(target, reduced ? { opacity: [0, 1] } : { opacity: [0, 1], y: [ENTRY_DISTANCE, 0] }, {
        duration: reduced ? MOTION_DURATION.reducedFade : MOTION_DURATION.entryRise,
        delay: reduced ? 0 : Math.min(index * MOTION_DURATION.entryStagger, MOTION_DURATION.entryMaxDelay),
        ease: MOTION_EASE.out,
      }),
    );
    return () => {
      for (const animation of animations) animation.complete();
    };
  }, [identity, pageIdentity, enabled, reduced]);
  return element;
}

export function PageEntryBoundary({
  identity,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly identity: string; readonly children: ReactNode }) {
  const element = useEntryBoundary(identity, null);
  return (
    <PageEntryContext.Provider value={identity}>
      <div {...props} ref={element}>
        {children}
      </div>
    </PageEntryContext.Provider>
  );
}

/** Pairs with Tabs idPrefix; the panel persists across tab changes. */
export function TabPanel({
  idPrefix,
  value,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  readonly idPrefix: string;
  readonly value: string;
}) {
  const element = useEntryBoundary(value, useContext(PageEntryContext));
  return (
    <div {...props} ref={element} id={`${idPrefix}-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${value}`}>
      {children}
    </div>
  );
}
