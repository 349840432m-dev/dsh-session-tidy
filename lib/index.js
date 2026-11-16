/**
 * dsh-session-tidy · Host 半边
 *
 * 职责：
 *   1. 只读扫描 ~/.dsh，生成「会话整理建议」（空白归档 / 标题清洗 / 重名区分 / 陈旧归档）；
 *   2. 在 harness 自带 webServer 上注册同源前缀 `/session-tidy-api`，并用
 *      `ctx.connection.requestRejection()` 做 Host / Origin / 浏览器凭据准入；
 *   3. 通过宿主服务执行动作：sessionController.rename、workspaceRegistry.archiveSession；
 *   4. 写 <pluginRoot>/data/status.json 与 data/plugin.log，便于无终端排查；
 *   5. 每批动作落撤销账本 data/undo.json。
 *
 * 浏览器半边（package.json `dsh.client`）负责输入框上方的常驻按钮与整理浮层。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanInventory } from './tidy/inventory.js';
import { buildPlan, normalizeActions } from './tidy/plan.js';
import { createTidyRouter, TIDY_ROUTE_BASE } from './tidy/routes.js';
import { UndoStore } from './tidy/undo.js';

const PLUGIN_VERSION = '0.2.1';
const INVENTORY_TTL_MS = 30_000;
const PLAN_TTL_MS = 10_000;
const LOG_LIMIT_BYTES = 256 * 1024;

export const name = 'session-tidy';

/** 需要 harness 的 HTTP 载体；没有它插件不激活。 */
export const inject = ['webServer'];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 会话 id 的两种写法：宿主持久层用裸 uuid，workspace.json 的历史记录用
 * `session-<uuid>`。按顺序都试一遍，避免被对方的 id 形式卡住。
 */
export function idVariants(sessionId) {
  const id = String(sessionId ?? '').trim();
  if (!id) return [];
  const variants = [id];
  if (id.startsWith('session-')) variants.push(id.slice('session-'.length));
  else variants.push(`session-${id}`);
  return variants;
}

