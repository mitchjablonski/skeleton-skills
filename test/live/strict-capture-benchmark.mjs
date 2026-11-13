#!/usr/bin/env node
// Development-only microbenchmark for existing strict capture and storage
// primitives. No authority activation, external service, model or network.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const WARMUP = 5;
const SAMPLES = 20;
const DATASETS = [1, 32];
const DEFAULT_REPO = process.cwd();
const DEFAULT_MOUNT_PARENT = null;

function args(argv) {
  const out = { repo: DEFAULT_REPO, mountParent: DEFAULT_MOUNT_PARENT };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!["--repo", "--mount-parent", "--local-parent", "--help"].includes(name)) throw Error("unknown argument");
    if (name === "--help") return { help: true };
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw Error(`missing value for ${name}`);
    out[name === "--repo" ? "repo" : name === "--local-parent" ? "localParent" : "mountParent"] = argv[++i];
  }
  for (const value of Object.values(out)) if (value && !path.isAbsolute(value)) throw Error("paths must be absolute");
  return out;
}

const round = value => Number(value.toFixed(4));
function percentile(sorted, p) { return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; }
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    medianMs: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95Ms: round(percentile(sorted, 0.95)),
    minMs: round(sorted[0]),
    maxMs: round(sorted.at(-1)),
  };
}
function summarizeRss(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    startBytes: values[0],
    medianObservedBytes: percentile(sorted, 0.5),
    p95ObservedBytes: percentile(sorted, 0.95),
    peakObservedBytes: sorted.at(-1),
    note: "process RSS baseline plus after-sample observations, not per-operation allocation",
  };
}
function benchmark(fn) {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const times = [];
  const rss = [process.memoryUsage.rss()];
  for (let i = 0; i < SAMPLES; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
    rss.push(process.memoryUsage.rss());
  }
  return { ...summarize(times), rss: summarizeRss(rss) };
}
function fixtureText(token) {
  const lines = ["// SKEL[1] benchmark", `export const revision = "${token}";`];
  for (let index = 0; index < 54; index += 1) lines.push(`export const padding${index} = "${"x".repeat(44)}";`);
  lines.push("// /SKEL[1]");
  return `${lines.join("\n")}\n`;
}
function ownedTemp(parent, label) {
  const realParent = fs.realpathSync(parent);
  if (!fs.statSync(realParent).isDirectory()) throw Error("fixture parent is not a directory");
  const root = fs.mkdtempSync(path.join(realParent, `.strict-perf-${label}-`));
  const marker = randomUUID();
  try { fs.writeFileSync(path.join(root, ".strict-perf-owner"), marker, { flag: "wx", mode: 0o600 }); }
  catch (error) { fs.rmdirSync(root); throw error; }
  return { root, realParent, marker };
}
function cleanupOwned(temp) {
  const root = fs.realpathSync(temp.root);
  if (!root.startsWith(`${temp.realParent}${path.sep}`)
    || !path.basename(root).startsWith(".strict-perf-")
    || fs.readFileSync(path.join(root, ".strict-perf-owner"), "utf8") !== temp.marker) {
    throw Error("refusing to clean unexpected benchmark path");
  }
  fs.rmSync(root, { recursive: true, force: false });
  return !fs.existsSync(root);
}
function openDirectory(directory) {
  return fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
}
function addFailure(results, dataset, operation, error) {
  results.push({ datasetFiles: dataset, operation, status: "unsupported", reason: String(error?.code ?? error?.message ?? error).slice(0, 240) });
}

