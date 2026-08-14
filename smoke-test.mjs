// Smoke test: run dsh-vision apply() with a mocked ctx and exercise the
// /dsh-vision/clip route end to end (save + path + cleanup).
import { apply } from './lib/index.js';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures += 1;
};

const routes = new Map(); // path -> handler
const sections = [];
const tools = [];
let settingsScope;
let settingsRegistered = false;

const fakeSettings = {
  register(ns, schema, opts) {
    settingsRegistered = true;
    settingsScope = {
      get: () => settingsScope.stored,
      update: async (patch) => { Object.assign(settingsScope.stored, patch); },
      stored: {},
    };
    return settingsScope;
  },
};
const fakeWebServer = {
  register({ kind, path, handler }) {
    routes.set(path, handler);
    return () => routes.delete(path);
  },
};

const fakeCtx = {
  get(name) {
    if (name === 'settings') return fakeSettings;
    if (name === 'webServer') return fakeWebServer;
    if (name === 'sandboxPolicy') return { workspaceRoot: 'C:/mock-workspace' };
    return undefined;
  },
  inject(list, cb) {
    const injected = { ...fakeCtx };
    for (const name of list) injected[name] = fakeCtx.get(name);
    cb(injected);
  },
  effect(fn) { fn(); },
  tools: { register(def) { tools.push(def); } },
  systemPrompt: { section(s) { sections.push(s); } },
};

function fakeReq(method, body) {
  const stream = async function* () { yield Buffer.from(JSON.stringify(body)); };
  return { method, [Symbol.asyncIterator]: stream };
}
function fakeRes() {
  const out = { code: 0, payload: null };
  return {
    out,
    writeHead(code, headers) { out.code = code; out.headers = headers; },
    end(text) { out.payload = text; },
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-vision-test-'));
try {
  apply(fakeCtx, {});

  check('settings registered', settingsRegistered);
  check('view_image tool registered', tools.some((t) => t.name === 'view_image'));
  check('prompt section registered', sections.some((s) => s.name === 'tool:dsh-vision' && /\[图片:/.test(s.text)), 'prompt mentions marker');
  check('config route registered', routes.has('/dsh-vision/config'));
  check('clip route registered', routes.has('/dsh-vision/clip'));

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const clip = routes.get('/dsh-vision/clip');

  const ok = fakeRes();
  await clip(fakeReq('POST', { data: `data:image/png;base64,${png}`, name: 'shot.png' }), ok);
  check('clip POST returns 200', ok.out.code === 200, `code=${ok.out.code}`);
  let savedPath = null;
  if (ok.out.code === 200) {
    savedPath = JSON.parse(ok.out.payload).path;
    check('clip returns absolute path', typeof savedPath === 'string' && savedPath.includes(':'), savedPath ?? '');
    check('file exists on disk', savedPath !== null && existsSync(savedPath));
    check('file is real png', savedPath !== null && readFileSync(savedPath).subarray(0, 4).toString('hex') === '89504e47');
    check('saved under workspace/.dsh/tmp', savedPath !== null && savedPath.replaceAll('/', '\\').startsWith('C:\\mock-workspace\\.dsh\\tmp'), savedPath ?? '');
    check('clip- prefix', savedPath !== null && /clip-\d+-[a-z0-9]+\.png$/.test(savedPath), savedPath ?? '');
  }

  const bad1 = fakeRes(); await clip(fakeReq('POST', { data: 'not-a-data-url' }), bad1);
  check('rejects non-data URL', bad1.out.code === 400, `code=${bad1.out.code} body=${bad1.out.payload}`);
  const bad2 = fakeRes(); await clip(fakeReq('POST', 'not json'), bad2);
  check('rejects invalid JSON', bad2.out.code === 400, `code=${bad2.out.code}`);
  const bad3 = fakeRes(); await clip(fakeReq('GET', {}), bad3);
  check('rejects GET', bad3.out.code === 405, `code=${bad3.out.code}`);

  // Count-based cache limit: with clipLimit=2, two more saves must leave 2 files.
  const clipDir = join('C:', 'mock-workspace', '.dsh', 'tmp');
  settingsScope.stored.clipLimit = 2;
  for (let i = 0; i < 2; i += 1) {
    const r = fakeRes();
    await clip(fakeReq('POST', { data: `data:image/png;base64,${png}`, name: `more-${i}.png` }), r);
    check(`extra save ${i + 1} ok`, r.out.code === 200, `code=${r.out.code}`);
    await sleep(15); // distinct mtimes so "oldest" is deterministic
  }
  const remaining = readdirSync(clipDir).filter((name) => name.startsWith('clip-'));
  check('clip cache respects limit (<= 2 files)', remaining.length === 2, `count=${remaining.length}: ${remaining.join(', ')}`);

  const cfg = fakeRes(); await routes.get('/dsh-vision/config')(fakeReq('GET', {}), cfg);
  const cfgBody = JSON.parse(cfg.out.payload);
  check('config GET ok + redacted', cfg.out.code === 200 && !('apiKey' in cfgBody.value) && 'hasApiKey' in cfgBody);
  check('config GET carries clipLimit', cfgBody.value.clipLimit === 2, `clipLimit=${cfgBody.value.clipLimit}`);

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
