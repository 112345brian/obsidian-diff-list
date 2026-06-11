import { App, Plugin, PluginSettingTab, Setting, editorInfoField } from 'obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { EditorState, RangeSetBuilder, Transaction } from '@codemirror/state';
import type { Extension, Line, TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, PluginValue, ViewUpdate } from '@codemirror/view';

import { indexToAlpha, sliceSectionLines } from './utils.js';

// ─── Settings ─────────────────────────────────────────────────────────────────

interface DiffListSettings {
  excludedFolders: string[];
  frontmatterKey: string;
}

const DEFAULT_SETTINGS: DiffListSettings = {
  excludedFolders: [],
  frontmatterKey: 'diff-list',
};

// Returns true when the plugin should leave this note completely untouched.
function isFileExcluded(app: App, filePath: string | undefined, settings: DiffListSettings): boolean {
  if (!filePath) return false;
  if (settings.excludedFolders.some(f => f && (filePath === f || filePath.startsWith(f + '/')))) return true;
  const file = app.vault.getFileByPath(filePath);
  if (!file) return false;
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return false;
  const val = fm[settings.frontmatterKey];
  return val === false || val === 'false';
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

// Cursor character positions — a replace decoration is skipped only when a
// cursor head or anchor falls inside [from, to], preventing CM6 from snapping
// the cursor to the widget boundary.  Checking the exact range (not the whole
// line) means decorations on the rest of the line stay visible.
function cursorPositions(view: EditorView): number[] {
  const positions: number[] = [];
  for (const r of view.state.selection.ranges) {
    positions.push(r.head);
    if (!r.empty) positions.push(r.anchor);
  }
  return positions;
}

function cursorInRange(cursors: number[], from: number, to: number): boolean {
  return cursors.some(p => p >= from && p <= to);
}

// ─── Feature 1: Block Obsidian's automatic ordered-list renumbering ───────────
//
// Obsidian's list plugin rewrites "1. 1. 1." to "1. 2. 3." via a programmatic
// CM6 transaction.  We intercept every unannotated transaction and cancel it
// when (a) every change is a digit+dot → digit+dot replacement at a list-number
// position (column 0 or after pure-whitespace indent), AND (b) all the source
// numbers being replaced are identical — the signature of the "1. 1. 1." style.
// Correctly-typed lists (where source numbers differ) pass through untouched.

const NUMBER_DOT_RE = /^\d+\./;

function makePreventListRenumbering(plugin: DiffListPlugin): Extension {
  return EditorState.transactionFilter.of(
    (tr): TransactionSpec | readonly TransactionSpec[] => {
      if (!tr.docChanged) return tr;

      const filePath = tr.startState.field(editorInfoField, false)?.file?.path;
      if (isFileExcluded(plugin.app, filePath, plugin.settings)) return tr;

      // Pass through anything the user typed / deleted / moved.
      const userEvent = tr.annotation(Transaction.userEvent);
      if (
        typeof userEvent === 'string' &&
        (userEvent.startsWith('input') ||
          userEvent.startsWith('delete') ||
          userEvent.startsWith('move') ||
          userEvent === 'select' ||
          userEvent === 'undo' ||
          userEvent === 'redo')
      ) {
        return tr;
      }

      let hasChanges = false;
      let isOnlyRenumbering = true;
      // All source numbers must be the same value — the "1. 1. 1." pattern.
      // If they differ (e.g. "2. 3." in a correctly-typed list), let it through.
      const sourceNums = new Set<string>();

      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        hasChanges = true;
        if (!isOnlyRenumbering) return;

        // Allow indented list items: everything before fromA on the line must
        // be whitespace only (column 0 or pure indent).
        const line = tr.startState.doc.lineAt(fromA);
        const linePrefix = tr.startState.doc.sliceString(line.from, fromA);
        if (/\S/.test(linePrefix)) {
          isOnlyRenumbering = false;
          return;
        }

        const oldText = tr.startState.doc.sliceString(fromA, toA);
        const newText = inserted.toString();

        if (!NUMBER_DOT_RE.test(oldText) || !NUMBER_DOT_RE.test(newText)) {
          isOnlyRenumbering = false;
          return;
        }

        const numMatch = /^(\d+)\./.exec(oldText);
        if (numMatch) sourceNums.add(numMatch[1]);
      });

      // Cancel only when all replaced numbers are identical (the same "1." repeated).
      if (hasChanges && isOnlyRenumbering && sourceNums.size === 1) return [];

      return tr;
    },
  );
}

