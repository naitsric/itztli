// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../backend/host", () => ({ host: { listen: () => () => {}, call: vi.fn(), ask: vi.fn(), vaultUrl: (p: string) => `vault:${p}`, desktop: false } }));
const { markdownToFragment } = await import("./render");

const html = (markdown: string) => {
  const element = document.createElement("div");
  element.append(markdownToFragment(markdown));
  return element;
};

describe("markdownToFragment", () => {
  it("marks links for whoever opens them", () => {
    const links = [...html("[[A]] [[B#c|d]] [e](../f%20g.md#h) [w](https://x.y)").querySelectorAll("a")];
    expect(links.map((a) => [a.className, a.dataset.target ?? a.dataset.url, a.dataset.subpath, a.textContent])).toEqual([
      ["internal", "A", "", "A"],
      ["internal", "B", "c", "d"],
      ["internal", "../f g.md", "h", "e"],
      ["external", "https://x.y", undefined, "w"],
    ]);
  });

  it("draws callouts, tasks, tags, highlights and comments", () => {
    expect(html("> [!warning] Be *careful*\n> now").querySelector(".callout")!.getAttribute("data-callout")).toBe("warning");
    expect(html("> [!warning] Be *careful*\n> now").querySelector(".callout-title")!.innerHTML).toBe("Be <em>careful</em>");
    expect(html("> [!note]\n> x").querySelector(".callout-title")!.textContent).toBe("Note");
    expect(html("> plain").querySelector("blockquote")).toBeTruthy();
    expect(html("- [x] done\n- [ ] not").querySelectorAll("li.task input").length).toBe(2);
    expect([...html("a #tag/b and c#no #2026").querySelectorAll("a.tag")].map((a) => a.textContent)).toEqual(["#tag/b"]);
    expect(html("a ==b== c").querySelector("mark")!.textContent).toBe("b");
    expect(html("a %%hidden%% c").textContent!.includes("hidden")).toBe(false);
  });

  it("leaves code as it is", () => {
    const element = html("`[[no]] #no ==no==`\n\n```js\n[[no]] #no\n```");
    expect(element.querySelectorAll("a, mark").length).toBe(0);
    expect(element.querySelector("pre")!.dataset.language).toBe("js");
  });

  it("drops frontmatter and block ids", () => {
    expect(html("---\na: 1\n---\n# T").textContent!.trim()).toBe("T");
    expect(html("---\n---\nx").textContent!.trim()).toBe("x");
    expect(html("text ^id-1").textContent!.trim()).toBe("text");
  });

  it("never lets a note run or load anything", () => {
    const evil = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      '<a href="javascript:alert(1)">x</a>',
      "[x](javascript:alert(1))",
      '<iframe src="https://x"></iframe>',
      '<form action="https://x"><button>go</button></form>',
      "<style>body{display:none}</style>",
      '<div style="position:fixed">x</div>',
      '[[a"onmouseover="alert(1)]]',
      '> [!x"onclick="alert(1)] t',
      "<svg><script>alert(1)</script></svg>",
      "![x](https://tracker.example/p.png)",
      '<img src="https://tracker.example/p.png">',
      '<a href="https://x.y" target="_blank">x</a>',
      '<video src="https://x.y/v.mp4"></video>',
    ];
    for (const markdown of evil) {
      const element = html(markdown);
      expect(element.querySelector("script, iframe, form, button, style, svg"), markdown).toBeNull();
      for (const node of element.querySelectorAll("*")) {
        for (const { name, value } of [...node.attributes]) {
          expect(name.startsWith("on") || name === "style", `${markdown}: ${name}`).toBe(false);
          if (name === "href" || name === "src") expect(value, markdown).not.toMatch(/^(javascript:|https?:)/i);
        }
      }
    }
  });
});
