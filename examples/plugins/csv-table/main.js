// @ts-check
/// <reference path="../../../packages/plugin-api/index.d.ts" />

/** Rows of cells. Quoted cells may hold commas, quotes ("") and line breaks. */
export function parseCsv(text) {
  const rows = [[""]];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const row = rows[rows.length - 1];
    if (quoted) {
      if (c !== '"') row[row.length - 1] += c;
      else if (text[i + 1] === '"') row[row.length - 1] += text[++i];
      else quoted = false;
    } else if (c === '"' && row[row.length - 1] === "") quoted = true;
    else if (c === ",") row.push("");
    else if (c === "\n") rows.push([""]);
    else if (c !== "\r") row[row.length - 1] += c;
  }
  return rows.filter((row) => row.some((cell) => cell.trim()));
}

function draw(text, element) {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error("There is nothing in this table");
  let sorted = { column: -1, down: false };

  const render = () => {
    const rows = [...body];
    if (sorted.column >= 0) {
      const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
      rows.sort((a, b) => compare(a[sorted.column] ?? "", b[sorted.column] ?? "") * (sorted.down ? -1 : 1));
    }
    const table = document.createElement("table");
    table.className = "csv-table";
    const head = table.createTHead().insertRow();
    header.forEach((title, column) => {
      const cell = document.createElement("th");
      cell.textContent = title + (sorted.column === column ? (sorted.down ? " ↓" : " ↑") : "");
      cell.addEventListener("click", () => {
        sorted = { column, down: sorted.column === column && !sorted.down };
        render();
      });
      head.append(cell);
    });
    const tbody = table.createTBody();
    for (const row of rows) {
      const line = tbody.insertRow();
      header.forEach((_, column) => (line.insertCell().textContent = row[column] ?? ""));
    }
    element.replaceChildren(table);
  };
  render();
}

/** @type {import("@itztli/plugin-api").Plugin} */
const plugin = {
  activate(ctx) {
    ctx.markdown.registerCodeBlock("csv", draw);
    ctx.fileViewers.register({
      id: "csv",
      extensions: ["csv"],
      mount(element, file) {
        element.classList.add("csv-file");
        const load = () => file.read().then((text) => draw(text, element), (e) => (element.textContent = String(e.message)));
        load();
        return file.onChange(load);
      },
    });
  },
};

export default plugin;