// ─── Feature 1b & 2a: ViewPlugin factory for group-numbered lists ─────────────
//
// Both the numeric ("1. 1. 1." → "1. 2. 3.") and alpha ("a. a. a." → "a. b. c.")
// features share identical group-scan logic; only the regex and label math differ.

interface ListGroupConfig {
  lineRegex: RegExp;
  getIndent(m: RegExpMatchArray): string;
  makeLabel(counter: number, groupFirstMatch: RegExpMatchArray): string;
  makeReplaceSpan(line: Line, indent: string, m: RegExpMatchArray): { from: number; to: number };
  needsDecoration(counter: number, groupFirstMatch: RegExpMatchArray, m: RegExpMatchArray): boolean;
}

class ListLabelWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = this.label;
    return span;
  }
  override eq(other: ListLabelWidget): boolean {
    return this.label === other.label;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function buildGroupDecorations(
  view: EditorView,
  config: ListGroupConfig,
  plugin: DiffListPlugin,
): DecorationSet {
  const filePath = view.state.field(editorInfoField, false)?.file?.path;
  if (isFileExcluded(plugin.app, filePath, plugin.settings)) return Decoration.none;

  const doc = view.state.doc;
  const pending: Array<{ from: number; to: number; deco: Decoration }> = [];
  const visitedGroupStarts = new Set<number>();
  const cursors = cursorPositions(view);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const m = config.lineRegex.exec(line.text);

      if (m) {
        const lineIndent = config.getIndent(m);

        // Walk back to find the true group start (must share the same indent).
        let groupStartLine = line.number;
        while (groupStartLine > 1) {
          const pm = config.lineRegex.exec(doc.line(groupStartLine - 1).text);
          if (!pm || config.getIndent(pm) !== lineIndent) break;
          groupStartLine--;
        }

        if (!visitedGroupStarts.has(groupStartLine)) {
          visitedGroupStarts.add(groupStartLine);
          const firstMatch = config.lineRegex.exec(doc.line(groupStartLine).text);
          if (!firstMatch) { pos = line.to + 1; continue; }
          const groupIndent = config.getIndent(firstMatch);

          let counter = 0;
          let lineNum = groupStartLine;
          while (lineNum <= doc.lines) {
            const gLine = doc.line(lineNum);
            const gm = config.lineRegex.exec(gLine.text);
            if (!gm || config.getIndent(gm) !== groupIndent) break;

            if (config.needsDecoration(counter, firstMatch, gm)) {
              const span = config.makeReplaceSpan(gLine, groupIndent, gm);
              if (cursorInRange(cursors, span.from, span.to)) { counter++; lineNum++; continue; }
              pending.push({
                from: span.from,
                to: span.to,
                deco: Decoration.replace({
                  widget: new ListLabelWidget(config.makeLabel(counter, firstMatch)),
                }),
              });
            }
            counter++;
            lineNum++;
          }
        }
      }

      pos = line.to + 1;
    }
  }

  pending.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, deco } of pending) builder.add(from, to, deco);
  return builder.finish();
}

function makeListViewPlugin(config: ListGroupConfig, plugin: DiffListPlugin): Extension {
  class GroupListPluginValue implements PluginValue {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildGroupDecorations(view, config, plugin);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet)
        this.decorations = buildGroupDecorations(u.view, config, plugin);
    }
  }
  return ViewPlugin.fromClass(GroupListPluginValue, { decorations: v => v.decorations });
}

