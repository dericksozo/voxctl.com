import React from "react";
import ReactDOM from "react-dom/client";
import { Hud } from "./Hud";
import "../styles/hud.css";

ReactDOM.createRoot(document.getElementById("hud-root") as HTMLElement).render(
  <React.StrictMode>
    <Hud />
  </React.StrictMode>,
);
