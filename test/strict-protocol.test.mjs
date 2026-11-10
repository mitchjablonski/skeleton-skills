import test from "node:test";
import assert from "node:assert/strict";
import { parseStrictIntent, parseAuthorityState, parseStrictResult,
  strictIntentIdentity, strictIntentConflict } from "../lib/strict-protocol.mjs";

const state = () => ({ projectId: "project-1", sessionId: "session-1", reviewRoundId: "round-1",
  phase: "skeleton", reviewVersion: "version-1", approvedVersion: null, revision: 0 });
const intent = () => ({ protocolVersion: 1, requestId: "request-1", action: "approve",
  projectId: "project-1", sessionId: "session-1", reviewRoundId: "round-1",
  reviewVersion: "version-1", expectedRevision: 0 });

test("strict intents reject hidden, inherited, accessor and extra fields without executing getters", () => {
  assert.ok(parseStrictIntent(intent()));
  for (const key of Object.keys(intent())) {
    const v = intent(); delete v[key]; assert.equal(parseStrictIntent(v), null, key);
  }
  assert.equal(parseStrictIntent({ ...intent(), authenticated: true }), null);
  assert.equal(parseStrictIntent(Object.create(intent())), null);
  let called = false;
  const getter = intent(); Object.defineProperty(getter, "action", { get() { called = true; throw Error(); } });
  assert.equal(parseStrictIntent(getter), null); assert.equal(called, false);
  const symbol = intent(); symbol[Symbol("secret")] = true;
  assert.equal(parseStrictIntent(symbol), null);
  const hidden = intent(); Object.defineProperty(hidden, "requestId", { value: "request-1", enumerable: false });
  assert.equal(parseStrictIntent(hidden), null);
  assert.equal(parseStrictIntent(new Proxy({}, { ownKeys() { throw Error(); } })), null);
});

test("strict contract refuses alternate reset/migration writers and invalid identifiers/revisions", () => {
  for (const action of ["replace", "init", "init-force", "migrate", "clean", "stash"]) {
    assert.equal(parseStrictIntent({ ...intent(), action }), null);
  }
  for (const projectId of ["", "/tmp/project", "http://host/", "a b", "a\n", "x".repeat(257), null]) {
    assert.equal(parseStrictIntent({ ...intent(), projectId }), null);
  }
  for (const expectedRevision of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    assert.equal(parseStrictIntent({ ...intent(), expectedRevision }), null);
  }
  assert.equal(parseStrictIntent({ ...intent(), protocolVersion: 2 }), null);
});

test("public authority state is consistent and validated copies cannot mutate input", () => {
  const input = state(), parsed = parseAuthorityState(input);
  assert.ok(Object.isFrozen(parsed)); input.revision = 9; assert.equal(parsed.revision, 0);
  assert.equal(parseAuthorityState({ ...state(), approvedVersion: "version-1" }), null);
  assert.equal(parseAuthorityState({ ...state(), phase: "fill" }), null);
  assert.ok(parseAuthorityState({ ...state(), phase: "fill", approvedVersion: "version-1" }));
  assert.equal(parseAuthorityState({ ...state(), phase: "done" }), null);
});

test("strict preconditions distinguish identity, round, revision, content and phase conflicts", () => {
  assert.equal(strictIntentConflict(state(), intent()), null);
  assert.equal(strictIntentConflict(state(), { ...intent(), projectId: "other" }), "unauthorized-channel");
  assert.equal(strictIntentConflict(state(), { ...intent(), sessionId: "other" }), "unauthorized-channel");
  assert.equal(strictIntentConflict(state(), { ...intent(), reviewRoundId: "other" }), "stale-review");
  assert.equal(strictIntentConflict(state(), { ...intent(), expectedRevision: 1 }), "revision-conflict");
  assert.equal(strictIntentConflict(state(), { ...intent(), reviewVersion: "other" }), "stale-review");
  const fill = { ...state(), phase: "fill", approvedVersion: "version-1", reviewVersion: "draft-2" };
  assert.equal(strictIntentConflict(fill, intent()), "stale-review");
  for (const action of ["reshape", "finalize"]) {
    assert.equal(strictIntentConflict(fill, { ...intent(), action }), null);
    assert.equal(strictIntentConflict(fill, { ...intent(), action, reviewVersion: "draft-2" }), "stale-review");
  }
  assert.equal(strictIntentConflict(null, intent()), "invalid-transition");
  assert.equal(strictIntentConflict({ ...state(), revision: Number.MAX_SAFE_INTEGER },
    { ...intent(), expectedRevision: Number.MAX_SAFE_INTEGER }), "invalid-transition");
});

test("durable dedupe identity binds every intent field and ignores property order", () => {
  const first = strictIntentIdentity(intent());
  assert.equal(strictIntentIdentity(Object.fromEntries(Object.entries(intent()).reverse())), first);
  for (const key of ["requestId", "projectId", "sessionId", "reviewRoundId", "reviewVersion"]) {
    assert.notEqual(strictIntentIdentity({ ...intent(), [key]: "changed" }), first);
  }
  assert.notEqual(strictIntentIdentity({ ...intent(), expectedRevision: 1 }), first);
  assert.notEqual(strictIntentIdentity({ ...intent(), action: "reshape" }), first);
  assert.equal(strictIntentIdentity({}), null);
});

test("strict result echoes committed identity and handles unknown transport outcomes", () => {
  const committed = { kind: "committed", requestId: "request-1", action: "approve", reviewVersion: "version-1", revision: 1 };
  assert.ok(parseStrictResult(committed));
  assert.equal(parseStrictResult({ ...committed, revision: 0 }), null);
  assert.equal(parseStrictResult({ ...committed, action: "migrate" }), null);
  for (const code of ["stale-review", "revision-conflict", "invalid-transition", "unauthorized-channel",
    "session-ended", "unavailable", "request-reused"]) assert.ok(parseStrictResult({ kind: "rejected", code }));
  assert.equal(parseStrictResult({ kind: "rejected", code: "unknown" }), null);
  assert.equal(parseStrictResult(null), null);
  for (const original of [committed, { kind: "rejected", code: "unavailable" }]) {
    let reads = 0;
    const changing = new Proxy(original, { getOwnPropertyDescriptor(target, key) {
      const d = Reflect.getOwnPropertyDescriptor(target, key);
      return key === "kind" && ++reads > 1 ? { ...d, value: "unexpected" } : d;
    } });
    assert.equal(parseStrictResult(changing), null, "discriminator must remain valid in the copied record");
  }
});
