// 0-based counter → lowercase letter sequence matching <ol type="a"> semantics:
// 0→'a', 25→'z', 26→'aa', 27→'ab', …
export function indexToAlpha(n: number): string {
  let result = '';
  let i = n + 1;
  while (i > 0) {
    i--;
    result = String.fromCharCode(97 + (i % 26)) + result;
    i = Math.floor(i / 26);
  }
  return result;
}

// Slice the relevant lines from sectionInfo.text using the lineStart/lineEnd indices.
// sectionInfo.text is the whole file; lineStart/lineEnd (0-based, inclusive) delimit the section.
export function sliceSectionLines(text: string, lineStart: number, lineEnd: number): string[] {
  return text.split(/\r?\n/).slice(lineStart, lineEnd + 1);
}
