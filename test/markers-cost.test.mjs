import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { scanText, stripMarkers } from "../lib/markers.mjs";

const COMMENT = String.raw`(?:\/\/|#|--|;|\/\*|<!--|\{\/\*)`;
const ID = String.raw`([A-Za-z0-9][\w.-]*)`;
const oldOpen = new RegExp(String.raw`^\s*${COMMENT}\s*SKEL\[${ID}\]\s*(.*?)\s*(?:\*\/\}?|-->)?\s*$`);
const oldClose = new RegExp(String.raw`^\s*${COMMENT}\s*\/SKEL\[${ID}\]\s*(?:\*\/\}?|-->)?\s*$`);

function browserGrammar() {
  const source = fs.readFileSync(new URL("../lib/strict-capture-view-dom.mjs", import.meta.url), "utf8");
  return vm.runInNewContext(source.slice(source.indexOf("const COMMENT ="), source.indexOf("const MARKER_CANDIDATE =")) + "\n({ openMarker, CLOSE_RE })");
}

test("linear marker parser preserves legacy comment, title, whitespace and terminator grammar", () => {
  const browser = browserGrammar();
  const chunks = ["", "x", " ", "\t", "\r", "\u2028", "\uFEFF", "*/", "*/}", "-->", " }", "x  x"];
  for (const comment of ["//", "#", "--", ";", "/*", "<!--", "{/*"]) {
    for (const a of chunks) for (const b of chunks) for (const c of ["", " ", "*/", "*/}", "-->"]) {
      const line = ` \t${comment} SKEL[a.1-b]${a}${b}${c}`;
      const expected = oldOpen.exec(line);
      const parsed = browser.openMarker(line);
      assert.equal(parsed?.[2], expected?.[2], JSON.stringify(line));
      const text = `${line}\nbody\n// /SKEL[a.1-b]`;
      if (expected) {
        assert.equal(scanText(text)[0].title, expected[2], JSON.stringify(line));
        assert.equal(stripMarkers(text), "body", JSON.stringify(line));
      }
      const close = ` ${comment} /SKEL[a.1-b]${a}${b}${c}`;
      assert.equal(browser.CLOSE_RE.test(close), oldClose.test(close), JSON.stringify(close));
    }
  }
});

test("long whitespace titles and rejected closing lines finish in a bounded child", () => {
  const markers = new URL("../lib/markers.mjs", import.meta.url).href;
  const browser = new URL("../lib/strict-capture-view-dom.mjs", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import vm from 'node:vm';
    import { scanText, stripMarkers } from ${JSON.stringify(markers)};
    const source = fs.readFileSync(new URL(${JSON.stringify(browser)}), 'utf8');
    const grammar = vm.runInNewContext(source.slice(source.indexOf('const COMMENT ='), source.indexOf('const MARKER_CANDIDATE =')) + '\\n({ openMarker, CLOSE_RE })');
    const spaces = ' '.repeat(800_000);
    const line = '// SKEL[1] x' + spaces + 'x';
    const text = line + '\\nbody\\n// /SKEL[1]';
    assert.equal(scanText(text)[0].title, 'x' + spaces + 'x');
    assert.equal(stripMarkers(text), 'body');
    assert.equal(grammar.openMarker(line)[2], 'x' + spaces + 'x');
    assert.equal(grammar.CLOSE_RE.test('// /SKEL[1]' + spaces + 'x'), false);
    assert.equal(scanText('// /SKEL[1]' + spaces + 'x').length, 0);
  `], { timeout: 15_000, stdio: "pipe" });
});
