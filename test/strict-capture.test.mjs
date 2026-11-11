import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { StrictCaptureError, captureStrictManifest } from "../lib/strict-capture.mjs";

const linuxTest = (name, fn) => test(name, { skip: process.platform !== "linux" }, fn);
const entry = (name, mode = "whole") => ({ path: name, mode });
const fenced = body => `export function value() {\n// SKEL[1] value\n${body}\n// /SKEL[1]\n}\n`;
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skel-strict-capture-"));
  const root = path.join(base, "root"); fs.mkdirSync(root);
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  t.after(() => { fs.closeSync(fd); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });
  const write = (rel, value) => { const target = path.join(root, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return target; };
  return { base, root, fd, write, capture: (manifest, options) => captureStrictManifest(fd, manifest, options) };
}

linuxTest("canonical order, full hashes and immutable exact rendered captures", t => {
  const { write, capture } = fixture(t);
  const text = "hello\r\nworld\r\n";
  write("b.txt", text); write("a.js", fenced("throw Error('SKEL_TODO');"));
  const first = capture([entry("b.txt"), entry("a.js", "fenced")]);
  const second = capture([entry("a.js", "fenced"), entry("b.txt")]);
  assert.deepEqual(first, second); assert.deepEqual(first.files.map(f => f.path), ["a.js", "b.txt"]);
  for (const version of [first.shapeVersion, first.captureVersion, ...first.files.map(f => f.rawSha256)]) assert.match(version, /^[a-f0-9]{64}$/);
  const captured = first.files[1]; assert.equal(captured.text, text);
  assert.equal(captured.rawSha256, createHash("sha256").update(Buffer.from(text)).digest("hex"));
  assert.equal(captured.byteLength, Buffer.byteLength(text));
  for (const value of [first, first.files, first.files[0], first.files[0].exterior, first.files[0].fences, first.files[0].fences[0]]) assert.ok(Object.isFrozen(value));
  write("b.txt", "later"); assert.equal(captured.text, text);
});

linuxTest("filled body and CRLF changes preserve shape while exact byte capture changes", t => {
  const { write, capture } = fixture(t);
  write("code.js", fenced("throw Error('SKEL_TODO');"));
  const before = capture([entry("code.js", "fenced")]);
  write("code.js", fenced("return 1;\n// additional filled body line"));
  const filled = capture([entry("code.js", "fenced")]);
  assert.equal(before.shapeVersion, filled.shapeVersion); assert.notEqual(before.captureVersion, filled.captureVersion);
  assert.notEqual(before.files[0].rawSha256, filled.files[0].rawSha256);
  assert.deepEqual(before.files[0].fences, [{ id: "1", title: "value", openLine: 2, closeLine: 4 }]);
  assert.deepEqual(before.files[0].exterior, ["export function value() {\n", "// SKEL[1] value\n", "// /SKEL[1]\n", "}\n", ""]);
  write("code.js", fenced("return 1;\n// additional filled body line").replace(/\n/g, "\r\n"));
  const crlf = capture([entry("code.js", "fenced")]);
  assert.notEqual(crlf.shapeVersion, filled.shapeVersion); assert.notEqual(crlf.captureVersion, filled.captureVersion);
  const whole = capture([entry("code.js", "whole")]);
  write("code.js", fenced("return 2;"));
  assert.notEqual(whole.shapeVersion, capture([entry("code.js", "whole")]).shapeVersion);
  assert.notEqual(whole.shapeVersion, crlf.shapeVersion);
});

linuxTest("manifest mode, paths and permission mode bind identity without concatenation ambiguity", t => {
  const { write, capture } = fixture(t);
  write("a", "bc"); write("ab", "c");
  const a = capture([entry("a")]), ab = capture([entry("ab")]);
  assert.notEqual(a.shapeVersion, ab.shapeVersion); assert.notEqual(a.captureVersion, ab.captureVersion);
  fs.chmodSync(write("mode", "content"), 0o600);
  const before = capture([entry("mode")]); fs.chmodSync(write("mode", "content"), 0o700);
  assert.notEqual(before.shapeVersion, capture([entry("mode")]).shapeVersion);
});

linuxTest("explicit manifests parse fenced members strictly and preserve whole-file context without editable fences", t => {
  const { write, capture } = fixture(t);
  write(".claude/code.js", fenced("return 1;"));
  const captured = capture([entry(".claude/code.js", "fenced")]); assert.equal(captured.files[0].fences.length, 1);
  for (const text of ["// SKEL[1] open\nbody", "// /SKEL[1]\n", "// SKEL[1] a\n// SKEL[2] b\n// /SKEL[2]\n// /SKEL[1]\n",
    "// SKEL[1] a\n// /SKEL[2]\n", "// SKEL[?] broken\n", "// SKEL[1] a\n// /SKEL[1] extra\n"]) {
    write("bad", text);
    assert.throws(() => capture([entry("bad", "fenced")]));
    const whole = capture([entry("bad", "whole")]).files[0];
    assert.equal(whole.text, text); assert.deepEqual(whole.fences, []);
    assert.deepEqual(whole.exterior, [text]);
  }
  write("plain", "no fences"); assert.throws(() => capture([entry("plain", "fenced")]), /no fences/);
});