// Numeric list config: displays "1. 1. 1." as "1. 2. 3." in the editor.
const numericListConfig: ListGroupConfig = {
  lineRegex: /^(\s*)(\d+)\. /,
  getIndent: m => m[1],
  makeLabel: (counter, firstMatch) => String(parseInt(firstMatch[2], 10) + counter),
  makeReplaceSpan: (line, indent, m) => ({
    from: line.from + indent.length,
    to: line.from + indent.length + m[2].length,
  }),
  needsDecoration: (counter, firstMatch, m) =>
    counter > 0 && parseInt(m[2], 10) !== parseInt(firstMatch[2], 10) + counter,
};

// Alpha list config: displays "a. a. a." as "a. b. c." in the editor.
const alphaListConfig: ListGroupConfig = {
  lineRegex: /^(\s*)a\. /,
  getIndent: m => m[1],
  makeLabel: counter => indexToAlpha(counter),
  makeReplaceSpan: (line, indent) => ({
    from: line.from + indent.length,
    to: line.from + indent.length + 1, // replace just the 'a' character
  }),
  needsDecoration: counter => counter > 0,
};

// ─── Feature 2b: MarkdownPostProcessor for reading view ───────────────────────
//
// Uses sectionInfo.lineStart/lineEnd to slice the correct lines from
// sectionInfo.text (which is the whole file, not just the section).

const ALPHA_LIST_RE = /^(\s*)a\. /;

function processAlphaLists(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
  const sectionInfo = ctx.getSectionInfo(el);
  if (!sectionInfo) return;

  const sectionLines = sliceSectionLines(sectionInfo.text, sectionInfo.lineStart, sectionInfo.lineEnd);
  if (sectionLines.length === 0) return;
  if (!sectionLines.every(line => ALPHA_LIST_RE.test(line))) return;

  const ol = document.createElement('ol');
  ol.setAttribute('type', 'a');
  for (const line of sectionLines) {
    const li = document.createElement('li');
    const m = ALPHA_LIST_RE.exec(line);
    li.textContent = m ? line.slice(m[0].length) : line;
    ol.appendChild(li);
  }
  el.replaceChildren(ol);
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class DiffListSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DiffListPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Frontmatter key')
      .setDesc(
        'Set this key to false in a note\'s front matter to disable Diff List for that note. ' +
        'Example: diff-list: false',
      )
      .addText(text =>
        text
          .setPlaceholder('diff-list')
          .setValue(this.plugin.settings.frontmatterKey)
          .onChange(async val => {
            this.plugin.settings.frontmatterKey = val.trim() || 'diff-list';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('One vault-relative folder path per line. Notes inside these folders are skipped.')
      .addTextArea(text => {
        text
          .setPlaceholder('folder/subfolder')
          .setValue(this.plugin.settings.excludedFolders.join('\n'))
          .onChange(async val => {
            this.plugin.settings.excludedFolders = val
              .split('\n')
              .map(s => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
      });
  }
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

export default class DiffListPlugin extends Plugin {
  settings: DiffListSettings = { ...DEFAULT_SETTINGS };

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new DiffListSettingTab(this.app, this));

    // Feature 1: cancel automatic renumbering of ordered lists
    this.registerEditorExtension(makePreventListRenumbering(this));

    // Feature 1b: display "1. 1. 1." as "1. 2. 3." in Live Preview editor
    this.registerEditorExtension(makeListViewPlugin(numericListConfig, this));

    // Feature 2a: decorate "a. a. a." lines in the source editor
    this.registerEditorExtension(makeListViewPlugin(alphaListConfig, this));

    // Feature 2b: replace rendered paragraphs with <ol type="a"> in reading view
    this.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      if (isFileExcluded(this.app, ctx.sourcePath, this.settings)) return;
      processAlphaLists(el, ctx);
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<DiffListSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
