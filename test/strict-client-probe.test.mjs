// #280: non-live checks for the native tool qualification probe. Nothing
// here launches a client, a sandbox or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, "live", "strict-client-probe.py");
const INNER = fs.readFileSync(path.join(HERE, "live", "strict-tools-inner.mjs"), "utf8");
const linux = { skip: process.platform !== "linux" };

function python(script, ...args) {
  const child = spawnSync("/usr/bin/python3", ["-I", "-c", script, PROBE, ...args], { encoding: "utf8", timeout: 20000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

/** Keys of each of the inner script's three check-object literals, in source order. */
function innerCheckSets() {
  const start = INNER.indexOf("const checks = searchTools ? {");
  const end = INNER.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, "the inner checks literal is where the test expects it");
  const body = INNER.slice(start + "const checks = searchTools ? {".length, end);
  const [search, file, base] = body.split(/\n\s*\}\s*:\s*(?:fileTools\s*\?\s*)?\{/);
  const keys = (block) => {
    // Every entry must be a plain identifier key on its own line, so a quoted,
    // computed or spread key can't hide from the comparison.
    const lines = block.split("\n").filter((line) => line.trim());
    for (const line of lines) assert.match(line, /^\s*[A-Za-z]\w*\s*(?::|,|$)/, `unparsed check entry: ${line.trim().slice(0, 60)}`);
    return lines.map((line) => /^\s*([A-Za-z]\w*)/.exec(line)[1]);
  };
  return { search: keys(search), file: keys(file), base: keys(base) };
}

test("#280: the outer probe's expected check names equal the inner script's, per case", linux, () => {
  const outer = python(`
import json, runpy, sys
g = runpy.run_path(sys.argv[1], run_name="probe_under_test")
print(json.dumps({k: sorted(g[k]) for k in ("SEARCH_TOOL_CHECKS", "FILE_TOOL_CHECKS", "EXPECTED_INNER_CHECKS")}))
`);
  const inner = innerCheckSets();
  for (const [label, keys] of Object.entries(inner)) assert.equal(new Set(keys).size, keys.length, `${label} keys are unique`);
  assert.deepEqual(outer.SEARCH_TOOL_CHECKS, [...inner.search].sort());
  assert.deepEqual(outer.FILE_TOOL_CHECKS, [...inner.file].sort());
  assert.deepEqual(outer.EXPECTED_INNER_CHECKS, [...inner.base].sort());
});

test("#280: the host-side corpus and file checks refuse every substitution", linux, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-probe-checks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (label, build) => {
    const work = path.join(root, label);
    fs.mkdirSync(path.join(work, "search-corpus"), { recursive: true });
    fs.writeFileSync(path.join(work, "search-corpus", "alpha.txt"), "SEARCH_NEEDLE\n");
    fs.writeFileSync(path.join(work, "search-corpus", "beta.md"), "SEARCH_CONTROL\n");
    fs.writeFileSync(path.join(work, "file-tools.txt"), "FILE_EDITED\n");
    build?.(work);
    return work;
  };
  const corpus = (work) => path.join(work, "search-corpus");
  const cases = {
    exact: make("exact"),
    extra: make("extra", (w) => fs.writeFileSync(path.join(corpus(w), "gamma.txt"), "x\n")),
    missing: make("missing", (w) => fs.rmSync(path.join(corpus(w), "beta.md"))),
    changed: make("changed", (w) => fs.writeFileSync(path.join(corpus(w), "alpha.txt"), "SEARCH_NEEDLX\n")),
    oversize: make("oversize", (w) => fs.writeFileSync(path.join(corpus(w), "alpha.txt"), "SEARCH_NEEDLE\n\n")),
    symlinkMember: make("symlink-member", (w) => {
      fs.writeFileSync(path.join(w, "real-alpha"), "SEARCH_NEEDLE\n");
      fs.rmSync(path.join(corpus(w), "alpha.txt"));
      fs.symlinkSync(path.join(w, "real-alpha"), path.join(corpus(w), "alpha.txt"));
    }),
    hardlinkMember: make("hardlink-member", (w) => fs.linkSync(path.join(corpus(w), "alpha.txt"), path.join(w, "second-link"))),
    fifoMember: make("fifo-member", (w) => {
      fs.rmSync(path.join(corpus(w), "beta.md"));
      assert.equal(spawnSync("/usr/bin/mkfifo", [path.join(corpus(w), "beta.md")]).status, 0);
    }),
    symlinkCorpus: make("symlink-corpus", (w) => {
      fs.renameSync(corpus(w), path.join(w, "elsewhere"));
      fs.symlinkSync(path.join(w, "elsewhere"), corpus(w));
    }),
    fileChanged: make("file-changed", (w) => fs.writeFileSync(path.join(w, "file-tools.txt"), "FILE_INITIAL\n")),
    fileSymlink: make("file-symlink", (w) => {
      fs.renameSync(path.join(w, "file-tools.txt"), path.join(w, "real-file"));
      fs.symlinkSync(path.join(w, "real-file"), path.join(w, "file-tools.txt"));
    }),
    fileHardlink: make("file-hardlink", (w) => fs.linkSync(path.join(w, "file-tools.txt"), path.join(w, "file-second"))),
  };
  fs.symlinkSync(cases.exact, path.join(root, "work-link"));
  cases.workSymlink = path.join(root, "work-link");
  const got = python(`
import json, runpy, sys
g = runpy.run_path(sys.argv[1], run_name="probe_under_test")
cases = json.loads(sys.argv[2])
print(json.dumps({k: [g["search_corpus_matches"](v), g["file_tool_result_matches"](v)] for k, v in cases.items()}))
`, JSON.stringify(cases));
  assert.deepEqual(got, {
    exact: [true, true],
    extra: [false, true], missing: [false, true], changed: [false, true], oversize: [false, true],
    symlinkMember: [false, true], hardlinkMember: [false, true], fifoMember: [false, true], symlinkCorpus: [false, true],
    fileChanged: [true, false], fileSymlink: [true, false], fileHardlink: [true, false],
    workSymlink: [false, false],
  });
});

test("#280: the host-side workspace check requires exact members and control bytes", linux, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-probe-work-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const got = python(`
import json, pathlib, runpy, sys
matches = runpy.run_path(sys.argv[1], run_name="probe_under_test")["workspace_fixture_matches"]
root = pathlib.Path(sys.argv[2])
results = {}
for member in ("file-tools.txt", "search-corpus"):
    work = root / member
    work.mkdir()
    fixture = work / member
    if member == "search-corpus":
        fixture.mkdir()
    else:
        fixture.write_bytes(b"FILE_EDITED\\n")
    control = work / "inside.txt"
    control.write_bytes(b"PUBLIC_PROBE\\n")
    checks = {"exact": matches(work, member)}
    extra = work / "extra.txt"
    extra.touch()
    checks["extra"] = matches(work, member)
    extra.unlink()
    control.write_bytes(b"PUBLIC_PRObE\\n")
    checks["changedControl"] = matches(work, member)
    control.unlink()
    checks["missingControl"] = matches(work, member)
    original = root / (member + ".control")
    original.write_bytes(b"PUBLIC_PROBE\\n")
    control.symlink_to(original)
    checks["linkedControl"] = matches(work, member)
    control.unlink()
    original.rename(control)
    fixture.rename(root / (member + ".moved"))
    checks["missingFixture"] = matches(work, member)
    results[member] = checks
print(json.dumps(results))
`, root);
  const expected = { exact: true, extra: false, changedControl: false, missingControl: false, linkedControl: false, missingFixture: false };
  assert.deepEqual(got, { "file-tools.txt": expected, "search-corpus": expected });
});