linuxTest("path escape, control, ill-formed Unicode, duplicate and malformed manifests refuse", t => {
  const { write, capture } = fixture(t); write("valid", "valid");
  for (const name of ["", "/etc/passwd", "../escape", "a/../valid", "./valid", "a/./b", "a//b", "a/", "a\\b", "C:/x", "x\0y", "x\ny", "x\u0085y", "x\uD800y", "x".repeat(4097)])
    assert.throws(() => capture([entry(name)]), /path/);
  assert.throws(() => capture([entry("valid"), entry("valid")] ), /duplicate/);
  assert.throws(() => capture([entry("valid", "auto")]), /mode/);
  assert.throws(() => capture([{ ...entry("valid"), ignoreErrors: true }]));
  assert.throws(() => capture([])); assert.throws(() => capture(new Array(1)));
  let invoked = false;
  assert.throws(() => capture([{ get path() { invoked = true; return "valid"; }, mode: "whole" }]));
  assert.equal(invoked, false);
});

linuxTest("per-file, total and count limits never silently truncate or drop files", t => {
  const { write, capture } = fixture(t); write("a", "1234"); write("b", "5678"); write("empty", "");
  assert.equal(capture([entry("a")], { maxFileBytes: 4 }).totalBytes, 4);
  assert.throws(() => capture([entry("a")], { maxFileBytes: 3 }), /limit/);
  assert.throws(() => capture([entry("a"), entry("b")], { maxTotalBytes: 7 }), /limit/);
  assert.equal(capture([entry("a"), entry("empty")], { maxTotalBytes: 4 }).totalBytes, 4);
  assert.throws(() => capture([entry("a"), entry("b")], { maxFiles: 1 }), /count/);
  for (const options of [{ maxFiles: Infinity }, { maxFiles: 0 }, { maxFiles: 257 }, { maxFileBytes: -1 }, { unknown: 1 }]) assert.throws(() => capture([entry("a")], options));
});

linuxTest("strict UTF8 and NUL rejection preserve byte/text identity", t => {
  const { write, capture } = fixture(t);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0x80]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82]), Buffer.from("a\0b")]) {
    write("bad", bytes); assert.throws(() => capture([entry("bad")]));
  }
  write("unicode-😀", "valid 😀"); assert.equal(capture([entry("unicode-😀")]).files[0].text, "valid 😀");
});

linuxTest("symlink components, hardlinks, FIFO, directory and missing files refuse", t => {
  const { root, base, write, capture } = fixture(t);
  const outside = path.join(base, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret"), "secret");
  fs.symlinkSync(outside, path.join(root, "linkdir"), "dir");
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "linkfile"));
  for (const name of ["linkdir/secret", "linkfile", "missing"]) assert.throws(() => capture([entry(name)]));
  fs.mkdirSync(path.join(root, "directory")); assert.throws(() => capture([entry("directory")]), /regular/);
  fs.linkSync(write("original", "text"), path.join(root, "alias"));
  assert.throws(() => capture([entry("original")]), /hardlinked/); assert.throws(() => capture([entry("alias")]), /hardlinked/);
  // Test setup only: the capture implementation itself never spawns a process.
  execFileSync("mkfifo", [path.join(root, "fifo")]);
  assert.throws(() => capture([entry("fifo")]), /regular/);
  const unreadable = write("unreadable", "private"); fs.chmodSync(unreadable, 0);
  if (process.getuid() !== 0) assert.throws(() => capture([entry("unreadable")]), /EACCES/);
});

linuxTest("root descriptor stays anchored when the original pathname is replaced", t => {
  const { root, base, write, capture } = fixture(t); write("file", "pinned");
  fs.renameSync(root, path.join(base, "pinned-root")); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "file"), "replacement");
  assert.equal(capture([entry("file")]).files[0].text, "pinned");
});

linuxTest("opened intermediate directory stays anchored across a symlink swap", t => {
  const { root, base, write, capture } = fixture(t); write("inner/file", "pinned child");
  const outside = path.join(base, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "file"), "outside child");
  const originalOpen = fs.openSync; let swapped = false;
  fs.openSync = function (name, ...args) {
    const fd = originalOpen(name, ...args);
    if (!swapped && typeof name === "string" && /^\/proc\/self\/fd\/\d+\/inner$/.test(name)) {
      swapped = true;
      fs.renameSync(path.join(root, "inner"), path.join(base, "held-inner"));
      fs.symlinkSync(outside, path.join(root, "inner"), "dir");
    }
    return fd;
  };
  try { assert.equal(capture([entry("inner/file")]).files[0].text, "pinned child"); }
  finally { fs.openSync = originalOpen; }
  assert.equal(swapped, true);
});

