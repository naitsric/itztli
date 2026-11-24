import DOMPurify from "dompurify";
import { Marked, type Token, type Tokens } from "marked";
import { api, errorMessage } from "../backend/api";
import { host } from "../backend/host";
import { codeBlockRenderer, drawCodeBlock } from "../editor/codeBlocks";
import { isExternal, splitTarget } from "../editor/links";
import { isImage } from "../vault/paths";

/**
 * Markdown as it shows outside the editor: previews, embeds, quick
 * documentation. What a note says is never trusted: the HTML is sanitized,
 * and the window's content policy would not run a script anyway.
 */

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The same start of a tag the editor accepts. */
const TAG = /^#((?:[\p{L}\p{N}_/-]|[\u{2190}-\u{2bff}]|[\u{1f000}-\u{1faff}]|\u200d|\ufe0f)+)/u;

const CALLOUT = /^\[!([\w-]+)\][+-]?[ \t]*([^\n]*)(?:\n|$)/;

function linkHtml(target: string, subpath: string | null, text: string, relative: boolean): string {
  const data = `data-target="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath ?? "")}" data-relative="${relative}"`;
  return `<a class="internal" href="#" ${data}>${text}</a>`;
}

function embedHtml(target: string, subpath: string | null, display: string, relative: boolean): string {
  return `<span class="embed" data-target="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath ?? "")}" data-display="${escapeHtml(display)}" data-relative="${relative}"></span>`;
}

