/**
 * HTTP 路由：挂在 harness 自带 webServer 的同源前缀 `/session-tidy-api`。
 *
 *   GET  /status   插件健康状态
 *   GET  /plan     整理建议（只读，10 秒缓存；?current=<sessionId> 保护当前会话）
 *   GET  /undo     撤销账本摘要
 *   POST /apply    {batchId?, actions:[{kind:'rename'|'archive'|'unarchive', sessionId, title?}]}
 *   POST /undo     撤销最近一批
 *
 * 请求体上限 512 KB；所有响应都是 JSON，且 `cache-control: no-store`。
 */

const BASE = '/session-tidy-api';
const MAX_BODY_BYTES = 512 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

/**
 * @param {{
 *   status: () => object,
 *   plan: (options?: {refresh?: boolean}) => Promise<object>,
 *   apply: (input: object) => Promise<object>,
 *   undo: () => Promise<object>,
 *   history: () => object,
 * }} engine
 */
export function createTidyRouter(engine) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rest = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname;
      if (!rest.startsWith('/')) rest = `/${rest}`;
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET' && (rest === '/' || rest === '/health' || rest === '/status')) {
        sendJson(res, 200, await engine.status());
        return;
      }

      if (method === 'GET' && rest === '/plan') {
        const refresh = url.searchParams.get('refresh') === '1';
        const currentId = url.searchParams.get('current') || '';
        const rawStale = Number(url.searchParams.get('staleDays'));
        const staleDays =
          Number.isFinite(rawStale) && rawStale >= 1 && rawStale <= 365 ? Math.round(rawStale) : undefined;
        const rawKeep = Number(url.searchParams.get('keep'));
        const keepPerWorkspace =
          url.searchParams.has('keep') && Number.isFinite(rawKeep) && rawKeep >= 0 && rawKeep <= 100
            ? Math.round(rawKeep)
            : undefined;
        const plan = await engine.plan({ refresh, currentId, staleDays, keepPerWorkspace });
        sendJson(res, 200, plan);
        return;
      }

      if (method === 'GET' && rest === '/undo') {
        sendJson(res, 200, { ok: true, ...(await engine.history()) });
        return;
      }

      if (method === 'POST' && rest === '/apply') {
        const body = await readJsonBody(req);
        const result = await engine.apply(body);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (method === 'POST' && rest === '/undo') {
        const result = await engine.undo();
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: '未知路径' });
    } catch (error) {
      try {
        sendJson(res, error.statusCode || 500, { ok: false, error: errorMessage(error) });
      } catch {
        /* 连接已关闭 */
      }
    }
  };
}

export { BASE as TIDY_ROUTE_BASE };