test("#280: the inner script strips exactly one trailing pinned-client reminder", () => {
  const literal = /content\.replace\(\s*\/(.+)\/,/.exec(INNER);
  assert.ok(literal, "the reminder pattern is where the test expects it");
  const reminder = new RegExp(literal[1]);
  const tail = "\n\n<system-reminder>\n<total_tokens>12345 tokens left</total_tokens>\n</system-reminder>";
  const strip = (text) => text.replace(reminder, "");
  assert.equal(strip("SEARCH_NEEDLE" + tail), "SEARCH_NEEDLE");
  assert.equal(strip("SEARCH_NEEDLE"), "SEARCH_NEEDLE");
  assert.equal(strip("SEARCH_NEEDLE" + tail + tail), "SEARCH_NEEDLE" + tail, "only one, at the end");
  assert.equal(strip("SEARCH_NEEDLE" + tail + "\nmore"), "SEARCH_NEEDLE" + tail + "\nmore", "anchored at the end");
  assert.equal(strip("X" + tail.replace("12345", "many")), "X" + tail.replace("12345", "many"), "digits only");
  assert.equal(strip("X" + tail.replace("12345", "12345678901")), "X" + tail.replace("12345", "12345678901"), "at most 10 digits");
  assert.equal(strip("X" + tail.replace("\n\n", "\n")), "X" + tail.replace("\n\n", "\n"), "exact separator");
});
