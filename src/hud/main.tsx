import React from "react";
import ReactDOM from "react-dom/client";
import { Hud } from "./Hud";
import { ErrorBoundary } from "../components/ErrorBoundary";
import "../styles/hud.css";

ReactDOM.createRoot(document.getElementById("hud-root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Hud />
    </ErrorBoundary>
  </React.StrictMode>,
);
