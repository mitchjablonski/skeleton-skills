// #78: strict-tier runtime status against the proposed RuntimeEvidence
// fixtures. Fixture phase: no evidence producer exists, so the CLI can never
// report active, and default-mode output must not change.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_VERIFIER, EVIDENCE_REASONS, IN_BOUNDARY_TRANSITIONS, LOCAL_REASONS, MAX_EVIDENCE_AGE_MS, MAX_EVIDENCE_LIFETIME_MS, STRICT_STATES, classifyEvidence, refuseInBoundaryTransition, refusePrivileged, strictLine, strictStatus } from "../lib/strict-status.mjs";
import { ACTIVE, CONTEXT, MALFORMED, NEGATIVE, NOW, POSITIVE, PROFILE, PROJECT, SESSION, UNVERIFIED_REASONS, fixtureVerifier, throwingVerifier } from "./fixtures/strict-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "skel.mjs");
const TEMPS = [];
after(() => { for (const d of TEMPS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch {} } });
const mkTemp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); TEMPS.push(d); return d; };

const notActive = (status, label) => {
  assert.notEqual(status.state, "active", label);
  assert.equal(status.privilegedActions, status.requested === true ? "refused" : undefined, label);
  assert.equal(status.evidence, undefined, label);
  assert.ok(refusePrivileged(status, "approve"), label);
};

// ---- the fixtures ----

test("the fixture reasons match the module's evidence reasons", () => {
  assert.deepEqual(UNVERIFIED_REASONS, EVIDENCE_REASONS);
});

test("each positive fixture maps to its state, and only active allows privileged actions", async () => {
  for (const [name, { evidence, expect }] of Object.entries(POSITIVE)) {
    const status = await strictStatus({ verifier: fixtureVerifier(evidence), ...CONTEXT });
    assert.equal(status.state, expect.state, name);
    assert.equal(status.reason, expect.reason, name);
    if (expect.state === "active") {
      assert.equal(status.privilegedActions, "allowed");
      assert.equal(refusePrivileged(status, "approve"), null);
      const { kind, ...bound } = ACTIVE;
      assert.deepEqual({ ...status.evidence }, bound);
    } else notActive(status, name);
  }
});

test("expired, wrong-project, wrong-session and other near-active evidence is never active", async () => {
  for (const [name, { evidence, expect, context }] of Object.entries(NEGATIVE)) {
    const status = await strictStatus({ verifier: fixtureVerifier(evidence), ...CONTEXT, ...context });
    assert.equal(status.state, expect.state, name);
    assert.equal(status.reason, expect.reason, name);
    notActive(status, name);
  }
});

test("malformed evidence is unreadable, never active", async () => {
  for (const [name, evidence] of Object.entries(MALFORMED)) {
    const status = await strictStatus({ verifier: fixtureVerifier(evidence), ...CONTEXT });
    assert.equal(status.state, "unverified", name);
    assert.equal(status.reason, "evidence-unreadable", name);
    notActive(status, name);
  }
});

test("a verifier that throws or rejects gives evidence-unreadable", async () => {
  notActive(await strictStatus({ verifier: throwingVerifier, ...CONTEXT }), "throws");
  assert.equal((await strictStatus({ verifier: throwingVerifier, ...CONTEXT })).reason, "evidence-unreadable");
  const rejecting = { verify: () => Promise.reject(new Error("closed")) };
  assert.equal((await strictStatus({ verifier: rejecting, ...CONTEXT })).reason, "evidence-unreadable");
  assert.equal((await strictStatus({ verifier: {}, ...CONTEXT })).reason, "evidence-unreadable", "no verify method");
  assert.equal((await strictStatus({ verifier: { verify: async () => ACTIVE }, ...CONTEXT })).state, "active", "an async verifier works");
});