function runCaptureDataset(root, count, captureStrictManifest, validateStoredCapture, createCaptureStore) {
  const output = [];
  const work = path.join(root, `workspace-${count}`);
  fs.mkdirSync(work, { mode: 0o700 });
  const manifest = [];
  const contents = [];
  for (let index = 0; index < count; index += 1) {
    const rel = `file-${String(index).padStart(2, "0")}.js`;
    const text = fixtureText("00000000");
    fs.writeFileSync(path.join(work, rel), text);
    contents.push(text);
    manifest.push({ path: rel, mode: "fenced" });
  }
  const fd = openDirectory(work);
  const writeCapture = token => {
    fs.writeFileSync(path.join(work, manifest[0].path), fixtureText(token));
    return captureStrictManifest(fd, manifest);
  };
  const bytesPerFile = Buffer.byteLength(contents[0], "utf8");
  const bytesTotal = bytesPerFile * count;
  let baseline;
  try {
    baseline = captureStrictManifest(fd, manifest);
    output.push({
      datasetFiles: count,
      operation: "pure-capture",
      status: "ok",
      fixtureBytesPerFile: bytesPerFile,
      fixtureBytesTotal: bytesTotal,
      ...benchmark(() => { baseline = captureStrictManifest(fd, manifest); }),
    });
    output.push({
      datasetFiles: count,
      operation: "canonical-validation",
      status: "ok",
      captureJsonBytes: Buffer.byteLength(JSON.stringify(baseline), "utf8"),
      ...benchmark(() => { validateStoredCapture(baseline); }),
    });
  } catch (error) {
    addFailure(output, count, "pure-capture/canonical-validation", error);
    addFailure(output, count, "capture-store-put", error);
    addFailure(output, count, "capture-store-get", error);
    fs.closeSync(fd);
    return output;
  }

  try {
    const variants = [];
    for (let index = 0; index < WARMUP + SAMPLES; index += 1) variants.push(writeCapture(index.toString(16).padStart(8, "0")));
    const storePath = path.join(root, `capture-store-${count}`);
    const store = createCaptureStore(storePath);
    let putIndex = 0;
    output.push({
      datasetFiles: count,
      operation: "capture-store-put",
      status: "ok",
      captureJsonBytes: Buffer.byteLength(JSON.stringify(variants.at(-1)), "utf8"),
      ...benchmark(() => {
        const stored = store.put(variants[putIndex++]);
        if (stored.captureVersion !== variants[putIndex - 1].captureVersion) throw Error("capture store put mismatch");
      }),
    });
    let getIndex = 0;
    output.push({
      datasetFiles: count,
      operation: "capture-store-get",
      status: "ok",
      captureJsonBytes: Buffer.byteLength(JSON.stringify(variants.at(-1)), "utf8"),
      ...benchmark(() => {
        const capture = variants[getIndex++];
        if (store.get(capture.captureVersion).captureVersion !== capture.captureVersion) throw Error("capture store get mismatch");
      }),
    });
  } catch (error) {
    addFailure(output, count, "capture-store-put/get", error);
  } finally {
    fs.closeSync(fd);
  }
  return output;
}

function runAuthority(root, createAuthorityStore) {
  const output = [];
  const shape = "a".repeat(64);
  const captureVersion = "b".repeat(64);
  const setupRoot = path.join(root, "authority-samples");
  fs.mkdirSync(setupRoot, { mode: 0o700 });
  const stores = [];
  try {
    for (let index = 0; index < WARMUP + SAMPLES; index += 1) {
      const parent = path.join(setupRoot, `sample-${String(index).padStart(2, "0")}`);
      fs.mkdirSync(parent, { mode: 0o700 });
      const directory = path.join(parent, "store");
      const initial = {
        protocolVersion: 2,
        projectId: "bench-project",
        sessionId: "bench-session",
        reviewRoundId: "round1",
        phase: "skeleton",
        reviewVersion: shape,
        captureVersion,
        approvedVersion: null,
        approvedCaptureVersion: null,
        revision: 0,
      };
      const store = createAuthorityStore(directory, initial);
      const intent = {
        protocolVersion: 2,
        requestId: `bench-${String(index).padStart(2, "0")}`,
        action: "approve",
        projectId: "bench-project",
        sessionId: "bench-session",
        reviewRoundId: "round1",
        reviewVersion: shape,
        captureVersion,
        expectedRevision: 0,
      };
      const facts = { contentVersion: shape, captureVersion, nextReviewRoundId: null, completionVerified: false };
      stores.push({ store, intent, facts, directory });
    }
    let index = 0;
    const timing = benchmark(() => {
      const sample = stores[index++];
      const result = sample.store.submit(sample.intent, sample.facts);
      if (result.kind !== "committed") throw Error(`authority submit ${result.code ?? "failed"}`);
    });
    const recordBytes = fs.statSync(path.join(stores.at(-1).directory, "authority.json")).size;
    output.push({ operation: "authority-store-submit-v2", status: "ok", sampleRecordBytes: recordBytes, ...timing });
  } catch (error) {
    output.push({ operation: "authority-store-submit-v2", status: "unsupported", reason: String(error?.code ?? error?.message ?? error).slice(0, 240) });
  }
  return output;
}

