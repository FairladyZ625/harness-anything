import type { ReactElement } from "react";
import { rendererNavigation } from "./app-model.ts";

export function App(): ReactElement {
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
      <section className="ha-workspace" aria-label="Task board">
        <header className="ha-header">
          <h1>Board</h1>
          <p>Local desktop controller foundation</p>
        </header>
        <div className="ha-columns">
          {["Open", "Blocked", "In Review", "Terminal", "Unknown"].map((column) => (
            <section key={column} className="ha-column">
              <h2>{column}</h2>
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
