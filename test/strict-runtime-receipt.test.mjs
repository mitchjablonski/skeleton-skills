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