async function main() {
  let options;
  try { options = args(process.argv.slice(2)); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "invalid-arguments", strictState: "unverified", reason: error.message })}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write("Usage: node test/live/strict-capture-benchmark.mjs [--repo ABS_PATH] [--local-parent ABS_PATH] [--mount-parent ABS_PATH]\n");
    return;
  }
  if (process.platform !== "linux") {
    process.stdout.write(`${JSON.stringify({ status: "unsupported", strictState: "unverified", reason: "Linux-only primitives" })}\n`);
    process.exitCode = 2;
    return;
  }
  let modules;
  try {
    const repo = fs.realpathSync(options.repo);
    modules = {
      ...(await import(pathToFileURL(path.join(repo, "lib/strict-capture.mjs")).href)),
      ...(await import(pathToFileURL(path.join(repo, "lib/strict-capture-store.mjs")).href)),
      ...(await import(pathToFileURL(path.join(repo, "lib/strict-authority-store.mjs")).href)),
    };
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "unsupported", strictState: "unverified", reason: `cannot import modules: ${String(error.message).slice(0, 200)}` })}\n`);
    process.exitCode = 2;
    return;
  }

  const result = {
    benchmark: "strict capture/storage prototype microbenchmark",
    claim: "performance observations only; strict mode remains unverified and inactive",
    strictState: "unverified",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    warmupIterations: WARMUP,
    measuredIterations: SAMPLES,
    p95Method: "nearest-rank",
    memoryMetric: "process RSS snapshots; not allocations",
    roots: [],
  };

  const roots = [
    { name: "linux-tmp", parent: options.localParent ?? "/tmp" },
    ...(options.mountParent ? [{ name: "mounted-workspace", parent: options.mountParent }] : []),
  ];
  for (const entry of roots) {
    const rootResult = { name: entry.name, operations: [] };
    let temp;
    try {
      temp = ownedTemp(entry.parent, entry.name);
      rootResult.status = "running";
      for (const count of DATASETS) {
        rootResult.operations.push(...runCaptureDataset(temp.root, count, modules.captureStrictManifest, modules.validateStoredCapture, modules.createCaptureStore));
      }
      rootResult.operations.push(...runAuthority(temp.root, modules.createAuthorityStore));
      rootResult.status = rootResult.operations.some(operation => operation.status === "ok") ? "measured" : "unsupported";
    } catch (error) {
      rootResult.status = "unsupported";
      rootResult.reason = String(error?.code ?? error?.message ?? error).slice(0, 240);
    } finally {
      if (temp) {
        try { rootResult.cleanupVerified = cleanupOwned(temp); }
        catch (error) {
          rootResult.cleanupVerified = false;
          rootResult.cleanupReason = String(error?.code ?? error?.message ?? error).slice(0, 200);
        }
      } else rootResult.cleanupVerified = true;
    }
    result.roots.push(rootResult);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ status: "failed", reason: String(error?.code ?? error?.message ?? error).slice(0, 240), strictState: "unverified" })}\n`);
  process.exitCode = 1;
});

