import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { type EditorView, type Panel, runScopeHandlers, type ViewUpdate } from "@codemirror/view";
import { drawIcon } from "../ui/icons";

/** Find and Replace in the note (⌘F, ⌘R), laid out as in IntelliJ. */

/** Whether the next panel opens with its replace row. Set by the commands. */
let wantReplace = false;

export function openWithReplace(replace: boolean) {
  wantReplace = replace;
  for (const panel of open) panel.showReplace(replace);
}

const open = new Set<FindPanel>();
/** Counting stops here: what matters is whether there are many. */
const MAX_COUNT = 1000;

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly field: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly count: HTMLElement;
  private readonly toggles: Record<"caseSensitive" | "wholeWord" | "regexp", HTMLButtonElement>;
  private query: SearchQuery;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.field = input("Find in note", this.query.search);
    this.field.setAttribute("main-field", "true");
    this.replaceField = input("Replace with", this.query.replace);
    this.count = document.createElement("span");
    this.count.className = "min-w-[72px] px-1 text-[11.5px] text-subtle tabular-nums";
    this.toggles = {
      caseSensitive: toggle("Cc", "Match case"),
      wholeWord: toggle("W", "Words"),
      regexp: toggle(".*", "Regular expression"),
    };

    const row = div("flex items-center gap-1 px-2 py-1");
    row.append(
      this.field,
      ...Object.values(this.toggles),
      this.count,
      button("chevron-up", "Previous occurrence", () => findPrevious(view)),
      button("chevron-down", "Next occurrence", () => findNext(view)),
      spacer(),
      button("x", "Close", () => this.close()),
    );
    this.replaceRow = div("flex items-center gap-1 px-2 pb-1");
    this.replaceRow.append(
      this.replaceField,
      textButton("Replace", () => replaceNext(view)),
      textButton("Replace All", () => replaceAll(view)),
    );
    this.dom = div("cm-find-panel");
    this.dom.append(row, this.replaceRow);
    this.showReplace(wantReplace);

    this.dom.addEventListener("keydown", (e) => this.onKeyDown(e));
    for (const field of [this.field, this.replaceField]) field.addEventListener("input", () => this.commit());
    for (const [name, element] of Object.entries(this.toggles)) {
      element.addEventListener("click", () => {
        element.setAttribute("aria-pressed", String(element.getAttribute("aria-pressed") !== "true"));
        this.commit();
        if (name) this.field.focus();
      });
    }
    this.read(this.query);
    open.add(this);
  }

  showReplace(show: boolean) {
    this.replaceRow.style.display = show && !this.view.state.readOnly ? "" : "none";
    this.field.focus();
    this.field.select();
  }

  private close() {
    closeSearchPanel(this.view);
    this.view.focus();
  }

  private read(query: SearchQuery) {
    this.query = query;
    if (this.field.value !== query.search) this.field.value = query.search;
    if (this.replaceField.value !== query.replace) this.replaceField.value = query.replace;
    for (const name of ["caseSensitive", "wholeWord", "regexp"] as const) {
      this.toggles[name].setAttribute("aria-pressed", String(query[name]));
    }
    this.recount();
  }

  private commit() {
    const on = (name: keyof FindPanel["toggles"]) => this.toggles[name].getAttribute("aria-pressed") === "true";
    const query = new SearchQuery({
      search: this.field.value,
      replace: this.replaceField.value,
      caseSensitive: on("caseSensitive"),
      wholeWord: on("wholeWord"),
      regexp: on("regexp"),
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.recount();
  }

  private recount() {
    const { query, view } = this;
    this.field.classList.toggle("!border-danger", !!query.search && !query.valid);
    if (!query.search) return void (this.count.textContent = "");
    if (!query.valid) return void (this.count.textContent = "Bad pattern");
    let total = 0;
    let current = 0;
    const { from, to } = view.state.selection.main;
    const cursor = query.getCursor(view.state);
    for (let next = cursor.next(); !next.done && total < MAX_COUNT; next = cursor.next()) {
      total++;
      if (next.value.from === from && next.value.to === to) current = total;
    }
    const shown = total >= MAX_COUNT ? `${MAX_COUNT}+` : String(total);
    this.count.textContent = total === 0 ? "0 results" : current ? `${current}/${shown}` : `${shown} results`;
  }

  private onKeyDown(e: KeyboardEvent) {
    if (runScopeHandlers(this.view, e, "search-panel")) return e.preventDefault();
    if (e.key === "Enter" && e.target === this.field) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  mount() {
    this.field.select();
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.read(effect.value);
      }
    }
    if (update.docChanged || update.selectionSet) this.recount();
  }

  destroy() {
    open.delete(this);
  }
}

function div(className: string) {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function spacer() {
  return div("flex-1");
}

function input(label: string, value: string) {
  const element = document.createElement("input");
  element.className =
    "h-7 w-[min(320px,40%)] rounded-md border border-border bg-inset px-2 text-[12.5px] text-fg outline-none placeholder:text-subtle focus:border-accent";
  element.placeholder = label;
  element.setAttribute("aria-label", label);
  element.value = value;
  element.spellcheck = false;
  return element;
}

function toggle(text: string, label: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = label;
  element.setAttribute("aria-label", label);
  element.className =
    "h-6 min-w-6 rounded px-1 font-mono text-[11.5px] text-muted hover:bg-hover aria-pressed:bg-accent-soft aria-pressed:text-accent";
  return element;
}

const ARROWS: Record<string, string> = {
  "chevron-up": '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>',
  "chevron-down": '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function button(icon: string, label: string, run: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.title = label;
  element.setAttribute("aria-label", label);
  element.className = "inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg";
  drawIcon(element, ARROWS[icon]!);
  element.addEventListener("click", run);
  return element;
}

function textButton(text: string, run: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.className = "h-6 rounded-md border border-border-strong bg-elevated px-2 text-[12px] font-medium text-fg hover:bg-hover";
  element.addEventListener("click", run);
  return element;
}

export function findPanel(): Extension {
  return search({ top: true, createPanel: (view) => new FindPanel(view) });
}