test("active evidence needs a current project, session and supported profile to bind to", () => {
  notActive(classifyEvidence(ACTIVE, { ...CONTEXT, supportedProfiles: undefined }), "no profiles listed");
  assert.equal(classifyEvidence(ACTIVE, { ...CONTEXT, supportedProfiles: [] }).reason, "profile-unsupported");
  for (const ctx of [{ projectId: undefined }, { sessionId: null }, { sessionId: "" }, { projectId: PROJECT.toUpperCase() }]) {
    const status = classifyEvidence(ACTIVE, { ...CONTEXT, ...ctx });
    assert.equal(status.reason, "evidence-mismatch", JSON.stringify(ctx));
    notActive(status, JSON.stringify(ctx));
  }
  assert.equal(classifyEvidence(ACTIVE, { ...CONTEXT, now: NOW + 55_000 }).reason, "evidence-stale", "goes stale at expiresAt");
  assert.equal(classifyEvidence(ACTIVE, { ...CONTEXT, now: NOW + 54_999 }).state, "active");
});

test("the default verifier is never active, whatever the context", async () => {
  for (const ctx of [{}, CONTEXT, { projectId: PROJECT, sessionId: SESSION, supportedProfiles: [PROFILE] }]) {
    const status = await strictStatus(ctx);
    assert.equal(status.state, "unsupported");
    notActive(status, "default");
  }
  assert.deepEqual(DEFAULT_VERIFIER.verify(), { kind: "unsupported" });
  assert.ok(Object.isFrozen(DEFAULT_VERIFIER));
});

test("the status module reads no files, settings or environment", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "lib", "strict-status.mjs"), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m, "no imports at all");
  assert.doesNotMatch(src, /process\.|require\(|import\(/);
});

// ---- copy ----

test("every state and reason has plain copy with a next step, and says drift is detected, not prevented", async () => {
  const statuses = [
    ...await Promise.all(Object.values(POSITIVE).map(({ evidence }) => strictStatus({ verifier: fixtureVerifier(evidence), ...CONTEXT }))),
    ...Object.values(NEGATIVE).map(({ evidence, context }) => classifyEvidence(evidence, { ...CONTEXT, ...context })),
  ];
  const seen = new Set(statuses.map((s) => s.reason ? `${s.state}:${s.reason}` : s.state));
  for (const reason of [...EVIDENCE_REASONS, ...LOCAL_REASONS]) assert.ok(seen.has(`unverified:${reason}`), reason);
  for (const state of STRICT_STATES) assert.ok([...seen].some((k) => k.startsWith(state)), state);
  for (const s of statuses) {
    assert.match(s.summary, /^Strict tier: /);
    assert.ok(s.next.length > 20, s.state);
    assert.match(s.drift, /detect.*refuse/);
    assert.match(s.drift, /does not stop files in the workspace from being written/);
    assert.doesNotMatch(`${s.summary} ${s.next}`, /contain|prevent|sandbox/i, "no containment claim");
    if (s.state !== "active") assert.match(s.next, /refused/, `${s.state}:${s.reason}`);
    else assert.match(`${s.summary} ${s.next}`, /Enforcement reports.*Enforcement reports/s, "active copy is conditional, not a capability claim");
  }
  // Each reason has its own words, not one generic message.
  const unverified = statuses.filter((s) => s.state === "unverified");
  assert.equal(new Set(unverified.map((s) => s.summary)).size, new Set(unverified.map((s) => s.reason)).size);
});

test("freshness is capped on top of the producer's expiresAt (provisional caps for Sol)", () => {
  assert.equal(MAX_EVIDENCE_LIFETIME_MS, 10 * 60_000);
  assert.equal(MAX_EVIDENCE_AGE_MS, 10 * 60_000);
  const at = (observed, expires) => ({ ...ACTIVE, observedAt: new Date(observed).toISOString(), expiresAt: new Date(expires).toISOString() });
  assert.equal(classifyEvidence(at(NOW - 1000, NOW - 1000 + MAX_EVIDENCE_LIFETIME_MS), CONTEXT).state, "active", "exactly the lifetime cap");
  assert.equal(classifyEvidence(at(NOW - 1000, NOW - 999 + MAX_EVIDENCE_LIFETIME_MS), CONTEXT).reason, "evidence-unreadable", "1ms over the lifetime cap");
  const lifted = { ...CONTEXT, maxLifetimeMs: 3_600_000 };
  assert.equal(classifyEvidence(at(NOW - MAX_EVIDENCE_AGE_MS, NOW + 60_000), lifted).state, "active", "exactly the age cap");
  assert.equal(classifyEvidence(at(NOW - MAX_EVIDENCE_AGE_MS - 1, NOW + 60_000), lifted).reason, "evidence-stale", "1ms over the age cap");
});

