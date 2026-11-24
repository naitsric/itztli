import { create } from "zustand";

/** Questions asked in a dialog. One at a time; see Prompts.tsx. */

export interface InputOptions {
  title: string;
  placeholder?: string;
  value?: string;
  action?: string;
  /** What is wrong with a value, or `null`. */
  validate?: (value: string) => string | null;
  /** Something to say about a valid value. */
  describe?: (value: string) => Promise<string | null>;
  /** An empty answer is an answer. */
  optional?: boolean;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  action?: string;
  danger?: boolean;
}

export interface PickItem<T> {
  title: string;
  detail?: string;
  value: T;
}

export interface PickOptions {
  title?: string;
  placeholder?: string;
  /** Offers what is typed when nothing is called that. */
  create?: (query: string) => { title: string } | null;
}

type Prompt =
  | { kind: "input"; options: InputOptions; answer: (value: string | null) => void }
  | { kind: "confirm"; options: ConfirmOptions; answer: (ok: boolean) => void }
  | {
      kind: "pick";
      items: PickItem<unknown>[];
      options: PickOptions;
      answer: (picked: { value: unknown } | { create: string } | null) => void;
    };

export const usePrompts = create<{ current: Prompt | null }>(() => ({ current: null }));

/** A new question takes the place of one nobody answered. */
function ask(make: (done: () => void) => Prompt) {
  const { current } = usePrompts.getState();
  if (current?.kind === "confirm") current.answer(false);
  else current?.answer(null);
  const prompt: Prompt = make(() => usePrompts.setState((s) => (s.current === prompt ? { current: null } : s)));
  usePrompts.setState({ current: prompt });
}

export function input(options: InputOptions): Promise<string | null> {
  return new Promise((resolve) =>
    ask((done) => ({
      kind: "input",
      options,
      answer: (value) => {
        done();
        resolve(value);
      },
    })),
  );
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) =>
    ask((done) => ({
      kind: "confirm",
      options,
      answer: (ok) => {
        done();
        resolve(ok);
      },
    })),
  );
}

function pickOrCreate<T>(items: PickItem<T>[], options: PickOptions): Promise<{ value: T } | { create: string } | null> {
  return new Promise((resolve) =>
    ask((done) => ({
      kind: "pick",
      items,
      options,
      answer: (picked) => {
        done();
        resolve(picked as { value: T } | { create: string } | null);
      },
    })),
  );
}

export async function pick<T>(items: PickItem<T>[], options: Omit<PickOptions, "create"> = {}): Promise<T | null> {
  const picked = await pickOrCreate(items, options);
  return picked && "value" in picked ? picked.value : null;
}

/** Asks for a folder, which may be a new one. */
export async function move(options: {
  title: string;
  folders: PickItem<string>[];
}): Promise<{ folder: string; create: boolean } | null> {
  const picked = await pickOrCreate(options.folders, {
    title: options.title,
    placeholder: "Folder",
    create: (query) => (/^[^/.\\:][^\\:]*[^/]$|^[^/.\\:]$/.test(query) ? { title: `New folder “${query}”` } : null),
  });
  if (!picked) return null;
  return "value" in picked ? { folder: picked.value, create: false } : { folder: picked.create, create: true };
}
