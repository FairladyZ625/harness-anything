import type { ReactElement } from "react";
import { rendererNavigation } from "./app-model.ts";
import { createDefaultWorkspaceLayout, resetWorkspaceLayout, routeOpenIntent } from "./workspace-shell.ts";

export function App(): ReactElement {
  const layout = createDefaultWorkspaceLayout("operate");
  const restored = resetWorkspaceLayout("operate");
  const taskShortcut = routeOpenIntent({ source: "palette", target: { kind: "task", taskId: "TASK-001" }, disposition: "tab" });
  const centralPanes = layout.panes.filter((pane) => pane.placement === "tab" || pane.placement === "split");
  const dockPanes = layout.panes.filter((pane) => pane.placement === "dock");

  return (
    <main className="ha-shell">
      <aside className="ha-sidebar" aria-label="Harness views">
        <div className="ha-brand">Harness Anything</div>
        <nav>
          {rendererNavigation.map((item) => (
            <button key={item.id} type="button" className="ha-nav-item">
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="ha-workspace" aria-label="Workspace shell">
        <header className="ha-header">
          <div>
            <h1>Workspace</h1>
            <p>
              Operate perspective · {layout.panes.length} panes · restore target {restored.activePaneId}
            </p>
          </div>
          <div className="ha-header-actions" aria-label="Workspace actions">
            <button type="button">Restore Default</button>
            <button type="button">Open {taskShortcut.title}</button>
          </div>
        </header>

        <div className="ha-workspace-grid">
          <section className="ha-pane-zone ha-pane-zone-primary" aria-label="Tabbed and split panes">
            <div className="ha-zone-title">Tabs / Split</div>
            <div className="ha-pane-row">
              {centralPanes.map((pane) => (
                <article key={pane.id} className={`ha-pane ha-pane-${pane.kind}`}>
                  <header>
                    <span>{pane.kind}</span>
                    <strong>{pane.title}</strong>
                  </header>
                  <p>
                    {pane.placement} · {pane.viewState}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section className="ha-pane-zone ha-pane-zone-dock" aria-label="Docked operation panes">
            <div className="ha-zone-title">Dock</div>
            {dockPanes.map((pane) => (
              <article key={pane.id} className={`ha-pane ha-pane-${pane.kind}`}>
                <header>
                  <span>{pane.kind}</span>
                  <strong>{pane.title}</strong>
                </header>
                <p>
                  {pane.kind === "terminal"
                    ? "View attach only · session lifecycle stays daemon-owned"
                    : `${pane.placement} · ${pane.viewState}`}
                </p>
              </article>
            ))}
          </section>
        </div>

        <section className="ha-session-strip" aria-label="Session and layout metadata">
          {layout.panes.map((pane) => (
            <section key={`${pane.id}-meta`} className="ha-session-item">
              <h2>{pane.title}</h2>
              <p>{pane.id}</p>
            </section>
          ))}
        </section>
      </section>
    </main>
  );
}
