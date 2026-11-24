/** Text with the characters a fuzzy search matched standing out. */
export function Matched({ text, positions }: { text: string; positions: readonly number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const at = new Set(positions);
  const parts: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = at.has(i);
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += text[i];
    else parts.push({ text: text[i]!, match });
  }
  return (
    <>
      {parts.map((part, i) =>
        part.match ? (
          <span key={i} className="font-semibold text-accent group-data-[selected=true]:text-inherit group-data-[selected=true]:underline">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Text with every occurrence of a query marked, ignoring case. */
export function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const wanted = query.toLowerCase();
  const parts = [];
  let from = 0;
  for (let at = lower.indexOf(wanted); at >= 0; at = lower.indexOf(wanted, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-warning/35 text-inherit">
        {text.slice(at, at + wanted.length)}
      </mark>,
    );
    from = at + wanted.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
