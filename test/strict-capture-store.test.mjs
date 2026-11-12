import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { captureStrictManifest } from '../lib/strict-capture.mjs';
import { createCaptureStore, openCaptureStore } from '../lib/strict-capture-store.mjs';
const linuxTest=(name,fn)=>test(name,{skip:process.platform!=='linux'},fn);
function fixture(t) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'skel-capture-store-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'work');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'file'),'// SKEL[1] body\nreturn 1;\n// /SKEL[1]\n');
 const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);t.after(()=>fs.closeSync(fd));
 const capture=captureStrictManifest(fd,[{path:'file',mode:'fenced'}]);
 const dir=path.join(base,'captures');return {base,dir,capture,file:()=>path.join(dir,capture.captureVersion+'.json')};
}
linuxTest('immutable capture put/get survives reopen and idempotent put preserves inode',t=>{
 const {dir,capture,file}=fixture(t);const store=createCaptureStore(dir);assert.deepEqual(store.put(capture),capture);
 const inode=fs.statSync(file()).ino;assert.deepEqual(openCaptureStore(dir).get(capture.captureVersion),capture);
 assert.deepEqual(store.put(JSON.parse(JSON.stringify(capture))),capture);assert.equal(fs.statSync(file()).ino,inode);
 assert.equal(fs.statSync(file()).nlink,1);assert.deepEqual(fs.readdirSync(dir),[capture.captureVersion+'.json']);
 assert.throws(()=>createCaptureStore(dir));for(const id of ['../escape','A'.repeat(64),'short','0'.repeat(64)])assert.throws(()=>store.get(id));
});
linuxTest('existing corrupt captures are never overwritten or repaired; tampered put refuses',t=>{
 const {dir,capture,file}=fixture(t);const store=createCaptureStore(dir);store.put(capture);
 const corrupt=JSON.parse(JSON.stringify(capture));corrupt.files[0].display[0].text='forged';assert.throws(()=>store.put(corrupt));
 fs.writeFileSync(file(),JSON.stringify(corrupt));const before=fs.readFileSync(file());
 assert.throws(()=>store.get(capture.captureVersion));assert.throws(()=>store.put(capture));assert.deepEqual(fs.readFileSync(file()),before);
});
linuxTest('unsafe modes, symlink ancestors/blobs and hardlinked publication leftovers refuse',t=>{
 const {base,dir,capture,file}=fixture(t);const store=createCaptureStore(dir);store.put(capture);
 for(const name of [base,dir,file()]) {const mode=fs.statSync(name).mode&0o777;fs.chmodSync(name,mode|0o020);assert.throws(()=>store.get(capture.captureVersion));fs.chmodSync(name,mode);}
 const alias=path.join(dir,'.capture-crashed.tmp');fs.linkSync(file(),alias);assert.throws(()=>store.get(capture.captureVersion));assert.throws(()=>store.put(capture));fs.unlinkSync(alias);assert.deepEqual(store.get(capture.captureVersion),capture);
 const moved=dir+'-moved';fs.renameSync(dir,moved);fs.symlinkSync(moved,dir);assert.throws(()=>openCaptureStore(dir));fs.unlinkSync(dir);fs.renameSync(moved,dir);
 fs.unlinkSync(file());fs.symlinkSync(path.join(base,'missing'),file());assert.throws(()=>store.put(capture));assert.ok(fs.lstatSync(file()).isSymbolicLink());
});
linuxTest('before publication faults leave no blob; after publication faults require durable retry',t=>{
 const {dir,capture,file}=fixture(t);createCaptureStore(dir);
 const before=openCaptureStore(dir,{fsyncSync(fd){if(fs.readlinkSync('/proc/self/fd/'+fd).endsWith('.tmp'))throw Error('file fsync');fs.fsyncSync(fd);}});
 assert.throws(()=>before.put(capture));assert.equal(fs.existsSync(file()),false);assert.deepEqual(fs.readdirSync(dir),[]);
 const after=openCaptureStore(dir,{linkSync(from,to){fs.linkSync(from,to);throw Error('unknown after link');}});
 assert.throws(()=>after.put(capture));assert.equal(fs.existsSync(file()),true);assert.equal(fs.statSync(file()).nlink,1);
 const noAck=openCaptureStore(dir,{fsyncSync(){throw Error('no durability');}});assert.throws(()=>noAck.get(capture.captureVersion));assert.throws(()=>noAck.put(capture));
 assert.deepEqual(openCaptureStore(dir).put(capture),capture);
});
linuxTest('cooperating processes race publication without replacement; retries read one canonical blob',async t=>{
 const {base,dir,capture,file}=fixture(t);createCaptureStore(dir);
 const worker=path.join(base,'worker.mjs');fs.writeFileSync(worker,`import {openCaptureStore} from ${JSON.stringify(new URL('../lib/strict-capture-store.mjs',import.meta.url).href)};process.on('message',v=>{try{openCaptureStore(v.dir).put(v.capture);process.send('ok');}catch{process.send('retry');}setImmediate(()=>process.disconnect());});`);
 const run=()=>new Promise((resolve,reject)=>{const child=fork(worker,[],{stdio:['ignore','ignore','inherit','ipc']});child.once('error',reject);let result;child.on('message',v=>{result=v;});child.once('exit',code=>code===0?resolve(result):reject(Error('worker failed')));child.send({dir,capture});});
 const results=await Promise.all([run(),run()]);assert.ok(results.some(v=>v==='ok'));
 assert.equal(fs.statSync(file()).nlink,1);assert.deepEqual(openCaptureStore(dir).put(capture),capture);assert.deepEqual(fs.readdirSync(dir),[capture.captureVersion+'.json']);
});
test('unsupported capture stores refuse before inspecting paths',{skip:process.platform==='linux'},()=>{
 let touched=false;const hostile={toString(){touched=true;throw Error();}};assert.throws(()=>createCaptureStore(hostile));assert.throws(()=>openCaptureStore(hostile));assert.equal(touched,false);
});
