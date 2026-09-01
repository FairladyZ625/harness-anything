export const IN_APP_BROWSER_PARTITION = "in-app-browser";

export interface BrowserShellState {
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly error: BrowserLoadError | null;
}

export interface BrowserLoadError {
  readonly code: number;
  readonly description: string;
  readonly url: string;
}

interface BrowserWebview extends HTMLElement {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
}

type BrowserEvent = Event & {
  readonly errorCode?: number;
  readonly errorDescription?: string;
  readonly validatedURL?: string;
  readonly url?: string;
};

export interface BrowserShell {
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  dispose(): void;
}

export function ensureUrlScheme(input: string): string {
  const value = input.trim();
  if (value === "") return "";
  return /^[a-z][a-z\d+.-]*:/iu.test(value) ? value : `https://${value}`;
}

export function browserLoadError(event: BrowserEvent): BrowserLoadError | null {
  if (event.errorCode === undefined || event.errorCode === -3) return null;
  return {
    code: event.errorCode,
    description: event.errorDescription ?? "Page failed to load",
    url: event.validatedURL ?? "",
  };
}

export function createBrowserShell(element: HTMLElement, onState: (state: BrowserShellState) => void): BrowserShell {
  const webview = element as BrowserWebview;
  let state: BrowserShellState = {
    url: element.getAttribute("src") ?? "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    error: null,
  };
  const emit = (patch: Partial<BrowserShellState>) => {
    state = { ...state, ...patch };
    onState(state);
  };
  const syncNavigation = (event: BrowserEvent) =>
    emit({
      url: event.url ?? webview.getURL(),
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      error: null,
    });
  const start = () => emit({ loading: true, error: null });
  const stop = () => emit({ loading: false });
  const fail = (event: BrowserEvent) => {
    const error = browserLoadError(event);
    if (error) emit({ loading: false, error });
  };
  const listeners = [
    ["did-start-loading", start],
    ["did-stop-loading", stop],
    ["did-navigate", syncNavigation],
    ["did-navigate-in-page", syncNavigation],
    ["did-fail-load", fail],
  ] as const;
  for (const [name, listener] of listeners) element.addEventListener(name, listener as EventListener);
  onState(state);
  return {
    navigate: (url) => {
      emit({ error: null });
      void webview.loadURL(url);
    },
    back: () => webview.goBack(),
    forward: () => webview.goForward(),
    reload: () => webview.reload(),
    stop: () => webview.stop(),
    dispose: () => {
      for (const [name, listener] of listeners) element.removeEventListener(name, listener as EventListener);
    },
  };
}
