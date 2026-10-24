import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import vm from 'node:vm';
import { enhanceVideo } from '../pipeline.mjs';
import { probeVideoDuration } from '../media.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error('Timed out waiting for condition');
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((r) => server.close(r)); return port;
}

// Test-only executable substitutes deterministic media metadata for ffprobe.
async function mockProbe(dir) {
  const file = path.join(dir, 'ffprobe');
  await fs.writeFile(file, `#!${process.execPath}\nconst fs = require('node:fs');\nconst duration = Number(fs.readFileSync(process.argv.at(-1), 'utf8'));\nconsole.log(JSON.stringify({streams: [{codec_type:'video',duration}],format:{duration}}));\n`, { mode: 0o755 });
  return file;
}

test('real HTTP routes: billing, ownership, queue cancellation, enhancement and sessions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipflow-test-'));
  const upstreamTasks = new Map();
  let serial = 0;
  const upstream = http.createServer(async (req, res) => {
    const json = (body) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/asset')) { res.setHeader('Content-Length','2048'); res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(2048)); return; }
    if (req.method === 'POST' && req.url.startsWith('/tools/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const id = `remote_${++serial}`;
      upstreamTasks.set(id, { type: req.url.includes('enhance') ? 'enhance' : 'erase', state: 'processing', input: JSON.parse(raw) });
      return json({ task_id: id });
    }
    if (req.method === 'GET' && req.url.startsWith('/tasks/')) {
      const task = upstreamTasks.get(req.url.slice('/tasks/'.length));
      if (!task) { res.statusCode = 404; return json({}); }
      return json({ status: task.state, result: { video_url: `http://127.0.0.1:${upstream.address().port}/asset/${task.type}`, duration: 3.2 } });
    }
    res.statusCode = 404; json({});
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const seed = { users: {}, sessions: {} };
  for (const id of ['a','b','poor','admin']) {
    seed.users[id] = { id, status:'active', role: id === 'admin' ? 'admin' : 'user', credits: id === 'poor' ? 0 : 100 };
    seed.sessions[id] = { userId:id, createdAt:new Date().toISOString(), expiresAt:Date.now()+30*60*1000 };
  }
  await fs.writeFile(path.join(dir,'db.json'),JSON.stringify(seed));
  const childOptions = { cwd: path.resolve('.'), env: { ...process.env,
    DATA_DIR: dir, HOST:'127.0.0.1', PORT:String(port), AMK_API_KEY:'test-key',
    AMK_API_BASE:`http://127.0.0.1:${upstream.address().port}`, PUBLIC_BASE_URL:base,
    AMK_POLL_MS:'1000', MAX_ACTIVE_TASKS:'1', DISK_MIN_FREE_BYTES:'0', DISK_RESERVE_BYTES:'0',
    FFPROBE_PATH:await mockProbe(dir), KEEP_ARTIFACT:'false', ADMIN_PHONE:'', ADMIN_PASSWORD:'',
  }, stdio:['ignore','pipe','pipe'] };
  let logs = '';
  const launch = () => {
    const child = spawn(process.execPath, ['server.mjs'], childOptions);
    child.stdout.on('data',(b)=>logs+=b); child.stderr.on('data',(b)=>logs+=b);
    return child;
  };
  let child = launch();
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child,'exit'); }
    upstream.closeAllConnections(); await new Promise((r)=>upstream.close(r));
    await fs.rm(dir,{recursive:true,force:true});
  });
  await until(async()=>{try{return (await fetch(base+'/api/auth/session')).ok;}catch{return false;}}).catch((e)=>{throw new Error(e.message+'\n'+logs);});
  async function api(route, { user='a', method='GET', body, raw, headers={} }={}) {
    const response = await fetch(base+route,{method,headers:{Cookie:`clp_sid=${user}`, ...(body ? {'Content-Type':'application/json'} : {}),...headers},body:raw ?? (body ? JSON.stringify(body):undefined),redirect:'manual'});
    const data = await response.json().catch(()=>({}));
    return { status:response.status, data, headers:response.headers };
  }
  const credits = async(user='a') => (await api('/api/me',{user})).data.user.credits;
  const upload = async(value) => {
    const r=await api('/api/uploads',{method:'POST',raw:String(value),headers:{'X-File-Name':'test.mp4'}});
    assert.equal(r.status,200,JSON.stringify(r.data)); return r.data.file.id;
  };
  const batch = async(file, opts={}) => {
    const r=await api('/api/batches',{method:'POST',user:opts.user,body:{fileIds:[file],durations:{[file]:1},...opts}});
    assert.equal(r.status,202,JSON.stringify(r.data));return r.data;
  };
  const start = async(id, user='a')=>api(`/api/tasks/${id}/start`,{method:'POST',user,body:{}});
  const cancel = async(id, user='a')=>api(`/api/tasks/${id}`,{method:'DELETE',user});
  const task = async(id,user='admin')=>(await api(`/api/tasks/${id}`,{user})).data.task;

  await t.test('malformed cookies and path escapes do not terminate the server; session cookie renews',async()=>{
    const bad=await api('/api/me',{headers:{Cookie:'clp_sid=%'}});assert.equal(bad.status,401);
    assert.equal((await api('/api/tasks/%')).status,400);
    const r=await api('/api/auth/session');assert.equal(r.status,200);
    const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers.get('set-cookie'))?.[1]);
    assert.ok(maxAge >= 3540 && maxAge <= 3600);
    assert.ok(Date.parse(r.data.expiresAt)>Date.now()+59*60000);
  });
  const file=await upload(3.2);
  await t.test('legacy process route requires credits and rejects invalid media',async()=>{
    const r=await api(`/api/files/${file}/process`,{user:'poor',method:'POST',body:{durationSec:1}});
    assert.equal(r.status,402);assert.equal(upstreamTasks.size,0);
    const invalid=await upload('not a video');
    assert.equal((await api('/api/batches',{method:'POST',body:{fileIds:[invalid],durations:{[invalid]:1}}})).status,422);
  });
  const a=await batch(file), b=await batch(file,{user:'b'});
  const aId=a.items[0].taskId, bId=b.items[0].taskId;
  await t.test('same bytes are not shared between users or different processing settings',async()=>{
    assert.notEqual(aId,bId);
    const strong=await batch(file,{erasePreset:'fullscreen'});
    const enhanced=await batch(file,{enhance:true});
    assert.notEqual(aId,strong.items[0].taskId);assert.notEqual(aId,enhanced.items[0].taskId);
    assert.equal((await batch(file)).items[0].taskId,aId);
    assert.equal((await cancel(aId,'b')).status,404);
    const encoded = '%74' + aId.slice(1);
    assert.equal((await api(`/api/tasks/${encoded}`,{user:'b'})).status,404);
    assert.equal((await api(`/api/tasks/${encoded}`,{user:'b',method:'DELETE'})).status,404);
  });
  await t.test('server duration determines price; admin-triggered refunds go to the actual payer',async()=>{
    assert.equal((await start(aId,'admin')).status,202);
    assert.equal(await credits('admin'),96);assert.equal(await credits(),100);
    await until(()=>upstreamTasks.size===1);
    assert.equal((await cancel(aId,'admin')).status,200);
    assert.equal(await credits('admin'),100);assert.equal(await credits(),100);
    await sleep(1200);
  });
  await t.test('queued single and batch cancellation refund once and never launch later',async()=>{
    assert.equal((await start(bId,'b')).status,202);
    await until(()=>upstreamTasks.size===2);
    assert.equal((await start(aId)).status,202);assert.equal(await credits(),96);
    assert.equal((await task(aId)).status,'pending');
    await cancel(aId);await cancel(aId);assert.equal(await credits(),100);
    assert.equal((await start(aId)).status,202);
    assert.equal((await api(`/api/batches/${a.batch.id}`,{method:'DELETE',body:{indexes:[0]}})).status,200);
    assert.equal(await credits(),100);
    await cancel(bId,'b');await sleep(1200);
    assert.equal(upstreamTasks.size,2);assert.equal((await task(aId)).status,'canceled');
  });
  await t.test('enhancement remains processing until final result, then caches only matching settings',async()=>{
    const e=await batch(file,{enhance:true});const id=e.items[0].taskId;
    assert.equal((await start(id)).status,202);assert.equal(await credits(),92);
    await until(()=>upstreamTasks.size===3);upstreamTasks.get('remote_3').state='completed';
    await until(()=>upstreamTasks.size===4);
    const mid=await task(id);assert.equal(mid.status,'processing');assert.equal(mid.stageKey,'enhance');assert.equal(mid.result,undefined);
    assert.equal((await api(`/api/download/${id}`)).status,409);
    // Restart while enhancing: preserve the enhancement id and resume instead of submitting it again.
    await sleep(150);
    child.kill('SIGTERM'); await once(child, 'exit');
    child = launch();
    await until(async()=>{try{return (await fetch(base+'/api/auth/session')).ok;}catch{return false;}});
    assert.equal((await task(id)).status, 'processing');
    upstreamTasks.get('remote_4').state='completed';
    await until(async()=>(await task(id)).status==='succeeded');
    assert.equal(upstreamTasks.size,4);
    const result=await api(`/api/download/${id}`);assert.equal(result.status,302);assert.match(result.headers.get('location'),/\/asset\/enhance$/);
    assert.equal((await batch(file,{enhance:true})).items[0].taskId,id);
    assert.notEqual((await batch(file)).items[0].taskId,id);
  });
  await t.test('batch start charges each unique task once and reports insufficient balance', async () => {
    const f = await upload(2.6);
    const poor = await batch(f, { user: 'poor' });
    const rejected = await api(`/api/batches/${poor.batch.id}/start`, { user: 'poor', method: 'POST', body: {} });
    assert.equal(rejected.data.started, 0); assert.equal(rejected.data.insufficient.length, 1);
    const r = await api('/api/batches', { method: 'POST', body: { fileIds: [f, f], durations: { [f]: 0.01 } } });
    assert.equal(r.status, 202); assert.equal(r.data.items[0].taskId, r.data.items[1].taskId);
    const before = await credits();
    const launch = await api(`/api/batches/${r.data.batch.id}/start`, { method: 'POST', body: {} });
    assert.equal(launch.data.started, 1); assert.equal(await credits(), before - 3);
    await api(`/api/batches/${r.data.batch.id}/start`, { method: 'POST', body: {} });
    assert.equal(await credits(), before - 3);
    await api(`/api/batches/${r.data.batch.id}`, { method: 'DELETE', body: {} });
    assert.equal(await credits(), before);
  });
  await t.test('single-file route charges the verified duration and assigns owner',async()=>{
    const r=await api(`/api/files/${file}/process`,{method:'POST',body:{durationSec:0.01}});
    assert.equal(r.status,202);assert.equal(r.data.task.userId,'a');assert.equal(r.data.task.chargedCredits,4);
    await cancel(r.data.task.id);
    assert.equal(await credits(),92);
  });
});

