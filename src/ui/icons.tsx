import DOMPurify from "dompurify";
import {
  Activity, Archive, AtSign, Bell, Book, BookOpen, Bookmark, Bot, Brain, Bug, Calendar, CalendarDays, ChartBar, Check,
  CircleAlert, CircleCheck, Clock, Cloud, Code, Columns2, Database, Eye, File, FileText, Filter, Flag, Flame, Folder,
  FolderOpen, Gauge, GitBranch, Globe, Hash, Heart, House, Image, Inbox, Info, Kanban, Key, Keyboard, Languages,
  LayoutGrid, Lightbulb, Link, Link2, List, ListChecks, ListTree, Lock, Mail, Map, MessageSquare, Moon, Music, Network,
  Palette, PanelBottom, PanelLeft, PanelRight, Pen, Pin, Play, Puzzle, Quote, RefreshCw, Rss, Search, Settings, Share2,
  Sparkles, Star, Sun, Table, Tag, Terminal, Timer, TriangleAlert, Type, User, Users, Wand, Zap,
  type LucideIcon,
} from "lucide-react";
import { createElement, type SVGProps } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

/** The icons plugins can name. Listed in docs/plugins.md. */
export const ICONS: Record<string, LucideIcon> = {
  activity: Activity, archive: Archive, "at-sign": AtSign, bell: Bell, book: Book, "book-open": BookOpen,
  bookmark: Bookmark, bot: Bot, brain: Brain, bug: Bug, calendar: Calendar, "calendar-days": CalendarDays,
  chart: ChartBar, check: Check, alert: CircleAlert, "circle-check": CircleCheck, clock: Clock, cloud: Cloud,
  code: Code, columns: Columns2, database: Database, eye: Eye, file: File, "file-text": FileText, filter: Filter,
  flag: Flag, flame: Flame, folder: Folder, "folder-open": FolderOpen, gauge: Gauge, "git-branch": GitBranch,
  globe: Globe, hash: Hash, heart: Heart, home: House, image: Image, inbox: Inbox, info: Info, kanban: Kanban,
  key: Key, keyboard: Keyboard, languages: Languages, grid: LayoutGrid, lightbulb: Lightbulb, link: Link,
  backlinks: Link2, list: List, "list-checks": ListChecks, "list-tree": ListTree, lock: Lock, mail: Mail, map: Map,
  message: MessageSquare, moon: Moon, music: Music, network: Network, palette: Palette, "panel-bottom": PanelBottom,
  "panel-left": PanelLeft, "panel-right": PanelRight, pen: Pen, pin: Pin, play: Play, puzzle: Puzzle, quote: Quote,
  refresh: RefreshCw, rss: Rss, search: Search, settings: Settings, share: Share2, sparkles: Sparkles, star: Star,
  sun: Sun, table: Table, tag: Tag, terminal: Terminal, timer: Timer, warning: TriangleAlert, type: Type, user: User,
  users: Users, wand: Wand, zap: Zap,
};

/** An icon by name, or an `<svg>` a plugin brings, cleaned of anything that runs. */
export function Icon({ icon, className }: { icon: string; className?: string }) {
  if (icon.trimStart().startsWith("<svg")) {
    const svg = DOMPurify.sanitize(icon, { USE_PROFILES: { svg: true } });
    return <span className={className} style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  return createElement(ICONS[icon] ?? Puzzle, { className } as SVGProps<SVGSVGElement> & { ref?: never });
}

/** Puts an icon in an element outside React's tree. */
export function drawIcon(element: HTMLElement, icon: string, className = "size-4") {
  const root = createRoot(element);
  flushSync(() => root.render(<Icon icon={icon} className={className} />));
}
