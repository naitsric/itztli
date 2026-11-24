import type { Command } from "../commands/registry";

/** Finding commands by name: words in any order, initials (`ftn` → Find This Note). */
export function matchCommand(command: Command, query: string): number {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return 1;
  const title = command.title.toLowerCase();
  if (title === wanted) return 100;
  if (title.startsWith(wanted)) return 80;
  const words = title.split(/[\s:/()-]+/).filter(Boolean);
  const parts = wanted.split(/\s+/);
  if (parts.every((p) => words.some((w) => w.startsWith(p)))) return 60 - Math.max(0, words.indexOf(words.find((w) => w.startsWith(parts[0]!))!));
  if (words.map((w) => w[0]).join("").startsWith(wanted.replace(/\s/g, ""))) return 45;
  if (title.includes(wanted)) return 40;
  const also = [...(command.keywords ?? []), command.category, command.id].join(" ").toLowerCase();
  return parts.every((p) => title.includes(p) || also.includes(p)) ? 20 : 0;
}

export function findCommands(commands: readonly Command[], query: string, limit: number): Command[] {
  return commands
    .map((command) => ({ command, score: matchCommand(command, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
    .slice(0, limit)
    .map((c) => c.command);
}
