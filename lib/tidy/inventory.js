/**
 * 会话清单：只读扫描 ~/.dsh 的两处本地状态，不依赖会话日志，也不 resume 任何 Agent。
 *
 *   1. <dataRoot>/storages/session_projcache/sessions/*.json
 *      record.rows.title / titleInput / sessionListMetadata / sessionStats /
 *      turnOutline / workingDirectory / modelSelection
 *   2. <dataRoot>/storages/workspace.json
 *      global.workspaceIds / archivedSessionIds / pinnedSessionIds、tables.workspaces
 *
 * 投影缓存按事件增量更新，是标题、轮次、空白标记与最近提示时间的事实来源；
 * workspace.json 提供工作区归属、归档与置顶状态。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export const PROJ_SUBDIR = path.join('storages', 'session_projcache', 'sessions');
export const WORKSPACE_FILE = path.join('storages', 'workspace.json');

const PREFIXED = /^(?:orchestrator|subagent|parent)-/;

function int(value) {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function rowVal(rows, key) {
  const row = rows && rows[key];
  return row && row.val !== undefined && row.val !== null ? row.val : null;
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim() : '';
}

function clip(text, limit) {
  const s = String(text ?? '');
  return s.length <= limit ? s : s.slice(0, limit);
}

/** 'session-<uuid>.json' / '<uuid>.json' → '<uuid>'；带 orchestrator 前缀的保留。 */
export function sessionKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const name = path.basename(raw);
  const stem = name.endsWith('.json') ? name.slice(0, -5) : name;
  return stem.startsWith('session-') ? stem.slice('session-'.length) : stem;
}

/**
 * key → 宿主实际使用的 sessionId。
 *
 * 实测：会话日志头 `header.id` 与 sessions/<slug>/<dir> 目录名都是**裸 uuid**，
 * `session-<uuid>` 是 workspace.json 里归档/置顶记录的旧写法。宿主 API
 * （sessionController.rename / workspaceRegistry.archiveSession）要的是裸 uuid；
 * orchestrator-/subagent-/parent- 这类合成 id 原样返回。
 */
export function sessionIdOf(key) {
  if (typeof key !== 'string' || key.length === 0) return '';
  return key;
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 解析单个投影缓存文件。 */
export function parseProjection(raw, key, mtimeMs = 0) {
  const record = raw && typeof raw === 'object' ? raw.record : null;
  const rows = record && typeof record.rows === 'object' ? record.rows : {};
  const identity = record && typeof record.identity === 'object' ? record.identity : {};

  const meta = rowVal(rows, 'sessionListMetadata') ?? {};
  const stats = rowVal(rows, 'sessionStats') ?? {};
  const outline = rowVal(rows, 'turnOutline') ?? {};
  const titleInput = rowVal(rows, 'titleInput') ?? {};
  const workingDirectory = rowVal(rows, 'workingDirectory');
  const subagent = rowVal(rows, 'subagent');
  const subagentIdentity = subagent && typeof subagent === 'object' ? subagent.identity : null;

  const turns = Array.isArray(outline.turns) ? outline.turns : [];
  const firstTurn = turns.find((turn) => turn && typeof turn === 'object') ?? null;
  const firstPrompt = cleanText(
    (titleInput.first && titleInput.first.text) || (firstTurn && firstTurn.prompt) || ''
  );
  const title = cleanText(rowVal(rows, 'title'));

  const createdAt = Number.isFinite(identity.createdAt) ? identity.createdAt : null;
  const lastPromptAt = Number.isFinite(meta.lastPromptAt) ? meta.lastPromptAt : null;

  return {
    key,
    sessionId: sessionIdOf(key),
    title,
    createdAt,
    lastPromptAt,
    updatedAt: Math.max(mtimeMs || 0, lastPromptAt || 0, createdAt || 0),
    blank: Boolean(meta.blank),
    turns: int(stats.turns),
    steps: int(stats.steps),
    open: Boolean(stats.openStep && Number.isFinite(stats.openStep.startTime)),
    cwd: cleanText(workingDirectory) || cleanText(identity.cwd),
    firstPrompt: clip(firstPrompt, 4000),
    // 子代理会话：挂在某个父会话下，侧栏不单独列出，DSH 也拒绝按普通会话改名
    subagent: Boolean(subagentIdentity),
    subagentLabel:
      subagentIdentity && typeof subagentIdentity.label === 'string' ? subagentIdentity.label : '',
  };
}

/** 扫描 sessions/<slug>/<dir>，返回宿主实际持有的会话 key 集合。 */
export async function scanSessionDirs(dataRoot) {
  const base = path.join(dataRoot, 'sessions');
  const keys = new Set();
  let slugs = [];
  try {
    slugs = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return keys;
  }
  await Promise.all(
    slugs
      .filter((entry) => entry.isDirectory())
      .map(async (slug) => {
        try {
          const entries = await fsp.readdir(path.join(base, slug.name), { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const key = sessionKey(entry.name);
            if (key) keys.add(key);
          }
        } catch {
          /* 单个工作区目录读不到就跳过 */
        }
      })
  );
  return keys;
}

export async function scanProjections(dataRoot) {
  const dir = path.join(dataRoot, PROJ_SUBDIR);
  const out = new Map();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const file = path.join(dir, name);
        const key = sessionKey(name);
        if (!key) return;
        try {
          const [stat, text] = await Promise.all([fsp.stat(file), fsp.readFile(file, 'utf8')]);
          const raw = JSON.parse(text);
          out.set(key, parseProjection(raw, key, stat.mtimeMs));
        } catch {
          /* 写一半 / 坏文件：跳过 */
        }
      })
  );
  return out;
}

