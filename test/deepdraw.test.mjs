import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanText, toSteps, stripMarkers } from "../lib/markers.mjs";
import { evaluate } from "../lib/gate.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "skel.mjs");

const SRC = `import { Point } from "./types";

export function smooth(raw: Point[]): Point[] {
  // SKEL[1] drop near-duplicate points
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}

export function interpolate(a: Point, b: Point): Point[] {
  // SKEL[2] catmull-rom between a and b
  throw new Error("SKEL_TODO");
  // /SKEL[2]
}
`;

test("scanText finds fences with lines, titles, and status", () => {
  const fences = scanText(SRC, "a.ts");
  assert.equal(fences.length, 2);
  assert.deepEqual(
    fences.map(({ id, title, openLine, closeLine, status }) => ({ id, title, openLine, closeLine, status })),
    [
      { id: "1", title: "drop near-duplicate points", openLine: 4, closeLine: 6, status: "todo" },
      { id: "2", title: "catmull-rom between a and b", openLine: 10, closeLine: 12, status: "todo" },
    ],
  );
});

test("scanText handles hash and block comment prefixes", () => {
  const py = "def f():\n    # SKEL[a] do it\n    raise NotImplementedError('SKEL_TODO')\n    # /SKEL[a]\n";
  const html = "<div>\n<!-- SKEL[3] markup -->\n<p>hi</p>\n<!-- /SKEL[3] -->\n</div>\n";
  assert.equal(scanText(py)[0].status, "todo");
  assert.deepEqual(scanText(html).map((f) => [f.id, f.title, f.status]), [["3", "markup", "filled"]]);
});

