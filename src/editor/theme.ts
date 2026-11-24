import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * Editor chrome and syntax colors, all from design tokens in app.css, so
 * switching themes needs no editor reconfiguration. How Markdown looks is in
 * markdown.css.
 */
export const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--fg)", fontSize: "var(--editor-size)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--editor-font)", lineHeight: "1.65", overflowX: "hidden" },
  ".cm-content": {
    caretColor: "var(--accent)",
    padding: "28px 0 45vh",
    maxWidth: "var(--editor-width)",
    margin: "0 auto",
    minWidth: "0",
  },
  ".cm-line": { padding: "0 var(--line-inset)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--fg-subtle)", border: "none", fontFamily: "var(--font-code)", fontSize: "12px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "40px" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-muted)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--fg-subtle)", padding: "0 4px" },
  ".cm-foldPlaceholder": { background: "var(--bg-hover)", border: "none", color: "var(--fg-muted)", padding: "0 6px", borderRadius: "4px" },
  ".cm-list-lead": { display: "inline-block", textIndent: "0", whiteSpace: "pre" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--editor-bracket)", outline: "none" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "transparent" },
  ".cm-searchMatch": { backgroundColor: "var(--editor-match)", outline: "none", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--editor-flash)" },
  ".cm-selectionMatch": { backgroundColor: "var(--editor-bracket)" },
  ".cm-lintRange-warning, .cm-lintRange-info, .cm-lintRange-hint": {
    backgroundImage: "none",
    textDecoration: "underline dotted var(--link-missing)",
    textUnderlineOffset: "4px",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--danger)",
    textUnderlineOffset: "3px",
  },

  // Find and replace (⌘F, ⌘R)
  ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },

  // Tooltips: completion, problems, quick documentation
  ".cm-tooltip": {
    backgroundColor: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-popover)",
    color: "var(--fg)",
    overflow: "hidden",
    zIndex: "30",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-ui)", fontSize: "13px", maxHeight: "20em", minWidth: "260px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "4px 10px", display: "flex", gap: "12px", alignItems: "baseline", lineHeight: "1.45" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-fg)" },
  ".cm-completionDetail": { color: "var(--fg-subtle)", fontStyle: "normal", marginLeft: "auto", fontSize: "11.5px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": { color: "inherit", opacity: "0.75" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "650", color: "var(--accent)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText": { color: "inherit", textDecoration: "underline" },
  ".cm-diagnostic": { fontFamily: "var(--font-ui)", fontSize: "12px", padding: "5px 9px" },
  ".cm-diagnostic-warning, .cm-diagnostic-info, .cm-diagnostic-hint": { borderLeft: "3px solid var(--link-missing)" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
  ".cm-diagnosticAction": { background: "none", color: "var(--accent)", padding: "0", margin: "0 0 0 10px", fontWeight: "500" },
  ".cm-quick-doc": { width: "min(520px, 60vw)", maxHeight: "360px", overflow: "auto", padding: "10px 16px", fontSize: "13px", fontFamily: "var(--font-ui)" },
  ".cm-quick-doc-title": { color: "var(--fg-subtle)", fontSize: "11.5px", marginBottom: "6px" },
});

export const editorHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: "var(--syntax-keyword)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syntax-string)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
    { tag: [t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--syntax-function)" },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syntax-type)" },
    { tag: [t.attributeName, t.propertyName, t.definition(t.propertyName)], color: "var(--syntax-identifier)" },
    { tag: [t.operator, t.punctuation, t.paren, t.brace, t.squareBracket], color: "var(--syntax-operator)" },
    { tag: t.invalid, color: "var(--danger)" },
  ]),
);
