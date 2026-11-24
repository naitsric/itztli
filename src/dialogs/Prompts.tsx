import { Command as Cmdk } from "cmdk";
import { useEffect, useRef, useState } from "react";
import { useKeymapHold } from "../commands/keymapHold";
import { inputClass, Modal } from "../ui/Modal";
import { paletteContentClass, paletteInputClass, paletteItemClass, paletteListClass, paletteOverlayClass } from "../ui/palette";
import { Button } from "../ui/primitives";
import { usePrompts, type ConfirmOptions, type InputOptions, type PickItem, type PickOptions } from "./ask";

export function Prompts() {
  const prompt = usePrompts((s) => s.current);
  if (!prompt) return null;
  switch (prompt.kind) {
    case "input":
      return <InputPrompt key={prompt.options.title} options={prompt.options} answer={prompt.answer} />;
    case "confirm":
      return <ConfirmPrompt options={prompt.options} answer={prompt.answer} />;
    case "pick":
      return <PickPrompt items={prompt.items} options={prompt.options} answer={prompt.answer} />;
  }
}

function InputPrompt({ options, answer }: { options: InputOptions; answer: (value: string | null) => void }) {
  const [value, setValue] = useState(options.value ?? "");
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const problem = !value.trim() ? (options.optional ? null : "") : (options.validate?.(value) ?? null);

  useEffect(() => {
    setNote(null);
    if (!options.describe || problem !== null) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      options.describe!(value)
        .then((text) => !stale && setNote(text))
        .catch(() => {});
    }, 120);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [value, problem, options]);

  const submit = () => problem === null && answer(value);
  return (
    <Modal
      open
      onClose={() => answer(null)}
      title={options.title}
      width={440}
      contentProps={{
        onOpenAutoFocus: (e) => {
          e.preventDefault();
          field.current?.focus();
          field.current?.select();
        },
      }}
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
            {touched && problem ? <span className="text-danger">{problem}</span> : note}
          </span>
          <Button onClick={() => answer(null)}>Cancel</Button>
          <Button variant="primary" disabled={problem !== null} onClick={submit}>
            {options.action ?? "OK"}
          </Button>
        </>
      }
    >
      <input
        ref={field}
        aria-label={options.title}
        className={inputClass}
        value={value}
        placeholder={options.placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => {
          setValue(e.target.value);
          setTouched(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          submit();
        }}
      />
    </Modal>
  );
}

function ConfirmPrompt({ options, answer }: { options: ConfirmOptions; answer: (ok: boolean) => void }) {
  return (
    <Modal
      open
      onClose={() => answer(false)}
      title={options.title}
      width={420}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={() => answer(false)}>Cancel</Button>
          <Button
            variant="primary"
            className={options.danger ? "bg-danger" : undefined}
            autoFocus
            onClick={() => answer(true)}
          >
            {options.action ?? "OK"}
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-muted">{options.message ?? ""}</p>
    </Modal>
  );
}

function Hold() {
  useKeymapHold();
  return null;
}

function PickPrompt({
  items,
  options,
  answer,
}: {
  items: PickItem<unknown>[];
  options: PickOptions;
  answer: (picked: { value: unknown } | { create: string } | null) => void;
}) {
  const [query, setQuery] = useState("");
  const exact = items.some((i) => i.title.toLowerCase() === query.trim().toLowerCase());
  const create = query.trim() && !exact ? options.create?.(query.trim()) : null;
  return (
    <Cmdk.Dialog
      open
      onOpenChange={(open) => !open && answer(null)}
      label={options.title ?? "Choose"}
      loop
      overlayClassName={paletteOverlayClass}
      contentClassName={paletteContentClass}
    >
      <Hold />
      {options.title && <div className="px-3.5 pt-2.5 text-[12px] font-medium text-muted">{options.title}</div>}
      <div className="flex items-center border-b border-border px-3">
        <Cmdk.Input autoFocus value={query} onValueChange={setQuery} placeholder={options.placeholder ?? "Type to filter"} className={paletteInputClass} />
      </div>
      <Cmdk.List className={paletteListClass}>
        {!create && <Cmdk.Empty className="px-3 py-6 text-center text-muted">Nothing found</Cmdk.Empty>}
        {items.slice(0, 2000).map((item, i) => (
          <Cmdk.Item
            key={i}
            value={`${item.title} ${item.detail ?? ""} ${i}`}
            onSelect={() => answer({ value: item.value })}
            className={paletteItemClass}
          >
            <span className="truncate">{item.title}</span>
            {item.detail && <span className="muted truncate text-[12px] text-subtle">{item.detail}</span>}
          </Cmdk.Item>
        ))}
        {create && (
          <Cmdk.Item forceMount value={`create ${query}`} onSelect={() => answer({ create: query.trim() })} className={paletteItemClass}>
            {create.title}
          </Cmdk.Item>
        )}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}
