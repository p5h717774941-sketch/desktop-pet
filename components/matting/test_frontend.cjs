const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(handler) {
  const calls = [], canvases = [];
  const context = vm.createContext({
    invoke: async (name, args) => { calls.push([name, args]); return handler(name, args); },
    console, DOMException, Date, setTimeout, AbortController,
    document: { createElement: () => {
      const canvas = { getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,cG5n' };
      canvases.push(canvas); return canvas;
    } },
    Image: class { constructor() { this.width = 1920; this.height = 1280; } async decode() {} },
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/local-matting.js'), 'utf8')
    .replace(/^import .*;$/m, '').replaceAll('export ', '');
  vm.runInContext(source, context);
  return { calls, canvases, run: vm.runInContext('buildLocalMatting', context) };
}

test('24 original-aspect frames, exact sampling, sheet and cleanup', async () => {
  const h = harness(name => name === 'ai_job_begin' ? 'job1' : name === 'ai_job_poll' ? { stage: 'done', sheet: 'cG5n' } : null);
  const times = [];
  const result = await h.run({ videoWidth: 1280, videoHeight: 720, duration: 4 }, async (_, t) => times.push(t), false);
  assert.equal(times.length, 24);
  assert.equal(times[0], 4 / 25);
  assert.equal(times[23], 4 * 24 / 25);
  assert.equal(h.canvases[0].width, 1280);
  assert.equal(h.canvases[0].height, 720);
  assert.equal(h.calls.filter(([name]) => name === 'ai_job_frame').length, 24);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1280);
  assert.equal(h.calls.at(-1)[0], 'ai_job_cancel');
});

test('worker failure cleans the job, never returns/saves a fallback sheet', async () => {
  const h = harness(name => name === 'ai_job_begin' ? 'job1' : name === 'ai_job_poll' ? { stage: 'error', error: '没有主体' } : null);
  await assert.rejects(h.run({ videoWidth: 1280, videoHeight: 720, duration: 4 }, async () => {}, false), /没有主体/);
  assert.equal(h.calls.at(-1)[0], 'ai_job_cancel');
  assert.equal(h.calls.some(([name]) => name === 'save_user_asset'), false);
});

test('cancel during extraction cleans up and never starts worker', async () => {
  const controller = new AbortController();
  const h = harness(name => {
    if (name === 'ai_job_begin') return 'job1';
    if (name === 'ai_job_frame') controller.abort();
  });
  await assert.rejects(h.run({ videoWidth: 3840, videoHeight: 2160, duration: 4 }, async () => {}, false, null, controller.signal), /已取消处理/);
  assert.equal(h.canvases[0].width, 1280);
  assert.equal(h.canvases[0].height, 720);
  assert.equal(h.calls.some(([name]) => name === 'ai_job_start'), false);
  assert.equal(h.calls.at(-1)[0], 'ai_job_cancel');
});