const marked: Marked = new Marked({
  gfm: true,
  extensions: [
    {
      name: "wikiLink",
      level: "inline",
      start: (src) => src.search(/!?\[\[/),
      tokenizer(src) {
        const match = /^(!?)\[\[([^[\]\n]+)\]\]/.exec(src);
        if (!match) return undefined;
        const [raw, ...rest] = match[2]!.split("|");
        const { target, subpath } = splitTarget(raw!.replace(/\\$/, ""));
        if (!target && !subpath) return undefined;
        return { type: "wikiLink", raw: match[0], embed: match[1] === "!", target, subpath, display: rest.join("|").trim() };
      },
      renderer(token) {
        const { target, subpath, display, embed } = token as unknown as { target: string; subpath: string | null; display: string; embed: boolean };
        if (embed) return embedHtml(target, subpath, display, false);
        const shown = display || (target ? (subpath ? `${target} › ${subpath}` : target) : (subpath ?? ""));
        return linkHtml(target, subpath, escapeHtml(shown), false);
      },
    },
    {
      name: "mark",
      level: "inline",
      start: (src) => src.indexOf("=="),
      tokenizer(src) {
        const match = /^==(?=\S)([^\n]*?\S)==(?!=)/.exec(src);
        if (!match) return undefined;
        return { type: "mark", raw: match[0], tokens: this.lexer.inlineTokens(match[1]!) };
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
      },
    },
    {
      name: "comment",
      level: "inline",
      start: (src) => src.indexOf("%%"),
      tokenizer(src) {
        const match = /^%%[\s\S]*?%%/.exec(src);
        return match ? { type: "comment", raw: match[0] } : undefined;
      },
      renderer: () => "",
    },
    {
      name: "tag",
      level: "inline",
      start: (src) => /(?:^|\s)#/.exec(src)?.index,
      tokenizer(src) {
        // The space before it is part of the token, as this can't look back.
        const lead = /^\s/.exec(src)?.[0] ?? "";
        const match = TAG.exec(src.slice(lead.length));
        const name = match?.[1]?.replace(/\/+$/, "");
        if (!name || /^[\p{N}/]+$/u.test(name)) return undefined;
        return { type: "tag", raw: `${lead}#${name}`, lead, name };
      },
      renderer(token) {
        const { lead, name } = token as unknown as { lead: string; name: string };
        return `${lead}<a class="tag" href="#" data-tag="${escapeHtml(name)}">#${escapeHtml(name)}</a>`;
      },
    },
  ],
  renderer: {
    link({ href, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      if (isExternal(href)) return `<a class="external" href="#" data-url="${escapeHtml(href)}">${text}</a>`;
      const { target, subpath } = splitTarget(decode(href));
      return linkHtml(target, subpath, text, true);
    },
    image({ href, text }: Tokens.Image) {
      if (isExternal(href)) return `<span class="remote-image" data-url="${escapeHtml(href)}">${escapeHtml(text)}</span>`;
      const { target, subpath } = splitTarget(decode(href));
      return embedHtml(target, subpath, text, true);
    },
    code({ text, lang }: Tokens.Code) {
      return `<pre data-language="${escapeHtml(lang ?? "")}"><code>${escapeHtml(text)}</code></pre>`;
    },
    blockquote({ tokens, text }: Tokens.Blockquote): string {
      const callout = CALLOUT.exec(text);
      if (!callout) return `<blockquote>${this.parser.parse(tokens)}</blockquote>`;
      const kind = callout[1]!.toLowerCase();
      const title = callout[2]!.trim() || kind[0]!.toUpperCase() + kind.slice(1);
      const body = marked.parse(text.slice(callout[0].length), { async: false });
      return `<div class="callout" data-callout="${escapeHtml(kind)}"><div class="callout-title">${marked.parseInline(title, { async: false })}</div>${body}</div>`;
    },
    listitem(item: Tokens.ListItem) {
      if (!item.task) return `<li>${this.parser.parse(item.tokens, !!item.loose)}</li>`;
      return `<li class="task"><input type="checkbox" disabled ${item.checked ? "checked" : ""}>${this.parser.parse(stripCheckbox(item.tokens), !!item.loose)}</li>`;
    },
  },
});

/** Some versions of the parser put the checkbox in the item's tokens too. */
function stripCheckbox(tokens: Token[]): Token[] {
  return tokens.filter((t) => (t.type as string) !== "checkbox");
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Markdown as safe HTML, links and embeds marked but not filled in. */
export function markdownToFragment(markdown: string): DocumentFragment {
  const body = markdown.replace(/^---\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/, "").replace(/[ \t]\^[A-Za-z0-9-]+$/gm, "");
  const html = marked.parse(body, { async: false });
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "iframe", "button", "textarea", "select", "dialog", "video", "audio", "picture", "source"],
    FORBID_ATTR: ["style", "srcset", "background", "poster"],
    RETURN_DOM_FRAGMENT: true,
  });
  // HTML written in the note: its links and images get the same treatment as
  // Markdown's, so nothing navigates or loads by itself.
  for (const a of fragment.querySelectorAll<HTMLElement>("a:not(.internal, .external, .tag), area")) {
    const href = a.getAttribute("href") ?? "";
    a.removeAttribute("target");
    a.setAttribute("href", "#");
    if (!/^(https?:|mailto:)/i.test(href)) continue;
    a.classList.add("external");
    a.dataset.url = href;
  }
  for (const img of fragment.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const stand = document.createElement("span");
    if (/^data:image\//i.test(src)) continue;
    if (isExternal(src)) {
      stand.className = "remote-image";
      stand.dataset.url = src;
      stand.textContent = img.alt;
    } else {
      stand.className = "embed";
      Object.assign(stand.dataset, { target: decode(src), subpath: "", display: img.getAttribute("width") ?? img.alt, relative: "true" });
    }
    img.replaceWith(stand);
  }
  return fragment;
}

export interface RenderOptions {
  /** The note the text is from: its links are relative to it. */
  path: string;
  /** How many embeds deep this is. */
  depth?: number;
  onOpen?: (link: { target: string; subpath: string | null; relative: boolean }) => void;
  onTag?: (tag: string) => void;
}

const MAX_DEPTH = 4;

let postProcessors: ((element: HTMLElement, info: { path: string }) => void)[] = [];

export function registerPostProcessor(process: (typeof postProcessors)[number]): () => void {
  postProcessors = [...postProcessors, process];
  return () => void (postProcessors = postProcessors.filter((p) => p !== process));
}

/** Where links lead when nobody says; set by the workbench. */
let defaults: Pick<RenderOptions, "onOpen" | "onTag"> & { remoteImages: () => boolean; allowRemoteImages: () => void } = {
  remoteImages: () => false,
  allowRemoteImages: () => {},
};

export function setPreviewDefaults(next: typeof defaults) {
  defaults = next;
}

/** Draws Markdown in an element. Returns what undoes it. */
export function renderMarkdown(markdown: string, element: HTMLElement, options: RenderOptions): () => void {
  const { path, depth = 0 } = options;
  const onOpen = options.onOpen ?? defaults.onOpen;
  const onTag = options.onTag ?? defaults.onTag;
  const disposers: (() => void)[] = [];
  let disposed = false;

  element.classList.add("markdown");
  element.replaceChildren(markdownToFragment(markdown));

  const links = [...element.querySelectorAll<HTMLElement>("a.internal")];
  if (links.length > 0) {
    const wanted = links.map((a) => ({ source: path, target: a.dataset.target!, relative: a.dataset.relative === "true" }));
    void api
      .linksResolve(wanted)
      .then((found) => !disposed && links.forEach((a, i) => a.classList.toggle("missing", found[i] === null)))
      .catch(() => {});
  }

  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest<HTMLElement>("a, .remote-image");
    if (!a || !element.contains(a)) return;
    e.preventDefault();
    e.stopPropagation();
    if (a.classList.contains("remote-image")) defaults.allowRemoteImages();
    else if (a.dataset.url) void api.urlOpen(a.dataset.url);
    else if (a.dataset.tag) onTag?.(a.dataset.tag);
    else if (a.dataset.target !== undefined) {
      onOpen?.({ target: a.dataset.target, subpath: a.dataset.subpath || null, relative: a.dataset.relative === "true" });
    }
  };
  element.addEventListener("click", onClick);
  disposers.push(() => element.removeEventListener("click", onClick));

  for (const pre of element.querySelectorAll<HTMLElement>("pre[data-language]")) {
    const language = (pre.dataset.language ?? "").split(/\s/)[0]!;
    const renderer = codeBlockRenderer(language);
    if (!renderer) continue;
    const block = document.createElement("div");
    const source = pre.textContent ?? "";
    pre.replaceWith(block);
    disposers.push(drawCodeBlock(renderer, source, block, path));
  }

  for (const image of element.querySelectorAll<HTMLElement>(".remote-image")) {
    if (defaults.remoteImages()) {
      const img = document.createElement("img");
      img.src = host.remoteUrl(image.dataset.url!);
      img.alt = image.textContent ?? "";
      image.replaceWith(img);
    } else {
      image.textContent = `${image.textContent || "Image"} · from the web, not loaded. Click to change this.`;
    }
  }

  for (const embed of element.querySelectorAll<HTMLElement>(".embed")) {
    void fillEmbed(embed, path, depth).then((dispose) => (disposed ? dispose() : disposers.push(dispose)));
  }

  for (const process of postProcessors) {
    try {
      process(element, { path });
    } catch (e) {
      console.error("a preview post-processor failed", e);
    }
  }

  return () => {
    disposed = true;
    for (const dispose of disposers.splice(0)) dispose();
  };
}

async function fillEmbed(element: HTMLElement, source: string, depth: number): Promise<() => void> {
  const { target = "", subpath = "", display = "", relative } = element.dataset;
  return drawEmbed(element, { source, target, subpath: subpath || null, display, relative: relative === "true", depth });
}

export interface EmbedOptions {
  source: string;
  target: string;
  subpath: string | null;
  /** The size, for an image: `300` or `300x200`. */
  display: string;
  relative: boolean;
  depth: number;
}

/** Draws what an embed shows: an image, or (part of) a note. */
export async function drawEmbed(element: HTMLElement, options: EmbedOptions): Promise<() => void> {
  const { source, target, subpath, display, relative, depth } = options;
  const missing = (message: string) => {
    element.className = "cm-embed-missing";
    element.textContent = message;
    return () => {};
  };
  if (depth >= MAX_DEPTH) return missing(`${target}: embedded too deep`);
  const path = await api.linkResolve(source, target, relative).catch(() => null);
  if (!path) return missing(`${target} does not exist`);

  if (isImage(path)) {
    const img = document.createElement("img");
    img.className = "cm-embed-image";
    img.src = host.vaultUrl(path);
    img.alt = relative ? display : "";
    const size = /^(\d+)(?:x(\d+))?$/.exec(display);
    if (size) img.width = Number(size[1]);
    if (size?.[2]) img.height = Number(size[2]);
    element.replaceChildren(img);
    return () => {};
  }

  try {
    const excerpt = await api.excerpt(source, target, subpath, relative);
    element.className = "cm-embed-note";
    const title = document.createElement("div");
    title.className = "cm-embed-title";
    title.textContent = subpath ? `${target} › ${subpath.replace(/^\^/, "")}` : target;
    const body = document.createElement("div");
    element.replaceChildren(title, body);
    return renderMarkdown(excerpt.text, body, { path: excerpt.path, depth: depth + 1 });
  } catch (e) {
    return missing(errorMessage(e));
  }
}
