import { createContext, useContext, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { animate } from "motion";
import { useEntryMotion } from "../../motion-config.tsx";

export const ENTRY_MOTION = {
  distance: 7,
  duration: 0.16,
  stagger: 0.025,
  maxDelay: 0.1,
  reducedDuration: 0.1,
} as const;
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
      animate(target, reduced ? { opacity: [0, 1] } : { opacity: [0, 1], y: [ENTRY_MOTION.distance, 0] }, {
        duration: reduced ? ENTRY_MOTION.reducedDuration : ENTRY_MOTION.duration,
        delay: reduced ? 0 : Math.min(index * ENTRY_MOTION.stagger, ENTRY_MOTION.maxDelay),
        ease: "easeOut",
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