test('enhancement response envelopes resolve to string URLs and numeric duration', async()=>{
  const original=globalThis.fetch, key=process.env.AMK_API_KEY;
  process.env.AMK_API_KEY='unit-test';
  try {
    for(const envelope of [false,true]) {
      globalThis.fetch=async(url,opts)=>{
        if(opts?.method==='HEAD') return new Response(null,{headers:{'content-length':'2048'}});
        const payload={status:'completed',result:{video_url:'https://example.invalid/output.mp4',duration:12}};
        return Response.json(envelope?{data:payload}:payload);
      };
      const r=await enhanceVideo('https://example.invalid/source.mp4',{taskId:'existing',pollMs:1});
      assert.equal(r.url,'https://example.invalid/output.mp4');assert.equal(r.duration,12);
    }
  } finally { globalThis.fetch=original;if(key===undefined)delete process.env.AMK_API_KEY;else process.env.AMK_API_KEY=key; }
});

test('upload abort settles its promise and prevents a canceled upload from being sent',async()=>{
  const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function uploadFile('),source.indexOf('/** 上传都落定后'));
  let sent=0;
  class XHR { upload={};open(){}setRequestHeader(){}send(){sent++;}abort(){this.onabort?.();} }
  const context=vm.createContext({XMLHttpRequest:XHR,render(){}});vm.runInContext(code,context);
  const item={name:'test.mp4',file:{}};const p=context.uploadFile(item,'md5');item.xhr.abort();
  await assert.rejects(p,{name:'AbortError'});
  await assert.rejects(context.uploadFile({...item,canceled:true},'md5'),{name:'AbortError'});assert.equal(sent,1);
});

test('missing probe fails closed instead of accepting a client duration',async()=>{
  const previous=process.env.FFPROBE_PATH;process.env.FFPROBE_PATH='/missing/ffprobe';
  try {await assert.rejects(probeVideoDuration('/tmp/video.mp4'),{status:503});}
  finally {if(previous===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=previous;}
});


test('session refresh updates countdown and handles expiry', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function refreshHeader()');
  const code = source.slice(start, source.indexOf('\nrefreshHeader();', start));
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  let loginShown = false;
  const context = vm.createContext({ state: { session: { authenticated: true } }, sessionEndsAt: 1,
    el: { adminBtn: {}, sessionLeft: {} }, document: { getElementById: () => ({}) },
    fetch: async () => ({ json: async () => ({ authenticated: true, expiresAt, user: { credits: 5 } }) }),
    fmtCountdown: String, syncEnhance() {}, showLogin() { loginShown = true; } });
  vm.runInContext(code, context);
  await context.refreshHeader();
  assert.equal(context.sessionEndsAt, Date.parse(expiresAt));
  context.fetch = async () => ({ json: async () => ({ authenticated: false }) });
  await context.refreshHeader();
  assert.equal(context.sessionEndsAt, null); assert.equal(loginShown, true);
});
