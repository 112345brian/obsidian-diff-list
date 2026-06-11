import assert from 'node:assert/strict';

import { indexToAlpha, sliceSectionLines } from '../src/utils.ts';

// ─── indexToAlpha ─────────────────────────────────────────────────────────────

assert.strictEqual(indexToAlpha(0), 'a');
assert.strictEqual(indexToAlpha(1), 'b');
assert.strictEqual(indexToAlpha(25), 'z');
// Bijective base-26: after 'z' comes 'aa', not 'ba'
assert.strictEqual(indexToAlpha(26), 'aa');
assert.strictEqual(indexToAlpha(27), 'ab');
assert.strictEqual(indexToAlpha(51), 'az');
assert.strictEqual(indexToAlpha(52), 'ba');

// ─── sliceSectionLines ────────────────────────────────────────────────────────

const wholeFile = '---\ntitle: Test\n---\n\n# Heading\n\na. First\na. Second\n\nTrailing prose.';
// Simulate sectionInfo for the alpha list block (0-based lines 6–7)
assert.deepStrictEqual(sliceSectionLines(wholeFile, 6, 7), ['a. First', 'a. Second']);

// Single-line section
assert.deepStrictEqual(sliceSectionLines(wholeFile, 4, 4), ['# Heading']);

// Windows line endings
const crlf = 'line one\r\nline two\r\nline three';
assert.deepStrictEqual(sliceSectionLines(crlf, 1, 1), ['line two']);

// lineEnd inclusive (the section is the whole file if start=0, end=last)
const simple = 'a\nb\nc';
assert.deepStrictEqual(sliceSectionLines(simple, 0, 2), ['a', 'b', 'c']);
