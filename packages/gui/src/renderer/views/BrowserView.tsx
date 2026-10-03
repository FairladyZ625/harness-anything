import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createBrowserShell,
  ensureUrlScheme,
  IN_APP_BROWSER_PARTITION,
  type BrowserShell,
  type BrowserShellState,
} from "../browser/BrowserShell.ts";

const DEFAULT_URL = "https://example.com";
const initialState: BrowserShellState = {
  url: "",
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: null,
};

export function BrowserView({
  initialUrl,
  onLoadError,
}: {
  readonly initialUrl?: string | null;
  readonly onLoadError?: (description: string) => void;
}) {
  const errorHandler = useRef(onLoadError);
  errorHandler.current = onLoadError;
  const hostRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<BrowserShell | null>(null);
  const [state, setState] = useState(initialState);
  const [address, setAddress] = useState(ensureUrlScheme(initialUrl ?? DEFAULT_URL));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const webview = document.createElement("webview");
    const url = ensureUrlScheme(initialUrl ?? DEFAULT_URL);
    webview.dataset.testid = "in-app-browser-webview";
    webview.setAttribute("aria-label", "In-app browser content");
    webview.setAttribute("partition", IN_APP_BROWSER_PARTITION);
    webview.setAttribute(
      "webpreferences",
      "contextIsolation=yes,nodeIntegration=no,sandbox=yes,webSecurity=yes,plugins=no,webviewTag=no",
    );
    webview.setAttribute("src", url);
    webview.className = "in-app-browser-webview";
    host.replaceChildren(webview);
    const shell = createBrowserShell(webview, (next) => {
      setState(next);
      if (next.error) errorHandler.current?.(next.error.description);
      if (next.url) setAddress(next.url);
    });
    shellRef.current = shell;
    return () => {
      shell.dispose();
      shellRef.current = null;
      webview.remove();
    };
  }, [initialUrl]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = ensureUrlScheme(address);
    if (url) {
      setAddress(url);
      shellRef.current?.navigate(url);
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg p-2" data-testid="browser-view">
      <form
        className="glass flex shrink-0 items-center gap-1 rounded-sm border border-border px-2 py-1.5"
        onSubmit={submit}
      >
        <button type="button" aria-label="Back" disabled={!state.canGoBack} onClick={() => shellRef.current?.back()}>
          ←
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={!state.canGoForward}
          onClick={() => shellRef.current?.forward()}
        >
          →
        </button>
        <button
          type="button"
          aria-label={state.loading ? "Stop" : "Reload"}
          onClick={() => (state.loading ? shellRef.current?.stop() : shellRef.current?.reload())}
        >
          {state.loading ? "×" : "↻"}
        </button>
        <input
          aria-label="Address"
          className="control min-w-0 flex-1 font-mono"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </form>
      <div className="relative mt-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-sm border border-border bg-white">
        <div ref={hostRef} className="absolute inset-0" data-testid="in-app-browser-host" />
        {state.error && (
          <div className="glass absolute inset-x-0 top-0 flex items-center gap-3 px-3 py-2 ui-meta" role="alert">
            <strong>Page could not be loaded</strong>
            <span className="min-w-0 truncate text-text-muted">{state.error.description}</span>
            <button className="control justify-self-center" onClick={() => shellRef.current?.reload()}>
              Try again
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