test("options and evidence are read from own properties only", async () => {
  const inherited = Object.assign(Object.create({ supportedProfiles: [PROFILE], now: NOW, maxLifetimeMs: Infinity }), { projectId: PROJECT, sessionId: SESSION });
  notActive(classifyEvidence(ACTIVE, inherited), "inherited options");
  assert.equal(classifyEvidence(Object.create(ACTIVE), CONTEXT).reason, "evidence-unreadable");
  const viaProto = Object.assign(Object.create({ verifier: fixtureVerifier(ACTIVE) }), CONTEXT);
  assert.equal((await strictStatus(viaProto)).state, "unsupported", "an inherited verifier is ignored");
});

test("requested and unrequested strict differ: only a request refuses privileged actions", async () => {
  const unrequested = await strictStatus({ ...CONTEXT, requested: false });
  assert.equal(unrequested.state, "unsupported");
  assert.equal(unrequested.requested, false);
  assert.equal(unrequested.privilegedActions, undefined);
  assert.match(unrequested.next, /default mode is unchanged/);
  const requested = await strictStatus({ ...CONTEXT, requested: true });
  assert.equal(requested.state, "unsupported");
  assert.equal(requested.requested, true);
  assert.equal(requested.privilegedActions, "refused");
  assert.match(requested.summary, /Strict was requested for this project/);
  assert.match(requested.next, /refused in strict mode, and skel doesn't fall back to default mode on its own/);
  assert.doesNotMatch(requested.next, /Nothing to do|unchanged/);
  assert.match(refusePrivileged(requested, "finalize"), /^refused: finalize .*unsupported\. Approve, reshape and finalize are refused/);
  notActive(classifyEvidence({ kind: "unverified", reason: "evidence-stale" }, { ...CONTEXT, requested: true }), "requested stale");
  // A strict helper refuses even active evidence when strict wasn't requested.
  assert.ok(refusePrivileged(classifyEvidence(ACTIVE, { ...CONTEXT, requested: false }), "approve"));
});

test("an unverified reason is read once, and a throwing getter or proxy is unreadable", async () => {
  let reads = 0;
  const flipping = { kind: "unverified", get reason() { reads += 1; return reads === 1 ? "evidence-stale" : "not-a-reason"; } };
  const status = classifyEvidence(flipping, CONTEXT);
  assert.equal(reads, 1);
  assert.equal(status.reason, "evidence-stale");
  assert.match(status.next, /^Restart the session/);
  const throwing = { kind: "unverified", get reason() { throw new Error("boom"); } };
  assert.equal(classifyEvidence(throwing, CONTEXT).reason, "evidence-unreadable");
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } });
  assert.equal(classifyEvidence(proxy, CONTEXT).reason, "evidence-unreadable");
  assert.equal((await strictStatus({ verifier: fixtureVerifier(throwing), ...CONTEXT })).reason, "evidence-unreadable");
  const badOptions = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } });
  assert.equal(classifyEvidence(ACTIVE, badOptions).reason, "evidence-unreadable");
});

test("requested must be exactly true: anything else shows as not requested and still refuses", () => {
  for (const requested of [undefined, null, false, "true", "yes", 1, {}, [true]]) {
    const label = JSON.stringify(requested) ?? "undefined";
    const active = classifyEvidence(ACTIVE, { ...CONTEXT, requested });
    assert.equal(active.requested, false, label);
    assert.equal(active.privilegedActions, undefined, label);
    assert.ok(refusePrivileged(active, "approve"), label);
    const stale = classifyEvidence({ kind: "unverified", reason: "evidence-stale" }, { ...CONTEXT, requested });
    assert.equal(stale.privilegedActions, undefined, label);
  }
  const { requested, ...absent } = CONTEXT;
  assert.equal(classifyEvidence(ACTIVE, absent).requested, false, "absent is not requested");
  assert.ok(refusePrivileged({ ...classifyEvidence(ACTIVE, CONTEXT), requested: "yes" }, "approve"), "a status without requested: true is refused");
});