/** 读取 workspace.json：工作区表、会话归属、归档与置顶集合。 */
export async function scanWorkspaces(dataRoot) {
  const raw = await readJson(path.join(dataRoot, WORKSPACE_FILE));
  const bySession = new Map();
  const workspaces = [];
  const archived = new Set();
  const pinned = new Set();

  const global = raw && raw.global;
  for (const id of Array.isArray(global && global.archivedSessionIds) ? global.archivedSessionIds : []) {
    const key = sessionKey(id);
    if (key) archived.add(key);
  }
  for (const id of Array.isArray(global && global.pinnedSessionIds) ? global.pinnedSessionIds : []) {
    const key = sessionKey(id);
    if (key) pinned.add(key);
  }

  const table = raw && raw.tables && raw.tables.workspaces;
  if (table && typeof table === 'object') {
    for (const [workspaceId, value] of Object.entries(table)) {
      if (!value || typeof value !== 'object') continue;
      const wsPath = typeof value.path === 'string' ? value.path : '';
      const title =
        typeof value.title === 'string' && value.title.trim()
          ? value.title.trim()
          : path.basename(wsPath) || '未命名工作区';
      const sessionIds = Array.isArray(value.sessionIds) ? value.sessionIds : [];
      workspaces.push({ id: workspaceId, title, path: wsPath, sessionCount: sessionIds.length });
      for (const sid of sessionIds) {
        const key = sessionKey(sid);
        if (key) bySession.set(key, { id: workspaceId, title, path: wsPath });
      }
    }
  }

  return { bySession, workspaces, archived, pinned };
}

/**
 * @param {string} dataRoot  ~/.dsh 或 DSH_HOME
 * @returns {Promise<{rows: object[], workspaces: object[], generatedAt: number, stats: object}>}
 */
export async function scanInventory(dataRoot) {
  const [projections, ws, sessionDirs] = await Promise.all([
    scanProjections(dataRoot),
    scanWorkspaces(dataRoot),
    scanSessionDirs(dataRoot),
  ]);

  // 工作区归属：先按 workspace.json 的 sessionIds，再按 cwd 的最长路径前缀兜底
  const byPath = [...ws.workspaces]
    .filter((workspace) => workspace.path)
    .sort((a, b) => b.path.length - a.path.length);

  const workspaceOfPath = (cwd) => {
    if (!cwd) return null;
    for (const workspace of byPath) {
      if (cwd === workspace.path) return workspace;
      if (cwd.startsWith(workspace.path.endsWith('/') ? workspace.path : `${workspace.path}/`)) return workspace;
    }
    return null;
  };

  const rows = [];
  let orphaned = 0;
  for (const [key, row] of projections) {
    // 投影缓存可能比会话日志活得久：裸 uuid 且宿主目录里根本没有的，视为残留记录
    if (sessionDirs.size > 0 && !PREFIXED.test(key) && !sessionDirs.has(key)) {
      orphaned += 1;
      continue;
    }
    const workspace = ws.bySession.get(key) || workspaceOfPath(row.cwd);
    rows.push({
      ...row,
      workspaceId: workspace ? workspace.id : null,
      workspaceTitle: workspace ? workspace.title : '',
      workspacePath: workspace ? workspace.path : '',
      archived: ws.archived.has(key),
      pinned: ws.pinned.has(key),
    });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));

  const stats = {
    sessions: rows.length,
    subagent: rows.filter((row) => row.subagent).length,
    orphaned,
    archived: rows.filter((row) => row.archived).length,
    pinned: rows.filter((row) => row.pinned).length,
    blank: rows
      .filter((row) => !row.archived && !row.subagent && (row.blank || (row.turns === 0 && !row.firstPrompt)))
      .length,
  };

  return { rows, workspaces: ws.workspaces, generatedAt: Date.now(), stats };
}
