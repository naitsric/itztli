---
tags: [guide, guide/links]
---
# Linking

Type `[[` and start writing a name. A link can point at a heading, like
[[Keyboard#Moving around]], or show other words, like [[Welcome|the start]].

## What links buy you

- **Go to declaration**: ⌘B, or ⌘-click, follows the link under the caret.
- **Find usages**: ⌥F7 lists every place that links to a note. The Backlinks
  window (⌘4) keeps them in view.
- **Rename**: ⇧F6 renames a note and rewrites every link to it, in wiki links,
  Markdown links, embeds and properties. Moving a folder does the same for all
  it holds.
- **Quick documentation**: rest the pointer on a link, or press F1, to read the
  note without leaving.

## Properties

In a note's properties, its frontmatter, a link says how two notes relate, and
`type` says what the note is:

```yaml
type: meeting
author: "[[Ana]]"
attendees: ["[[Ana]]", "[[Luis]]"]
```

Ana's Backlinks then list this note under **author** and **attendees**. The
**Graph** (⌘8) draws each link as an arrow, highlights one relation at a time,
and colors notes by their type.

## Embeds

An exclamation mark shows the note in place:

![[Keyboard#Moving around]]

## Tags

A #guide/links tag groups notes without linking them. Tags nest with `/`, and
the **Tags** window (⌘5) shows them as a tree.

Back to [[Welcome]].
