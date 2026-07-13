import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  LOCALE_STORAGE_KEY,
  initialLocale,
  messageFor,
  setActiveLocale,
  type Locale,
  type MessageKey,
} from "./core.ts";

export { t, tp } from "./core.ts";
export type { Locale, MessageKey, MessageParams } from "./core.ts";

const startingLocale = initialLocale();
setActiveLocale(startingLocale);

const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
}>({
  locale: startingLocale,
  setLocale: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(startingLocale);
  const setLocale = useCallback((nextLocale: Locale) => {
    setActiveLocale(nextLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Storage can be unavailable in private or constrained browser contexts.
    }
    document.documentElement.lang = nextLocale;
    setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    setActiveLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  const localizedChildren = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "data-i18n-locale": locale,
      })
    : children;

  return (
    <LocaleContext.Provider value={value}>
      {localizedChildren}
    </LocaleContext.Provider>
  );
}

export function useI18n() {
  return useContext(LocaleContext);
}

export function Trans({
  message,
  values,
}: {
  message: MessageKey;
  values: Record<string, ReactNode>;
}) {
  return messageFor(message).split(/(\{[A-Za-z][A-Za-z0-9]*\})/g).map((part, index) => {
    const match = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(part);
    return <span key={`${part}-${index}`}>{match ? values[match[1]] ?? part : part}</span>;
  });
}
