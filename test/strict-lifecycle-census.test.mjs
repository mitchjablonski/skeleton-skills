// The interactive census in strict-lifecycle-fault-probe.py (#270), with the
// /proc reads stubbed. No namespace is started and no process is signalled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./live/strict-lifecycle-fault-probe.py", import.meta.url));

const script = String.raw`
import json, os, runpy, subprocess, sys
probe = runpy.run_path(sys.argv[1], run_name="census_test")
census, identity_of = probe["interactive_census"], probe["namespace_identity"]
NS, WORKER, INIT = "pid:[1]", 10, 2
RECORDED = [INIT, WORKER, 11, 12]

def run(passes):
    """passes: one {pid: (ppid, start), None or "gone"} per pass, over the members."""
    members = {INIT: (1, 1), WORKER: (INIT, 5), 11: (WORKER, 6), 12: (WORKER, 6)}
    state = {"pass": 0, "rescans": 0}
    def table():
        return {**members, **passes[min(state["pass"], len(passes) - 1)]}
    def identity(pid, ns):
        assert ns in (NS, None)
        found = table().get(pid)
        if isinstance(found, list):  # ["outside", ppid, start]: alive in another namespace
            return tuple(found[1:]) if ns is None else None
        return None if found == "gone" else found
    def rescan(ns, since):
        state["pass"] += 1
        state["rescans"] += 1
        return live()
    def live():
        # None: scanned, then gone before its parent is read. "gone": not scanned.
        return sorted(pid for pid, found in table().items() if found != "gone" and not isinstance(found, list))
    try:
        census(NS, 0, RECORDED, WORKER, live(), identity=identity, rescan=rescan, pause=0, passes=4)
        return {"ok": True, "rescans": state["rescans"]}
    except AssertionError as error:
        return {"ok": False, "why": str(error), "rescans": state["rescans"]}

cases = {
    "descendants": run([{20: (WORKER, 7), 21: (20, 8), 22: (21, 9)}]),
    "vanished-before-read": run([{20: None}]),
    "short-lived-foreign": run([{20: (999, 7)}, {}]),
    "persistent-foreign": run([{20: (999, 7)}]),
    "orphan-never-seen-owned": run([{20: (INIT, 7)}]),
    "reparented-after-owned": run([{20: (WORKER, 7), 30: (999, 7)}, {20: (INIT, 7)}]),
    "reused-pid-after-owned": run([{20: (WORKER, 7), 30: (999, 7)}, {20: (INIT, 9)}]),
    "parent-pid-reused": run([{20: (WORKER, 7), 30: (999, 7)}, {20: (999, 9), 21: (20, 10)}]),
    "parent-reused-outside": run([{20: (WORKER, 7), 30: (999, 7)}, {20: ["outside", 999, 9], 21: (20, 10)}]),
    "parent-exited": run([{20: (WORKER, 7), 30: (999, 7)}, {21: (20, 10)}]),
    "parent-younger-than-child": run([{20: (WORKER, 7), 21: (20, 6)}]),
    "member-left": run([{12: "gone"}]),
    "worker-gone": run([{WORKER: None}]),
    "too-many": run([{100 + i: (WORKER, 7) for i in range(33)}]),
}

me = os.getpid()
ns = os.readlink("/proc/self/ns/pid")
mine = identity_of(me, ns)
with open("/proc/self/stat") as source:
    data = source.read()
fields = data[data.rindex(")") + 2:].split()
child = subprocess.Popen(["/usr/bin/sleep", "30"])
alive = identity_of(child.pid, ns)
child.kill()
os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
zombie = identity_of(child.pid, ns)
child.wait()
live = {
    "self": mine == (int(fields[1]), int(fields[19])),
    "other-namespace": identity_of(me, "pid:[0]") is None,
    "child": alive is not None and alive[0] == me,
    "zombie": zombie is None,
    "reaped": identity_of(child.pid, ns) is None,
}
print(json.dumps({"cases": cases, "live": live}))
`;

test("the interactive census tolerates exits but refuses anything not descended from the worker", { skip: process.platform !== "linux" }, () => {
  const child = spawnSync("/usr/bin/python3", ["-I", "-c", script, probe], { encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const { cases, live } = JSON.parse(child.stdout);
  const accepted = (name, rescans) => assert.deepEqual(cases[name], { ok: true, rescans }, name);
  const refused = (name, why) => assert.deepEqual([cases[name].ok, cases[name].why], [false, why], name);

  accepted("descendants", 0);
  accepted("vanished-before-read", 0);
  // An unaccounted process that is gone on the next pass is a race, not a refusal.
  accepted("short-lived-foreign", 1);
  // A second pass is forced by 30. Owned by (PID, start), so reparenting to init after its parent exits keeps it owned.
  accepted("reparented-after-owned", 1);
  // The child's parent read named an owned parent that has since exited.
  accepted("parent-exited", 1);

  const unaccounted = "unaccounted interactive descendant";
  refused("persistent-foreign", unaccounted);
  assert.equal(cases["persistent-foreign"].rescans, 3, "every pass is used before refusing");
  refused("orphan-never-seen-owned", unaccounted);
  refused("reused-pid-after-owned", unaccounted);
  refused("parent-pid-reused", unaccounted);
  refused("parent-reused-outside", unaccounted);
  refused("parent-younger-than-child", unaccounted);
  refused("member-left", "a recorded member left the namespace");
  refused("worker-gone", "the verified worker has gone");
  refused("too-many", "too many interactive descendants");

  assert.deepEqual(live, { self: true, "other-namespace": true, child: true, zombie: true, reaped: true });
});
