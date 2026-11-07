import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const client = fs.readFileSync(new URL("../lib/review-client.js", import.meta.url), "utf8");
const fragment = client.slice(client.indexOf("  const tryFragment ="), client.indexOf("  /** A refused token"));
const poll = client.slice(client.indexOf("    const poll = async"), client.indexOf("    const startPolling"));

test("#51: fragment server errors preserve the link and stored token for retry", async () => {
  for (const status of [500, 503, 401, 200]) {
    const events = [];
    const run = new Function("fetch", "events", `
      const location = {hash:'#t=new', pathname:'/',search:''};
      const skelTokenFromHash = () => 'new';
      const history = {replaceState:()=>events.push('clear')};
      const keepToken = t => events.push(t);
      const channel = {postMessage:t=>events.push('broadcast')};
      ${fragment}
      return tryFragment();`);
    const result = await run(async () => ({status, ok:status===200}), events);
    assert.equal(result, status===200 ? "ok" : status===401 ? "refused" : "unreachable");
    assert.deepEqual(events, status===200 ? ['clear','new','broadcast'] : status===401 ? ['clear'] : []);
  }
});

test("#51: delayed poll refusal ignores a replaced token and keeps polling", async () => {
  for (const changeToken of [false, true]) {
    let resolve;
    const response = new Promise(r => resolve = r);
    const events = [];
    const harness = new Function("fetch", "events", `
      let token = 'old', polling = true;
      const auth = () => ({'x-skeleton-token':token});
      const tryPendingToken = () => false;
      const lockOut = () => events.push('locked');
      const setTimeout = () => events.push('scheduled');
      ${poll}
      return {poll, change:()=>token='new', polling:()=>polling};`)(async (_url, options) => {
        assert.equal(options.headers['x-skeleton-token'], 'old');
        return response;
      }, events);
    const pending = harness.poll();
    if (changeToken) harness.change();
    resolve({status:401});
    await pending;
    assert.deepEqual(events, changeToken ? ['scheduled'] : ['locked']);
    assert.equal(harness.polling(), changeToken);
  }
});