test("unverified and ended copy says refused only when strict was requested", () => {
  const evidence = [{ kind: "ended" }, ...EVIDENCE_REASONS.map((reason) => ({ kind: "unverified", reason })), NEGATIVE["wrong-project"].evidence];
  for (const e of evidence) {
    const on = classifyEvidence(e, CONTEXT), off = classifyEvidence(e, { ...CONTEXT, requested: false });
    const label = `${on.state}:${on.reason}`;
    assert.match(on.next, /Approve, reshape and finalize are refused until status shows active\.$/, label);
    assert.doesNotMatch(off.next, /refused/, label);
    assert.match(off.next, /Strict wasn't requested for this project, so default mode applies unchanged\.$/, label);
    assert.equal(on.summary, off.summary, label);
  }
});

test("the refusal names the action, the state and the next step", () => {
  const stale = classifyEvidence(NEGATIVE.expired.evidence, CONTEXT);
  const msg = refusePrivileged(stale, "approve");
  assert.match(msg, /^refused: approve needs strict status active; it is unverified \(evidence-stale\)\. Restart the session/);
  assert.match(refusePrivileged(null, "finalize"), /^refused: finalize .*couldn't be read/);
  assert.match(refusePrivileged({ state: "active" }, "reshape"), /^refused/, "a hand-built active object without allowed is refused");
  assert.match(refusePrivileged({ state: "on", privilegedActions: "allowed" }, "reshape"), /couldn't be read/);
});

// ---- in-boundary CLI transitions (#84 (e)) ----

// Every state and reason the classifier can give, as { name, evidence }.
const EVERY_STATUS = [
  ...Object.entries(POSITIVE).map(([name, { evidence }]) => ({ name, evidence })),
  { name: "unverified:evidence-mismatch", evidence: NEGATIVE["wrong-project"].evidence },
];

test("in-boundary transitions: the cases cover every state and reason", () => {
  const seen = new Set(EVERY_STATUS.map(({ evidence }) => { const st = classifyEvidence(evidence, CONTEXT); return st.reason ? `${st.state}:${st.reason}` : st.state; }));
  const expected = ["active", "unsupported", "ended", ...[...EVIDENCE_REASONS, ...LOCAL_REASONS].map((r) => `unverified:${r}`)];
  assert.deepEqual([...seen].sort(), expected.sort());
  assert.deepEqual([...STRICT_STATES].sort(), [...new Set(expected.map((k) => k.split(":")[0]))].sort());
  assert.deepEqual([...IN_BOUNDARY_TRANSITIONS], ["approve", "reshape", "finalize"]);
});

test("in-boundary transitions: a strict-requested project ALWAYS refuses approve, reshape and finalize, even when active", () => {
  for (const { name, evidence } of EVERY_STATUS) {
    const status = classifyEvidence(evidence, { ...CONTEXT, requested: true });
    assert.equal(status.requested, true, name);
    for (const action of IN_BOUNDARY_TRANSITIONS) {
      const msg = refuseInBoundaryTransition(status, action);
      assert.ok(msg, `${name} ${action}`);
      assert.match(msg, new RegExp(`^refused: ${action} can't run from inside the session in a strict project, even when strict status is active \\(strict status is ${status.state}`), `${name} ${action}`);
      assert.match(msg, /go only through the protected human decision page/, `${name} ${action}`);
      assert.doesNotMatch(msg, /until status shows active/, "never suggests active would let the CLI through");
    }
  }
  // The difference from refusePrivileged, which is a copy helper and allows when active.
  const active = classifyEvidence(ACTIVE, CONTEXT);
  assert.equal(active.state, "active");
  assert.equal(active.privilegedActions, "allowed");
  assert.equal(refusePrivileged(active, "approve"), null);
  assert.ok(refuseInBoundaryTransition(active, "approve"));
  assert.ok(refuseInBoundaryTransition(active, "Approve"), "any action name is refused in a strict project");
});

test("in-boundary transitions: null only when strict wasn't requested, in every state", () => {
  for (const { name, evidence } of EVERY_STATUS) {
    const status = classifyEvidence(evidence, { ...CONTEXT, requested: false });
    assert.equal(status.requested, false, name);
    for (const action of IN_BOUNDARY_TRANSITIONS) assert.equal(refuseInBoundaryTransition(status, action), null, `${name} ${action}`);
  }
  // The CLI's own default status, which is what a default-mode project sees.
  assert.equal(refuseInBoundaryTransition(classifyEvidence(DEFAULT_VERIFIER.verify(), {}), "approve"), null);
});

test("in-boundary transitions: a missing or malformed status is refused, never allowed", () => {
  const active = classifyEvidence(ACTIVE, CONTEXT);
  for (const [label, status] of [
    ["null", null], ["undefined", undefined], ["string", "active"], ["empty object", {}],
    ["unknown state", { state: "on", requested: false }],
    ["requested missing", { state: "unsupported" }],
    ["requested 'no'", { state: "unsupported", requested: "no" }],
    ["requested 0", { state: "unsupported", requested: 0 }],
    ["requested 'yes' on active", { ...active, requested: "yes" }],
  ]) {
    const msg = refuseInBoundaryTransition(status, "finalize");
    assert.ok(msg, label);
    assert.match(msg, /^refused: finalize .*strict status couldn't be read/, label);
  }
});

test("in-boundary transitions: a forged requested:false is refused (respread, inherited, accessor, Proxy)", () => {
  const strictActive = classifyEvidence(ACTIVE, { ...CONTEXT, requested: true });
  const notRequested = classifyEvidence({ kind: "unsupported" }, { ...CONTEXT, requested: false });
  assert.equal(refuseInBoundaryTransition(notRequested, "approve"), null, "the genuine status is allowed");
  let reads = 0;
  const forged = {
    "respread": { ...strictActive, requested: false },
    "respread of an allowed status": { ...notRequested },
    "bare literal": { state: "active", requested: false },
    "inherited from a status": Object.create(notRequested),
    "inherited requested": Object.assign(Object.create({ requested: false }), { state: "active" }),
    "accessor answering differently on each read": Object.defineProperties({}, {
      state: { enumerable: true, value: "active" },
      requested: { enumerable: true, get: () => (reads++ === 0 ? true : false) },
    }),
    "Proxy over a strict status": new Proxy(strictActive, { get: (t, k) => (k === "requested" ? false : t[k]), getOwnPropertyDescriptor: (t, k) => (k === "requested" ? { value: false, writable: false, enumerable: true, configurable: false } : Reflect.getOwnPropertyDescriptor(t, k)) }),
    "Proxy over an allowed status": new Proxy(notRequested, {}),
  };
  for (const [label, status] of Object.entries(forged)) {
    const msg = refuseInBoundaryTransition(status, "approve");
    assert.ok(msg, label);
    assert.match(msg, /^refused: approve .*strict status couldn't be read/, label);
  }
  assert.equal(reads, 0, "an accessor is never called");
});

test("in-boundary transitions: the action name is sanitized before it reaches the message", () => {
  const strictActive = classifyEvidence(ACTIVE, CONTEXT);
  for (const action of ["approve\nok: approved", "<b>x</b>", "", 42, null, undefined, "x".repeat(40)]) {
    const msg = refuseInBoundaryTransition(strictActive, action);
    assert.match(msg, /^refused: this transition can't run from inside the session/, String(action));
    assert.doesNotMatch(msg, /\n|<b>/);
  }
  assert.match(refuseInBoundaryTransition(strictActive, "finalize"), /^refused: finalize /);
});

test("in-boundary transitions: the helper isn't wired into the CLI", () => {
  const bin = fs.readFileSync(BIN, "utf-8");
  assert.doesNotMatch(bin, /refuseInBoundaryTransition|refusePrivileged/);
});

test("the human strict line is one line with the state, reason and next step", () => {
  const line = strictLine(classifyEvidence({ kind: "unverified", reason: "launcher-absent" }, CONTEXT));
  assert.match(line, /^strict: unverified \(launcher-absent\) — This session wasn't started by the strict launcher.* Next: End this session/);
  assert.doesNotMatch(line, /\n/);
  assert.match(strictLine(classifyEvidence({ kind: "unsupported" }, CONTEXT)), /^strict: unsupported — Strict was requested for this project, but this release has no strict enforcement\. Next: Approve, reshape and finalize are refused/);
});

// ---- the CLI ----

function project() {
  const root = mkTemp("skel-strict-");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config"), LOCALAPPDATA: path.join(root, "localappdata") };
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: "utf8" });
  return { root, env, run };
}
const fenced = 'export function value() {\n// SKEL[1] value\nthrow new Error("SKEL_TODO");\n// /SKEL[1]\n}\n';

test("skel status --json carries strict: unsupported, not requested, and no refusal in default mode", () => {
  const { root, run } = project();
  assert.equal(run("init", "strict json").status, 0);
  fs.writeFileSync(path.join(root, "code.js"), fenced);
  for (const phase of ["scaffold", "fill"]) {
    if (phase === "fill") assert.equal(run("approve").status, 0);
    const res = run("status", "--json");
    assert.equal(res.status, 0, res.stderr);
    const json = JSON.parse(res.stdout);
    assert.equal(json.phase, phase);
    assert.equal(json.strict.state, "unsupported");
    assert.equal(json.strict.requested, false);
    assert.equal(json.strict.privilegedActions, undefined, "default mode refuses nothing");
    assert.doesNotMatch(JSON.stringify(json.strict), /refused/, "default JSON never says refused");
    assert.match(json.strict.summary, /not available/);
    assert.match(json.strict.drift, /does not stop files/);
  }
});

test("planted evidence files and settings can't make skel status active", () => {
  const { root, env, run } = project();
  assert.equal(run("init", "planted").status, 0);
  fs.writeFileSync(path.join(root, "code.js"), fenced);
  const planted = JSON.stringify({ ...ACTIVE, projectId: root, expiresAt: "2999-01-01T00:00:00.000Z", observedAt: "2000-01-01T00:00:00.000Z" });
  for (const f of [".skeleton/strict.json", ".skeleton/strict-evidence.json", ".skeleton/runtime-evidence.json", "state/skel/strict-evidence.json", ".claude/settings.json"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), f.endsWith("settings.json") ? JSON.stringify({ strict: true, skelStrict: ACTIVE }) : planted);
  }
  const state = JSON.parse(fs.readFileSync(path.join(root, ".skeleton/state.json"), "utf8"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), JSON.stringify({ ...state, strict: ACTIVE }));
  const res = spawnSync(process.execPath, [BIN, "status", "--json"], { cwd: root, env: { ...env, SKEL_STRICT: "1", SKEL_STRICT_EVIDENCE: planted }, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.strict.state, "unsupported");
  assert.equal(json.strict.requested, false);
  assert.equal(json.strict.evidence, undefined);
  assert.equal(json.strict.privilegedActions, undefined);
});

test("skel status --json on unreadable state still carries strict", () => {
  const { root, run } = project();
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), "{");
  const res = run("status", "--json");
  assert.equal(res.status, 1);
  const json = JSON.parse(res.stdout);
  assert.match(json.error, /init --force/);
  assert.equal(json.strict.state, "unsupported");
  assert.equal(json.strict.privilegedActions, undefined);
});

test("regression: default-mode skel status output is unchanged, with no strict line", () => {
  const { root, run } = project();
  assert.equal(run("init", "regress").status, 0);
  fs.writeFileSync(path.join(root, "code.js"), fenced);
  const scaffold = run("status");
  assert.equal(scaffold.status, 0, scaffold.stderr);
  assert.equal(scaffold.stdout, "regress — phase: scaffold — 0/1 done\n  · 1     value  (code.js:2)\n");
  assert.equal(run("approve").status, 0);
  const fill = run("status");
  assert.equal(fill.status, 0, fill.stderr);
  assert.match(fill.stdout, /^regress — phase: fill — 0\/1 done\n  · 1     value  \(code\.js:2\)\n  \(this checked only the skeleton's own files: new, deleted or changed files elsewhere are checked against source baseline [0-9a-f]{12} at skel done and skel finalize\)\n$/);
  for (const out of [scaffold, fill]) assert.doesNotMatch(out.stdout + out.stderr, /strict/i);
  // The default approve path is not gated on strict status.
  assert.equal(JSON.parse(run("status", "--json").stdout).phase, "fill");
});
