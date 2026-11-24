// @ts-check
/// <reference path="../../../packages/plugin-api/index.d.ts" />

/** @type {import("@itztli/plugin-api").Plugin} */
const plugin = {
  activate(ctx) {
    // Only what changes: the rest comes from the app's dark or light theme.
    ctx.themes.register({
      id: "dark",
      name: "Volcán",
      appearance: "dark",
      colors: {
        bg: "#2b2422",
        "bg-frame-glass": "rgb(43 36 34 / 0.62)",
        "bg-panel": "#1d1817",
        "bg-elevated": "#2f2725",
        "bg-inset": "#171312",
        border: "#3a302d",
        "border-strong": "#524441",
        fg: "#eadfd8",
        "fg-muted": "#b5a49b",
        "fg-subtle": "#85756d",
        heading: "#f6ebe4",
        accent: "#e8673c",
        "accent-soft": "rgb(232 103 60 / 0.2)",
        selection: "rgb(232 103 60 / 0.28)",
        link: "#f0a35e",
        tag: "#d9b44a",
        "tag-bg": "rgb(217 180 74 / 0.14)",
      },
    });
    ctx.themes.register({
      id: "paper",
      name: "Volcán Paper",
      appearance: "light",
      colors: {
        bg: "#ebe3d8",
        "bg-frame-glass": "rgb(235 227 216 / 0.6)",
        "bg-panel": "#fbf7f0",
        "bg-elevated": "#fffdf8",
        "bg-inset": "#f3ecdf",
        border: "#e3d8c8",
        "border-strong": "#cfc0aa",
        fg: "#3a2f28",
        "fg-muted": "#6f6055",
        "fg-subtle": "#a08f81",
        heading: "#2c231d",
        accent: "#c4501f",
        "accent-soft": "rgb(196 80 31 / 0.13)",
        selection: "rgb(196 80 31 / 0.18)",
        link: "#a8491f",
        tag: "#7d6314",
        "tag-bg": "rgb(125 99 20 / 0.12)",
      },
    });
  },
};

export default plugin;
