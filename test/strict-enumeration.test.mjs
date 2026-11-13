import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { enumerateStrictManifest, STRICT_ENUMERATION_POLICY } from "../lib/strict-enumeration.mjs";
import { captureStrictManifest, StrictCaptureError } from "../lib/strict-capture.mjs";
import { createCaptureStore, openCaptureStore } from "../lib/strict-capture-store.mjs";
const linuxTest=(name,fn)=>test(name,{skip:process.platform!=="linux"},fn);
function candidateSource() {
 const source=fs.readFileSync(new URL("../lib/strict-enumeration.mjs",import.meta.url),"utf8");
 return source.slice(source.indexOf("function markerCandidate(text) {"),source.indexOf("\nfunction limits("));
}
test("linear candidate scan preserves conservative multiline Unicode and comment semantics",()=>{
 const candidate=vm.runInNewContext(candidateSource()+"\nmarkerCandidate");
 const legacy=/^\s*(?:\/\/|#|--|;|\/\*|<!--|\{\/\*)\s*\/?SKEL\[/m;
 const chunks=["", "text", " ", "\t", "\n", "\r\n", "\u2028", "\u2029", "\uFEFF", "\v", "//", "#", "--", ";", "/*", "<!--", "{/*", "SKEL[", "/SKEL[", "skel[", "x\n// SKEL["];
 for(const a of chunks) for(const b of chunks) for(const c of chunks) {
  const text=a+b+c;
  assert.equal(candidate(text),legacy.test(text),JSON.stringify(text));
 }
});
test("newline and whitespace candidate scans finish in a bounded child",()=>{
 execFileSync(process.execPath,["--input-type=module","-e",`
  import assert from 'node:assert/strict';
  import vm from 'node:vm';
  const candidate=vm.runInNewContext(${JSON.stringify(candidateSource())}+'\\nmarkerCandidate');
  assert.equal(candidate('\\n'.repeat(1024*1024)),false);
  assert.equal(candidate(' \\n'.repeat(500000)+'x'),false);
  assert.equal(candidate('//'+ ' \\n'.repeat(500000)+'SKEL['),true);
  assert.equal(candidate(('// \\n').repeat(200000)+'x'),false);
 `],{timeout:15000,stdio:"pipe"});
});
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),"skel-enumeration-")),root=path.join(base,"work");fs.mkdirSync(root);
 const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 t.after(()=>{fs.closeSync(fd);fs.rmSync(base,{recursive:true,force:true});});
 const write=(name,text="text")=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
 return {base,root,fd,write,enumerate:limits=>enumerateStrictManifest(fd,STRICT_ENUMERATION_POLICY,limits)};
}
linuxTest("newline-heavy text stays whole and a cross-line marker candidate still refuses",t=>{
 const f=fixture(t);
 f.write("blank.txt"," \n".repeat(32000)+"ordinary text");
 assert.deepEqual(f.enumerate().manifest,[{path:"blank.txt",mode:"whole"}]);
 f.write("blank.txt","//\n\uFEFF /SKEL[1]");
 assert.throws(()=>f.enumerate(),error=>error.code==="ENUM_MARKERS");
});
linuxTest("only a typed malformed-marker cause becomes an editable enumeration refusal",t=>{
 const f=fixture(t);
 for(const text of ["// SKEL[1] unclosed", "// /SKEL[1]\n", "// SKEL[1] a\n// /SKEL[2]\n"]) {
  f.write("file",text);
  assert.throws(()=>f.enumerate(),error=>error.code==="ENUM_MARKERS");
 }
 f.write("file","// SKEL[1] valid\ninitial\n// /SKEL[1]\n");
 assert.deepEqual(f.enumerate().manifest,[{path:"file",mode:"fenced"}]);
 for(const failure of [
  Object.assign(new Error("I/O"),{code:"EIO"}),
  Object.assign(new Error("denied"),{code:"EACCES"}),
  Object.assign(new Error("missing"),{code:"ENOENT"}),
  new StrictCaptureError("CAPTURE_CHANGED"),
  new StrictCaptureError("CAPTURE_MISSING"),
  new StrictCaptureError("CAPTURE_IO"),
  Object.assign(new Error("spoof marker"),{code:"CAPTURE_MARKERS"}),
  new Error("runtime"),
 ]) {
  const original=fs.readSync;let injected=false;
  fs.readSync=function(fd,...args){
   if(fs.readlinkSync(`/proc/self/fd/${fd}`)===path.join(f.root,"file")){injected=true;throw failure;}
   return original(fd,...args);
  };
  try {assert.throws(()=>f.enumerate(),error=>error.code==="ENUM_UNAVAILABLE");}
  finally {fs.readSync=original;}
  assert.equal(injected,true);
 }
});
linuxTest("a valid whole read changing to malformed fenced text remains observed drift",t=>{
 const f=fixture(t),valid="// SKEL[1] valid\ninitial\n// /SKEL[1]\n";
 const file=f.write("file",valid), before=fs.statSync(file);
 const original=fs.openSync;let opens=0,changed=false;
 fs.openSync=function(name,...args){
  if(String(name).startsWith("/proc/self/fd/") && String(name).endsWith("/file") && ++opens===2) {
   fs.writeFileSync(file,valid.replace("// /SKEL[1]","// /SKEL[2]"));
   const future=new Date(before.mtimeMs+60000);fs.utimesSync(file,future,future);changed=true;
  }
  return original(name,...args);
 };
 try {assert.throws(()=>f.enumerate(),error=>error.code==="ENUM_CHANGED");}
 finally {fs.openSync=original;}
 assert.equal(changed,true);assert.equal(opens,2);
});
linuxTest("fixed all-text coverage ignores project policy and reports exact directory exclusions",t=>{
 const {write,enumerate,fd,base}=fixture(t);
 write("z.unknown","all text");write("src/hidden.js","// SKEL[1] value\nreturn 1;\n// /SKEL[1]\n");
 write(".gitignore","*\n");write(".claude/settings.json","{}");write(".git/config","ignored");write("node_modules/pkg/a","ignored");write(".skeleton/state.json","ignored");write("Build/kept","text");
 const result=enumerate();assert.deepEqual(result.manifest.map(v=>v.path),[".claude/settings.json",".gitignore","Build/kept","src/hidden.js","z.unknown"]);
 assert.equal(result.manifest.find(v=>v.path==="src/hidden.js").mode,"fenced");
 assert.deepEqual(result.exclusions.map(v=>v.path),[".git",".skeleton","node_modules"]);assert.match(result.policyIdentity,/^[a-f0-9]{64}$/);
 write(".gitignore","different ignores\n");assert.deepEqual(enumerate().manifest,result.manifest);
 const capture=captureStrictManifest(fd,result.manifest),dir=path.join(base,"captures");createCaptureStore(dir).put(capture);assert.deepEqual(openCaptureStore(dir).get(capture.captureVersion),capture);
 assert.ok(Object.isFrozen(result.manifest[0])&&Object.isFrozen(result.coverage));
});
linuxTest("visit, directory, depth, handle, name, byte and operation exhaustion never returns partial success",t=>{
 const {write,enumerate}=fixture(t);write("a/file","abc");write("b/file","abc");
 for(const cap of [{maxVisits:1},{maxDirectories:1},{maxDepth:1,maxOpenHandles:2},{maxOpenHandles:1},{maxFiles:1},{maxNameBytes:1},{maxPathBytes:2},{maxTotalNameBytes:2},{maxFileBytes:1},{maxTotalBytes:1},{maxOperations:1}])assert.throws(()=>enumerate(cap));
 assert.throws(()=>enumerate({unknown:1}));assert.throws(()=>enumerate({maxFiles:257}));
});
linuxTest("malformed marker text, binary text, invalid raw UTF8 names and unsupported types refuse",t=>{
 for(const [name,setup] of [
  ["bad-marker",f=>f.write("file","// SKEL[1] unclosed")],
  ["binary",f=>f.write("file",Buffer.from([0xff]))],
  ["nul",f=>f.write("file","a\0b")],
  ["raw-name",f=>fs.writeFileSync(Buffer.concat([Buffer.from(f.root+"/"),Buffer.from([0xff])]),"x")],
  ["control-name",f=>f.write("a\nb","text")],
  ["format-name",f=>f.write("a\u202eb","text")],
  ["symlink-excluded",f=>fs.symlinkSync(f.base,path.join(f.root,"node_modules"),"dir")],
  ["hardlink",f=>fs.linkSync(f.write("file"),path.join(f.root,"alias"))],
  ["fifo",f=>execFileSync("mkfifo",[path.join(f.root,"fifo")])],
 ]) {const f=fixture(t);setup(f);assert.throws(()=>f.enumerate(),undefined,name);}
});
linuxTest("root pathname replacement stays pinned and does not read outside sentinel",t=>{
 const {base,root,write,enumerate}=fixture(t);write("file","pinned");
 const outside=path.join(base,"outside");fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,"secret"),"outside");
 fs.renameSync(root,path.join(base,"held"));fs.symlinkSync(outside,root,"dir");
 assert.deepEqual(enumerate().manifest,[{path:"file",mode:"whole"}]);
});
linuxTest("intermediate replacement during opening refuses without reading the outside sentinel",t=>{
 const f=fixture(t);f.write("inner/file","pinned");const outside=path.join(f.base,"outside");fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,"secret"),"outside");
 const original=fs.openSync;let swapped=false;
 fs.openSync=function(name,...args){const fd=original(name,...args);if(!swapped&&/\/inner$/.test(String(name))){swapped=true;fs.renameSync(path.join(f.root,"inner"),path.join(f.base,"held"));fs.symlinkSync(outside,path.join(f.root,"inner"),"dir");}return fd;};
 try{assert.throws(()=>f.enumerate());}finally{fs.openSync=original;}assert.equal(swapped,true);
});
linuxTest("observed directory mutation, missing entry and fake cross-device metadata refuse",t=>{
 for(const mutation of ["add","remove","device","no-buffer"]){const f=fixture(t);f.write("file","text");const original=fs.opendirSync;let mutated=false;
 fs.opendirSync=function(...args){const stream=original(...args);return {readSync(){const ent=stream.readSync();if(ent&&!mutated){mutated=true;if(mutation==="add"){f.write("late");const future=new Date(Date.now()+60000);fs.utimesSync(f.root,future,future);}if(mutation==="remove")fs.unlinkSync(path.join(f.root,"file"));if(mutation==="no-buffer")return {name:"file"};}return ent;},closeSync(){stream.closeSync();}};};
 const lstat=fs.lstatSync;if(mutation==="device")fs.lstatSync=function(...args){const value=lstat(...args);return Object.assign(Object.create(Object.getPrototypeOf(value)),value,{dev:value.dev+1n});};
 try{assert.throws(()=>f.enumerate(),undefined,mutation);}finally{fs.opendirSync=original;fs.lstatSync=lstat;}assert.equal(mutated,true);
 }
});
linuxTest("empty enumeration is explicit; a later capture pass can refuse a missing member",t=>{
 const f=fixture(t);assert.deepEqual(f.enumerate().manifest,[]);f.write("file");const manifest=f.enumerate().manifest;fs.unlinkSync(path.join(f.root,"file"));assert.throws(()=>captureStrictManifest(f.fd,manifest));
});
test("non-Linux refuses before inspecting policy, descriptors or options",{skip:process.platform==="linux"},()=>{
 let touched=false;const hostile=new Proxy({}, {get(){touched=true;throw Error();}});assert.throws(()=>enumerateStrictManifest(hostile,hostile,hostile),e=>e.code==="ENUM_UNSUPPORTED");assert.equal(touched,false);
});