async function callWithIdFallback(sessionId, invoke) {
  const variants = idVariants(sessionId);
  let lastError = null;
  for (const variant of variants) {
    try {
      return { value: await invoke(variant), id: variant };
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      // 只有「找不到会话」才值得换一种 id 再试
      if (!/not found|no such session|未知会话/i.test(message)) break;
    }
  }
  throw lastError ?? new Error('会话不存在');
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.join(pluginRoot, 'data');
  const dataRoot =
    process.env.DSH_SESSION_TIDY_DATA_ROOT || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

  const undoStore = new UndoStore(path.join(dataDir, 'undo.json'));
  let lastError = null;
  let lastApply = null;
  let inventoryCache = null;
  let inventoryPromise = null;
  let planCache = null;
  let logQueue = Promise.resolve();

  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    logQueue = logQueue
      .then(async () => {
        await fsp.mkdir(dataDir, { recursive: true });
        const file = path.join(dataDir, 'plugin.log');
        try {
          const stat = await fsp.stat(file);
          if (stat.size > LOG_LIMIT_BYTES) await fsp.rename(file, `${file}.1`);
        } catch {
          /* 首次写入 */
        }
        await fsp.appendFile(file, line, 'utf8');
      })
      .catch(() => {});
  };

  const writeStatus = async (patch) => {
    try {
      await fsp.mkdir(dataDir, { recursive: true });
      const status = {
        ok: true,
        plugin: 'dsh-session-tidy',
        version: PLUGIN_VERSION,
        pluginRoot,
        dataRoot,
        route: TIDY_ROUTE_BASE,
        registeredAt: Date.now(),
        pid: process.pid,
        lastError,
        lastApply,
        ...patch,
      };
      await fsp.writeFile(path.join(dataDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    } catch {
      /* 只读安装目录时忽略 */
    }
  };

  const service = (key) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(key) : undefined;
    } catch {
      return undefined;
    }
  };

  const inventory = async (options = {}) => {
    const maxAge = options.maxAgeMs ?? INVENTORY_TTL_MS;
    const now = Date.now();
    if (inventoryCache && now - inventoryCache.at <= maxAge) return inventoryCache.value;
    if (inventoryPromise) return inventoryPromise;
    inventoryPromise = scanInventory(dataRoot)
      .then((value) => {
        inventoryCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inventoryPromise = null;
      });
    return inventoryPromise;
  };

  const invalidate = () => {
    inventoryCache = null;
    planCache = null;
  };

  const plan = async (options = {}) => {
    const now = Date.now();
    const currentId = typeof options.currentId === 'string' ? options.currentId.trim() : '';
    const staleDays = Number.isFinite(options.staleDays) ? options.staleDays : undefined;
    const keepPerWorkspace = Number.isFinite(options.keepPerWorkspace) ? options.keepPerWorkspace : undefined;
    const cacheKey = `${currentId || '-'}|${staleDays ?? '-'}|${keepPerWorkspace ?? '-'}`;
    if (!options.refresh && planCache && planCache.key === cacheKey && now - planCache.at <= PLAN_TTL_MS) {
      return planCache.value;
    }
    const source = await inventory({ maxAgeMs: options.refresh ? 0 : INVENTORY_TTL_MS });
    const value = buildPlan(source, {
      protectedIds: currentId ? [currentId] : [],
      ...(staleDays ? { staleDays } : {}),
      ...(Number.isFinite(keepPerWorkspace) ? { keepPerWorkspace } : {}),
    });
    planCache = { at: now, key: cacheKey, value };
    return value;
  };

  const requireService = (key, method) => {
    const target = service(key);
    if (!target || typeof target[method] !== 'function') {
      throw new Error(`宿主未提供 ${key}.${method}()`);
    }
    return target;
  };

  const applyActions = async (input) => {
    const actions = normalizeActions(input && input.actions);
    if (actions.length === 0) {
      return { ok: false, error: '没有可执行的动作' };
    }

    const batchId =
      typeof input.batchId === 'string' && input.batchId.trim()
        ? input.batchId.trim().slice(0, 80)
        : `tidy-${Date.now().toString(36)}`;

    const source = await inventory({ maxAgeMs: 60_000 });
    const byId = new Map(source.rows.map((row) => [row.sessionId, row]));

    const results = [];
    const undoActions = [];

    for (const action of actions) {
      const row = byId.get(action.sessionId);
      try {
        if (action.kind === 'rename') {
          const controller = requireService('sessionController', 'rename');
          const before = row ? row.title : null;
          const { value, id } = await callWithIdFallback(action.sessionId, (sessionId) =>
            controller.rename({ sessionId, title: action.title })
          );
          const title = value && typeof value.title === 'string' ? value.title : action.title;
          results.push({ ok: true, kind: 'rename', sessionId: action.sessionId, title, before });
          if (before !== null) {
            undoActions.push({ kind: 'rename', sessionId: action.sessionId, hostId: id, before, after: title });
          }
        } else if (action.kind === 'archive') {
          const registry = requireService('workspaceRegistry', 'archiveSession');
          const { id } = await callWithIdFallback(action.sessionId, (sessionId) => registry.archiveSession(sessionId));
          results.push({ ok: true, kind: 'archive', sessionId: action.sessionId });
          undoActions.push({ kind: 'archive', sessionId: action.sessionId, hostId: id, before: false });
        } else {
          const registry = requireService('workspaceRegistry', 'unarchiveSession');
          const { id } = await callWithIdFallback(action.sessionId, (sessionId) => registry.unarchiveSession(sessionId));
          results.push({ ok: true, kind: 'unarchive', sessionId: action.sessionId });
          undoActions.push({ kind: 'unarchive', sessionId: action.sessionId, hostId: id, before: true });
        }
      } catch (error) {
        results.push({
          ok: false,
          kind: action.kind,
          sessionId: action.sessionId,
          error: errorMessage(error),
        });
      }
    }

    const applied = results.filter((result) => result.ok).length;
    const failed = results.length - applied;

    if (undoActions.length > 0) {
      try {
        await undoStore.append({ id: batchId, ts: Date.now(), actions: undoActions });
      } catch (error) {
        log(`撤销账本写入失败：${errorMessage(error)}`);
      }
    }

    lastApply = {
      batchId,
      ts: Date.now(),
      applied,
      failed,
      renames: undoActions.filter((action) => action.kind === 'rename').length,
      archives: undoActions.filter((action) => action.kind === 'archive').length,
    };
    lastError = failed > 0 ? errorMessage(results.find((result) => !result.ok)?.error) : null;
    log(`apply ${batchId}: ${applied} 成功 / ${failed} 失败`);
    invalidate();
    await writeStatus({ phase: 'active' });

    return {
      ok: applied > 0,
      batchId,
      applied,
      failed,
      results,
      undo: { available: undoActions.length > 0, count: undoActions.length },
      error: applied === 0 ? errorMessage(results[0]?.error ?? '全部动作失败') : undefined,
    };
  };

  const undoLast = async () => {
    const batch = await undoStore.lastUndoable();
    if (!batch) return { ok: false, error: '没有可撤销的整理批次' };

    const results = [];
    for (const action of [...batch.actions].reverse()) {
      const target = action.hostId || action.sessionId;
      try {
        if (action.kind === 'rename') {
          const controller = requireService('sessionController', 'rename');
          await callWithIdFallback(target, (sessionId) => controller.rename({ sessionId, title: action.before }));
        } else if (action.kind === 'archive') {
          const registry = requireService('workspaceRegistry', 'unarchiveSession');
          await callWithIdFallback(target, (sessionId) => registry.unarchiveSession(sessionId));
        } else if (action.kind === 'unarchive') {
          const registry = requireService('workspaceRegistry', 'archiveSession');
          await callWithIdFallback(target, (sessionId) => registry.archiveSession(sessionId));
        }
        results.push({ ok: true, kind: action.kind, sessionId: action.sessionId });
      } catch (error) {
        results.push({ ok: false, kind: action.kind, sessionId: action.sessionId, error: errorMessage(error) });
      }
    }

    const restored = results.filter((result) => result.ok).length;
    if (restored === results.length) await undoStore.markUndone(batch.id);
    log(`undo ${batch.id}: ${restored}/${results.length}`);
    invalidate();
    await writeStatus({ phase: 'active' });

    return {
      ok: restored > 0,
      batchId: batch.id,
      restored,
      failed: results.length - restored,
      results,
    };
  };

  const engine = {
    async status() {
      // 附带宿主实际使用的会话 id 样例：排查「session not found」时一眼能看出 id 形式
      let hostSessions = null;
      try {
        const controller = service('sessionController');
        if (controller && typeof controller.list === 'function') {
          const value = await controller.list({}, AbortSignal.timeout(3000));
          const items = Array.isArray(value && value.items) ? value.items : [];
          hostSessions = { count: items.length, sample: items.slice(0, 3).map((item) => item.sessionId) };
        }
      } catch (error) {
        hostSessions = { error: errorMessage(error) };
      }
      return {
        hostSessions,
        ok: true,
        plugin: 'dsh-session-tidy',
        version: PLUGIN_VERSION,
        route: TIDY_ROUTE_BASE,
        dataRoot,
        pid: process.pid,
        cached: {
          inventory: Boolean(inventoryCache),
          inventoryAt: inventoryCache ? inventoryCache.at : null,
          plan: Boolean(planCache),
          planAt: planCache ? planCache.at : null,
        },
        inventory: inventoryCache ? inventoryCache.value.stats : null,
        lastApply,
        lastError,
      };
    },
    plan,
    apply: applyActions,
    undo: undoLast,
    async history() {
      await undoStore.load();
      return {
        batches: undoStore.summary(),
        lastUndoable: undoStore.state.batches.some((batch) => !batch.undone && batch.actions.length > 0),
      };
    },
  };

  // 前缀路由不会自动经过 DSH 的 Connection 准入：每个请求显式问一次。
  // connection 不可用时按 403 失败关闭（宁可不可用，也不给未授权写入口）。
  const trust = (req) => {
    const connection = service('connection');
    if (!connection || typeof connection.requestRejection !== 'function') return 403;
    return connection.requestRejection({ headers: req.headers ?? {} });
  };

  const handler = createTidyRouter(engine, { trust });
  const removeRoute = ctx.webServer.register({ kind: 'prefix', path: TIDY_ROUTE_BASE, handler });

  ctx.effect(
    () => () => {
      removeRoute();
    },
    'session-tidy: route'
  );

  log(`activated v${PLUGIN_VERSION} dataRoot=${dataRoot}`);
  writeStatus({ phase: 'active', warm: 'scheduled' });

  undoStore
    .load()
    .then(() => inventory())
    .then(async (value) => {
      await writeStatus({ phase: 'ready', warm: 'complete', inventory: value.stats });
      log(`warm complete: ${value.stats.sessions} sessions`);
    })
    .catch((error) => {
      lastError = errorMessage(error);
      log(`warm failed: ${lastError}`);
      writeStatus({ phase: 'degraded', error: lastError });
    });
}
