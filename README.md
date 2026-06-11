# Diff List

An Obsidian plugin for diff-friendly ordered lists.
Keeps ordered lists written as `1. 1. 1.` in source so inserting or deleting a list item produces a one-line git diff, while rendering them as `1. 2. 3.` in the editor and reading view.
Also adds support for `a. a. a.` lettered lists.

## Philosophy

Diff List is a sibling to [Beyond SemBr](https://github.com/112345brian/obsidian-beyond-sembr): source is a storage and diff format, not the primary reading surface.
With standard ascending numbering, reordering two items in a ten-item list produces ten changed lines.
With `1. 1. 1.`, only the moved line changes.

## Features

- **Numeric lists** — write every item as `1.`; the editor and reading view display sequential numbers.
- **Alpha lists** — write every item as `a.`; the editor displays `a. b. c. …` and reading view renders an `<ol type="a">`.
- **Per-note opt-out** — set the configured frontmatter key to `false` to disable Diff List for a specific note.
- **Excluded folders** — skip entire folder subtrees.

## Syntax

### Numeric: `1. 1. 1.`

```markdown
1. First item
1. Second item
1. Third item
```

Renders and displays as:

1. First item
2. Second item
3. Third item

Insert or delete any item → only one line changes in git.

### Alpha: `a. a. a.`

```markdown
a. First item
a. Second item
a. Third item
```

Displays in the editor as `a. b. c.` and renders as an ordered list `(a) (b) (c)` in reading view.

## Per-Note Opt-Out

Add the configured key (default `diff-list`) to a note's front matter to disable the plugin for that note:

```yaml
---
diff-list: false
---
```

| Value | Effect |
| --- | --- |
| `false` | Disable Diff List for this note; Obsidian's standard list behavior applies |

## Settings

**Frontmatter key** — the front matter key used for per-note opt-out. Default: `diff-list`.

**Excluded folders** — one vault-relative path per line.
Notes inside these folders are skipped entirely.

## Vault Setup

### Obsidian Linter

Diff List works best when [Obsidian Linter](https://github.com/platers/obsidian-linter) is configured to *enforce* the `1. 1. 1.` style rather than convert it to ascending.
In Linter's settings, set **Ordered List Style → Number Style** to **Lazy** (value `lazy`).
With `lazy`, Linter will rewrite any ascending `1. 2. 3.` list to `1. 1. 1.` on save, making Linter an active enforcer of the diff-friendly format.

For individual notes where you want Linter to use ascending numbering instead, disable the rule per-note via Linter's front matter override:

```yaml
---
disabled rules:
  - ordered-list-style
---
```

### Beyond SemBr

Diff List is compatible with [Beyond SemBr](https://github.com/112345brian/obsidian-beyond-sembr) **v0.9.1 or later**.
Earlier versions do not recognise `a. a. a.` lines as non-prose and will reformat them.

## Installation

Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) with:

```
https://github.com/112345brian/obsidian-diff-list
```

Or manually: copy `main.js` and `manifest.json` into `.obsidian/plugins/diff-list/`.
