/** Aligning Markdown tables, for Reformat. */

type Align = "left" | "right" | "center" | "none";

/** How wide text is in a monospaced font: ideographs and emoji take two. */
export function textWidth(text: string): number {
  let width = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    width += /\p{Emoji_Presentation}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠]/u.test(segment) ? 2 : 1;
  }
  return width;
}

/** A row's cells. Pipes escaped or inside code don't separate. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let code = "";
  const text = line.trim().replace(/^\|/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length) {
      cell += c + text[++i];
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(text.slice(i))![0];
      if (!code && text.indexOf(run, i + run.length) >= 0) code = run;
      else if (run === code) code = "";
      cell += run;
      i += run.length - 1;
      continue;
    }
    if (c === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += c;
  }
  if (cell.trim() || !/\|\s*$/.test(text)) cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align | null {
  const match = /^(:?)-+(:?)$/.exec(cell);
  if (!match) return null;
  if (match[1] && match[2]) return "center";
  return match[2] ? "right" : match[1] ? "left" : "none";
}

/** The table with its columns aligned, or `null` if it is not a table. */
export function formatTable(text: string): string | null {
  const rows = text.split("\n").map(splitRow);
  if (rows.length < 2) return null;
  const aligns = rows[1]!.map(alignOf);
  if (aligns.length === 0 || aligns.some((a) => a === null)) return null;

  const columns = Math.max(...rows.map((r) => r.length));
  const body = rows.filter((_, i) => i !== 1);
  const widths = Array.from({ length: columns }, (_, c) => Math.max(3, ...body.map((r) => textWidth(r[c] ?? ""))));

  const pad = (cell: string, c: number) => {
    const room = widths[c]! - textWidth(cell);
    const align = aligns[c] ?? "none";
    if (align === "right") return " ".repeat(room) + cell;
    if (align === "center") return " ".repeat(Math.floor(room / 2)) + cell + " ".repeat(Math.ceil(room / 2));
    return cell + " ".repeat(room);
  };
  const ruler = widths.map((width, c) => {
    const align = aligns[c] ?? "none";
    const left = align === "left" || align === "center" ? ":" : "-";
    const right = align === "right" || align === "center" ? ":" : "-";
    return left + "-".repeat(width - 2) + right;
  });
  return rows
    .map((row, i) => (i === 1 ? ruler : widths.map((_, c) => pad(row[c] ?? "", c))))
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}
