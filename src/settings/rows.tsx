import { useEffect, useState, type ReactNode } from "react";
import { inputClass } from "../ui/Modal";
import { cx, Segmented, Switch } from "../ui/primitives";

/** The pieces settings pages are made of. */

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-6 py-5">
      <h2 className="mb-4 text-[15px] font-semibold text-fg">{title}</h2>
      {children}
    </div>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      {title && <h3 className="mb-1 text-[12px] font-semibold text-muted">{title}</h3>}
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

export function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-6 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{title}</div>
        {description && <div className="text-[12px] text-subtle">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Toggle({ title, description, value, onChange }: { title: string; description?: ReactNode; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Row title={title} description={description}>
      <Switch label={title} checked={value} onCheckedChange={onChange} />
    </Row>
  );
}

export function Choice<T extends string>({ title, description, value, options, onChange }: { title: string; description?: ReactNode; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <Row title={title} description={description}>
      <Segmented label={title} value={value} options={options} onChange={onChange} />
    </Row>
  );
}

/** Typed, and saved on leaving it or on Enter. */
export function TextField({ title, description, value, onChange, placeholder, type = "text", width = 200 }: { title: string; description?: ReactNode; value: string; onChange: (value: string) => void; placeholder?: string; type?: "text" | "number"; width?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onChange(draft);
  return (
    <Row title={title} description={description}>
      <input
        aria-label={title}
        type={type}
        className={cx(inputClass)}
        style={{ width }}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </Row>
  );
}

export function SelectField({ title, description, value, options, onChange }: { title: string; description?: ReactNode; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <Row title={title} description={description}>
      <select aria-label={title} className={cx(inputClass, "w-[200px]")} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}
