import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