test("scanText rejects unclosed, mismatched, and nested fences", () => {
  assert.throws(() => scanText("// SKEL[1] x\n"), /never closed/);
  assert.throws(() => scanText("// SKEL[1] x\n// /SKEL[2]\n"), /closes SKEL\[1\]/);
  assert.throws(() => scanText("// SKEL[1] x\n// SKEL[2] y\n// /SKEL[2]\n// /SKEL[1]\n"), /don't nest/);
  assert.throws(() => scanText("// /SKEL[1]\n"), /closes nothing/);
});

test("toSteps groups multi-fence steps and sorts naturally", () => {
  const fences = [
    ...scanText("// SKEL[10] ten\nSKEL_TODO\n// /SKEL[10]\n", "a"),
    ...scanText("// SKEL[2] two\ndone\n// /SKEL[2]\n", "a"),
    ...scanText("// SKEL[2]\nSKEL_TODO\n// /SKEL[2]\n", "b.test"),
  ];
  const steps = toSteps(fences);
  assert.deepEqual(steps.map((s) => s.id), ["2", "10"]);
  assert.equal(steps[0].fences.length, 2);
  assert.equal(steps[0].status, "todo", "a step is todo while any of its fences is");
  assert.equal(steps[0].title, "two");
});

test("stripMarkers removes only marker lines", () => {
  const out = stripMarkers(SRC.replace(/throw new Error\("SKEL_TODO"\);/g, "return [];"));
  assert.ok(!out.includes("SKEL"));
  assert.ok(out.includes("return [];"));
});

// ---- gate ----

const root = "/proj";
const file = "/proj/src/a.ts";
const fill = { phase: "fill", activeStep: "1", gate: "ask" };
const gate = (toolName, toolInput, state = fill, text = SRC) =>
  evaluate({
    toolName,
    toolInput: { file_path: file, ...toolInput },
    root,
    state,
    readFile: (abs) => (abs === file ? text : null),
    activeFences: scanText(text ?? "", "src/a.ts").filter((f) => f.id === state.activeStep),
  });

test("gate has no opinion outside the fill phase or with no active step", () => {
  assert.equal(gate("Edit", { old_string: "import", new_string: "x" }, { phase: "scaffold" }), null);
  assert.equal(gate("Edit", { old_string: "import", new_string: "x" }, { phase: "fill", activeStep: null }), null);
});

test("gate allows an edit inside the active fence", () => {
  assert.equal(gate("Edit", { old_string: '  throw new Error("SKEL_TODO");\n', new_string: "  return raw;\n" }), null);
  // The stub line of step 1 occurs twice in the file (steps 1 and 2); Edit targets the first.
  assert.equal(gate("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: "return raw;" }), null);
});

test("gate asks when the edit touches a marker line", () => {
  const v = gate("Edit", { old_string: "  // SKEL[1] drop near-duplicate points\n", new_string: "" });
  assert.equal(v.decision, "ask");
  assert.match(v.reason, /src\/a\.ts:4-4/);
});

test("gate asks for edits outside the fence: signature, other step, other file, new file", () => {
  assert.equal(gate("Edit", { old_string: "smooth(raw: Point[])", new_string: "smooth(raw: Point[], k: number)" }).decision, "ask");
  const otherStep = { ...fill, activeStep: "2" };
  const firstStub = gate("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: "x" }, otherStep);
  assert.equal(firstStub.decision, "ask", "first occurrence is step 1's stub, not step 2's");
  assert.equal(gate("Edit", { old_string: "x" }, fill, "const x = 1;\n").decision, "ask");
  assert.match(gate("Write", { content: "new" }, fill, null).reason, /new file/);
});

test("gate checks every occurrence for replace_all and every MultiEdit", () => {
  const v = gate("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: "x", replace_all: true });
  assert.equal(v.decision, "ask", "the second occurrence lives in step 2's fence");
  const multi = gate("MultiEdit", { edits: [
    { old_string: 'throw new Error("SKEL_TODO");', new_string: "return raw;" },
    { old_string: "interpolate(a: Point", new_string: "lerp(a: Point" },
  ] });
  assert.equal(multi.decision, "ask");
});

test("gate allows a Write that only changes the active fence body", () => {
  const next = SRC.replace('throw new Error("SKEL_TODO");', "return raw.filter(Boolean);");
  assert.equal(gate("Write", { content: next }), null);
  const sneaky = next.replace("export function interpolate", "export async function interpolate");
  assert.equal(gate("Write", { content: sneaky }).decision, "ask");
});

test("gate honours gate: deny", () => {
  assert.equal(gate("Edit", { old_string: "import", new_string: "x" }, { ...fill, gate: "deny" }).decision, "deny");
});

test("gate ignores files outside the project and the state dir", () => {
  const v = evaluate({
    toolName: "Edit", toolInput: { file_path: "/elsewhere/x.ts", old_string: "a" }, root, state: fill,
    readFile: () => "a", activeFences: [],
  });
  assert.equal(v, null);
});

// ---- CLI end to end ----

test("CLI: init → approve → next → gate → done → finalize", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeleton-"));
  const run = (...args) => execFileSync("node", [BIN, ...args], { cwd: dir, encoding: "utf-8" });
  fs.mkdirSync(path.join(dir, "src"));
  const a = path.join(dir, "src", "a.ts");
  fs.writeFileSync(a, SRC);

  run("init", "Stroke smoothing");
  run("approve");
  assert.match(run("next"), /STEP 1 active/);

  const hook = (input) => execFileSync("node", [BIN, "hook"], { cwd: dir, input: JSON.stringify({ cwd: dir, ...input }), encoding: "utf-8" });
  assert.equal(hook({ tool_name: "Edit", tool_input: { file_path: a, old_string: 'throw new Error("SKEL_TODO");', new_string: "return raw;" } }), "");
  const out = JSON.parse(hook({ tool_name: "Edit", tool_input: { file_path: a, old_string: "import", new_string: "x" } }));
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");

  assert.throws(() => run("done"), /still has SKEL_TODO/);
  fs.writeFileSync(a, fs.readFileSync(a, "utf-8").replace('throw new Error("SKEL_TODO");', "return raw;"));
  assert.match(run("done"), /next: 2/);
  assert.match(run("next"), /STEP 2 active/);
  fs.writeFileSync(a, fs.readFileSync(a, "utf-8").replace('throw new Error("SKEL_TODO");', "return [a, b];"));
  run("done");
  assert.match(run("finalize"), /stripped markers from 1 file/);
  assert.ok(!fs.readFileSync(a, "utf-8").includes("SKEL"));

  const html = fs.readFileSync(run("review").split("\n")[0], "utf-8");
  assert.match(html, /Stroke smoothing/);
});
