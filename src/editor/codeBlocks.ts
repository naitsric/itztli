import { create } from "zustand";

/** Draws fenced code blocks of a language. Plugins register them. */
export type CodeBlockRenderer = (source: string, element: HTMLElement, info: { path: string }) => (() => void) | void;

/** By language, in lower case. Replaced whole on change, so identity tells. */
export const useCodeBlocks = create<{ renderers: ReadonlyMap<string, CodeBlockRenderer> }>(() => ({ renderers: new Map() }));

export function registerCodeBlock(language: string, renderer: CodeBlockRenderer): () => void {
  const key = language.trim().toLowerCase();
  useCodeBlocks.setState((s) => ({ renderers: new Map(s.renderers).set(key, renderer) }));
  return () =>
    useCodeBlocks.setState((s) => {
      if (s.renderers.get(key) !== renderer) return s;
      const renderers = new Map(s.renderers);
      renderers.delete(key);
      return { renderers };
    });
}

export function codeBlockRenderer(language: string): CodeBlockRenderer | undefined {
  return useCodeBlocks.getState().renderers.get(language.trim().toLowerCase());
}

/** Draws a block, or says why it couldn't. Returns what undoes it. */
export function drawCodeBlock(renderer: CodeBlockRenderer, source: string, element: HTMLElement, path: string): () => void {
  try {
    const dispose = renderer(source, element, { path });
    return () => {
      try {
        dispose?.();
      } catch (e) {
        console.error("a code block failed to clean up", e);
      }
    };
  } catch (e) {
    element.textContent = e instanceof Error ? e.message : String(e);
    element.className = "cm-block-error";
    return () => {};
  }
}