linuxTest("observable size and metadata mutation during read refuses", t => {
  const { write, capture } = fixture(t); const file = write("file", "before");
  const originalRead = fs.readSync; let changed = false;
  fs.readSync = function (...args) {
    const count = originalRead(...args);
    if (!changed && count > 0) { changed = true; fs.appendFileSync(file, "after"); }
    return count;
  };
  try { assert.throws(() => capture([entry("file")]), /changed during capture/); }
  finally { fs.readSync = originalRead; }
  assert.equal(changed, true);
});

linuxTest("directory root descriptor must explicitly carry O_DIRECTORY", t => {
  const { root, fd } = fixture(t); const plain = fs.openSync(root, fs.constants.O_RDONLY);
  try { assert.throws(() => captureStrictManifest(plain, [entry("anything")]), /O_DIRECTORY/); }
  finally { fs.closeSync(plain); }
  assert.throws(() => captureStrictManifest(-1, [entry("anything")]));
  assert.ok(fs.fstatSync(fd).isDirectory());
});

test("non-Linux capture refuses before inspecting descriptors or manifests", { skip: process.platform === "linux" }, () => {
  let touched = false; const hostile = new Proxy({}, { get() { touched = true; throw Error(); } });
  assert.throws(() => captureStrictManifest(hostile, hostile, hostile), /requires Linux/); assert.equal(touched, false);
});

linuxTest("ambiguous separators and BOM refuse; raw whole and exterior endings bind", t => {
 const {write,capture}=fixture(t);
 for(const sep of ['\r','\v','\f','\u0085','\u2028','\u2029']) {
  for(const text of [fenced('body'+sep+'// /SKEL[1]'), 'outside'+sep+'// SKEL[2] fake\n'+fenced('body')]) {
   write('file',text); assert.throws(()=>capture([entry('file','fenced')]),/separator/);
   assert.equal(capture([entry('file')]).files[0].text,text);
  }
 }
 for(const mode of ['whole','fenced']) {write('file','\uFEFF'+fenced('body'));assert.throws(()=>capture([entry('file',mode)]),/BOM/);}
 write('file','template\r\n');const a=capture([entry('file')]);write('file','template\n');assert.notEqual(a.shapeVersion,capture([entry('file')]).shapeVersion);
 write('file',fenced('body'));const file=capture([entry('file','fenced')]).files[0];assert.equal(file.display.map(l=>l.text+l.ending).join(''),file.text);assert.equal(file.display[2].kind,'body');assert.equal(file.fences[0].openLine,2);
});

linuxTest('structured errors redact host paths and expose stable safe context', t => {
 const {root,write,capture}=fixture(t);fs.symlinkSync('/missing-host-secret',path.join(root,'link'));
 for(const [name,mode,text,code] of [['missing','whole',null,'CAPTURE_MISSING'],['link','whole',null,'CAPTURE_LINK'],['bom','whole','\uFEFFtext','CAPTURE_BOM'],['separator','fenced',fenced('x\vy'),'CAPTURE_SEPARATOR'],['bad','fenced','// SKEL[1] unclosed','CAPTURE_MARKERS']]) {
  if(text!==null)write(name,text);
  assert.throws(()=>capture([entry(name,mode)]),err=>{assert.ok(err instanceof StrictCaptureError);assert.equal(err.code,code);assert.equal(err.path,name);assert.ok(!err.message.includes(root));assert.ok(!err.message.includes('/proc/'));return true;});
 }
 write('part:123:name', '// /SKEL[1]\n');
 assert.throws(() => capture([entry('part:123:name', 'fenced')]), error => {
  assert.equal(error.path, 'part:123:name'); assert.equal(error.line, 1); return true;
 });
});
linuxTest('line caps bound whole visual display before allocation and reconstruct all separators',t=>{
 const {write,capture}=fixture(t);const text='a\r\nb\nc\rd\ve\ff\u0085g\u2028h\u2029';write('file',text);
 const file=capture([entry('file')]).files[0];assert.equal(file.display.length,9);assert.equal(file.display.map(l=>l.text+l.ending).join(''),text);assert.ok(file.display.every(l=>l.kind==='exterior'));assert.deepEqual(file.fences,[]);
 assert.throws(()=>capture([entry('file')],{maxFileLines:8}),e=>e.code==='CAPTURE_LINE_LIMIT');
 write('one','a\n');write('two','b\n');assert.throws(()=>capture([entry('one'),entry('two')],{maxTotalLines:3}),e=>e.code==='CAPTURE_LINE_LIMIT');
 assert.equal(capture([entry('one'),entry('two')],{maxTotalLines:4}).files.length,2);
});
