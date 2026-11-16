/**
 * 路由单测：用假引擎起一个真实 HTTP 服务（node verify/routes.test.mjs）。
 * 只验证 HTTP 契约与错误处理，不触碰真实宿主。
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { createTidyRouter, TIDY_ROUTE_BASE } from '../lib/tidy/routes.js';

const seen = [];

const engine = {
  status: () => ({ ok: true, plugin: 'dsh-session-tidy', version: '0.1.0' }),
  plan: async (options) => {
    seen.push(['plan', options]);
    return { ok: true, refresh: Boolean(options.refresh), totals: { actionable: 2 }, groups: [] };
  },
  apply: async (body) => {
    seen.push(['apply', body]);
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return { ok: false, error: '没有可执行的动作' };
    }
    return { ok: true, batchId: body.batchId ?? 'auto', applied: body.actions.length, failed: 0 };
  },
  undo: async () => ({ ok: true, restored: 2 }),
  history: async () => ({ batches: [{ id: 'b1', count: 2 }], lastUndoable: true }),
};

// 模拟 DSH 的 connection.requestRejection：undefined = 放行，403 = 拒绝
let trustResult;
const trust = () => trustResult;

const server = http.createServer((req, res) => {
  if (!req.url.startsWith(TIDY_ROUTE_BASE)) {
    res.writeHead(404).end();
    return;
  }
  createTidyRouter(engine, { trust })(req, res);
});

const WRITE_HEADERS = {
  'content-type': 'application/json',
  'x-dsh-session-tidy': '1',
};

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function call(pathname, init) {
  const response = await fetch(`${origin}${TIDY_ROUTE_BASE}${pathname}`, init);
  const data = await response.json();
  return { status: response.status, data };
}

try {
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.plugin, 'dsh-session-tidy');

  const plan = await call('/plan?refresh=1');
  assert.equal(plan.status, 200);
  assert.equal(plan.data.refresh, true);
  assert.deepEqual(seen.at(-1), [
    'plan',
    { refresh: true, currentId: '', staleDays: undefined, keepPerWorkspace: undefined },
  ]);

  const protectedPlan = await call('/plan?current=f30dffbd-0c83-4b40-9c43-40829f84d7af&staleDays=3&keep=5');
  assert.equal(protectedPlan.status, 200);
  assert.equal(seen.at(-1)[1].currentId, 'f30dffbd-0c83-4b40-9c43-40829f84d7af');
  assert.equal(seen.at(-1)[1].staleDays, 3);
  assert.equal(seen.at(-1)[1].keepPerWorkspace, 5);

  const history = await call('/undo');
  assert.equal(history.status, 200);
  assert.equal(history.data.lastUndoable, true);

  // DSH 准入拒绝时，读接口也必须 403
  trustResult = 403;
  const denied = await call('/plan');
  assert.equal(denied.status, 403);
  assert.equal(denied.data.ok, false);
  trustResult = undefined;

  const applied = await call('/apply', {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({ batchId: 'batch-1', actions: [{ kind: 'archive', sessionId: 'session-a' }] }),
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, 1);
  assert.equal(applied.data.batchId, 'batch-1');

  // 写操作缺少自定义头 → 403（跨源请求无法绕过 CORS 预检）
  const noHeader = await call('/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actions: [] }),
  });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.data.ok, false);

  // 非 JSON content-type → 415
  const wrongType = await call('/apply', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-dsh-session-tidy': '1' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);

  const empty = await call('/apply', {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({ actions: [] }),
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.ok, false);

  const undo = await call('/undo', { method: 'POST', headers: WRITE_HEADERS, body: '{}' });
  assert.equal(undo.status, 200);
  assert.equal(undo.data.restored, 2);

  const badJson = await call('/apply', { method: 'POST', headers: WRITE_HEADERS, body: '{oops' });
  assert.equal(badJson.status, 400);
  assert.match(badJson.data.error, /JSON/);

  const unknown = await call('/nope');
  assert.equal(unknown.status, 404);

  const wrongMethod = await call('/plan', { method: 'POST', headers: WRITE_HEADERS, body: '{}' });
  assert.equal(wrongMethod.status, 404, '方法不匹配时按未知路径处理');

  console.log('routes.test.mjs: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
