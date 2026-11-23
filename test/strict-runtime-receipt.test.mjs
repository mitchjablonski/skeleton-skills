import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('runtime receipt schema and fingerprint self-test', {skip:process.platform!=='linux'},()=>{
 const run=spawnSync('/usr/bin/python3',['-I',fileURLToPath(new URL('./live/strict-runtime-receipt.py',import.meta.url)),'--self-test'],{encoding:'utf8',timeout:10000,maxBuffer:16384,env:{}});
 assert.equal(run.status,0,run.error?.message??run.stderr);
 assert.match(run.stdout,/strict-runtime-receipt self-test passed/);
});

test('runtime selection refuses changed or unavailable observations', {skip:process.platform!=='linux'},()=>{
 const run=spawnSync('/usr/bin/python3',['-I',fileURLToPath(new URL('./live/strict-runtime-selection.py',import.meta.url)),'--self-test'],{encoding:'utf8',timeout:10000,maxBuffer:16384,env:{}});
 assert.equal(run.status,0,run.error?.message??run.stderr);
 assert.match(run.stdout,/strict-runtime-selection self-test passed/);
});

test('host launch admission binds and consumes ready state before spawning', {skip:process.platform!=='linux'},()=>{
 const run=spawnSync('/usr/bin/python3',['-I',fileURLToPath(new URL('./live/strict-launch-admission-check.py',import.meta.url))],{encoding:'utf8',timeout:10000,maxBuffer:16384,env:{}});
 assert.equal(run.status,0,run.error?.message??run.stderr);
 assert.match(run.stdout,/strict launch admission checks passed/);
});

test('supervisor handoff requires an exact, fresh, one-use stop receipt', {skip:process.platform!=='linux'},()=>{
 const run=spawnSync('/usr/bin/python3',['-I',fileURLToPath(new URL('./live/strict-supervisor-handoff-check.py',import.meta.url))],{encoding:'utf8',timeout:10000,maxBuffer:16384,env:{}});
 assert.equal(run.status,0,run.error?.message??run.stderr);
 assert.match(run.stdout,/strict supervisor handoff checks passed/);
});

test('owned terminal reports watchdog exit separately from a live response timeout', { skip: process.platform !== 'linux' }, () => {
  const probe = fileURLToPath(new URL('./live/strict-terminal-host-probe.py', import.meta.url));
  const script = `
import runpy
import subprocess
import sys
import time

fixture = runpy.run_path(sys.argv[1])
expect = fixture['expect_terminal']
expect.__globals__['TIMEOUT'] = 1

for statement, expected, status in (
    ('import time; time.sleep(0.1); raise SystemExit(3)', 'terminal-watchdog-expired', 3),
    ('import time; time.sleep(8)', 'terminal-response-timeout', None),
):
    owner = fixture['FixtureTerminal']()
    try:
        owner.started_at = time.monotonic()
        owner.process = subprocess.Popen([sys.executable, '-I', '-c', statement])
        try:
            expect(owner.master, b'expected status', terminal=owner, phase='post-restart-status')
        except fixture['TerminalReadFailure'] as refusal:
            assert str(refusal) == expected and refusal.status == status, str(refusal)
            assert refusal.phase == 'post-restart-status' and refusal.age_ms >= 0
        else:
            raise AssertionError('read unexpectedly succeeded')
        finally:
            if owner.process.poll() is None:
                owner.process.terminate()
            owner.process.wait(timeout=2)
    finally:
        owner.close()
`;
  const run = spawnSync('/usr/bin/python3', ['-I', '-c', script, probe], { encoding: 'utf8', timeout: 5000, env: {} });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
});
