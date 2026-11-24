import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/app.css";
import "./theme";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

if (!import.meta.env.DEV) {
  // A released app must not behave like a web page: no reload, no zoom and
  // no browser context menu outside text fields.
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const reload = (mod && e.key.toLowerCase() === "r") || e.key === "F5";
      const zoom = mod && ["=", "+", "-", "0"].includes(e.key);
      if (reload || zoom) e.preventDefault();
    },
    true,
  );
  window.addEventListener("contextmenu", (e) => {
    if (!(e.target as Element).closest("input, textarea, [contenteditable], .selectable, .markdown")) e.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
