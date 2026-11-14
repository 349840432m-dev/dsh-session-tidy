/**
 * 整理规则：把会话清单折成「可执行的整理建议」。
 *
 * 只做三类动作，全部可撤销：
 *   - archive   归档空白会话（没有任何提示词，或投影缓存标记 blank）
 *   - rename    整理标题（去掉角色设定开头 / 代码块 / URL / 截断省略号，压到长度上限内）
 *   - archive   归档长期未活动的会话（默认不勾选）
 *
 * 不做语义总结：标题只从首条提示词做确定性清洗，改完长什么样在预览里一清二楚。
 */

import { TITLE_LIMIT, exactKey, isPlaceholder, normalizeTitle, proposeTitle, titleIssues, titleKey, uniqueTitle } from './titles.js';

export const STALE_DAYS = 7;
/** 5 分钟内还在活动的会话不碰（当前打开的会话由客户端显式排除，见 protectedIds）。 */
export const SETTLE_MS = 5 * 60 * 1000;
export const MAX_RENAME_ITEMS = 40;
/** 面板里可选的「未活动天数」档位。 */
export const STALE_PRESETS = [1, 3, 7, 14, 30, 90];
/** 「每个工作区保留最近 N 条」的可选档位；0 = 关闭。 */
export const KEEP_PRESETS = [0, 1, 3, 5, 8, 12];
export const DEFAULT_KEEP = 5;

const SEVERITY = {
  placeholder: 0,
  preamble: 0,
  noise: 1,
  multiline: 1,
  truncated: 2,
  too_long: 3,
};

function severityOf(issues) {
  let best = 9;
  for (const issue of issues) {
    const rank = SEVERITY[issue];
    if (rank !== undefined && rank < best) best = rank;
  }
  return best;
}

function itemOf(row, extra) {
  return {
    sessionId: row.sessionId,
    title: normalizeTitle(row.title) || '（无标题）',
    workspace: row.workspaceTitle || '',
    updatedAt: row.updatedAt || null,
    turns: row.turns || 0,
    blank: Boolean(row.blank),
    ...extra,
  };
}

/**
 * @param {{rows: object[], workspaces: object[], generatedAt: number, stats: object}} inventory
 * @param {{now?: number, titleLimit?: number, staleDays?: number, settleMs?: number, maxRenames?: number, protectedIds?: Set<string>|string[]}} [options]
 */
export function buildPlan(inventory, options = {}) {
  const now = options.now ?? Date.now();
  const limit = options.titleLimit ?? TITLE_LIMIT;
  const staleDays = options.staleDays ?? STALE_DAYS;
  const keepPerWorkspace = Number.isFinite(options.keepPerWorkspace) ? Math.max(0, Math.round(options.keepPerWorkspace)) : DEFAULT_KEEP;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const maxRenames = options.maxRenames ?? MAX_RENAME_ITEMS;
  const protectedIds = new Set(
    options.protectedIds ? [...options.protectedIds] : []
  );
  const allRows = Array.isArray(inventory && inventory.rows) ? inventory.rows : [];
  // 子代理会话挂在父会话下，侧栏不单独列出，DSH 也拒绝按普通会话改名 → 不参与整理
  // 当前打开的会话即使空白也不动（用户可能正要发消息）
  const ordinaryRows = allRows.filter((row) => !row.subagent);
  const rows = ordinaryRows.filter(
    (row) => !protectedIds.has(row.sessionId) && !protectedIds.has(`session-${row.sessionId}`)
  );

  const isBlank = (row) => row.blank || (row.turns === 0 && !row.firstPrompt);
  const settled = (row) => !row.updatedAt || row.updatedAt <= now - settleMs;

  /* ---------- 1. 空白会话 ---------- */
  const blankItems = [];
  for (const row of rows) {
    if (row.archived || row.pinned || row.open) continue;
    if (!isBlank(row) || !settled(row)) continue;
    blankItems.push(itemOf(row, { action: 'archive', reason: 'blank' }));
  }

  /* ---------- 2. 标题候选 ---------- */
  const titleCandidates = [];
  const claimed = new Set();

  for (const row of rows) {
    if (row.archived || isBlank(row)) continue;
    const issues = titleIssues(row.title, limit);
    if (issues.length === 0) continue;
    const proposal = proposeTitle(row, { limit, used: new Set([titleKey(row.title)]) });
    if (!proposal) continue;
    titleCandidates.push({
      row,
      nextTitle: proposal.title,
      reason: issues.join('+'),
      priority: severityOf(issues),
    });
    claimed.add(row.sessionId);
  }

  /* ---------- 3. 重名 ---------- */
  const buckets = new Map();
  for (const row of rows) {
    if (row.archived || isBlank(row) || claimed.has(row.sessionId)) continue;
    const key = titleKey(row.title);
    if (!key) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }

  const duplicateCandidates = [];
  for (const [, group] of buckets) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = sorted.find((row) => row.pinned) ?? sorted[0];
    for (const row of sorted) {
      if (row.sessionId === keep.sessionId) continue;
      // 重名只做区分，不改写内容：保留原标题，冲突由 uniqueTitle 追加（2）。
      duplicateCandidates.push({
        row,
        nextTitle: normalizeTitle(row.title) || keep.title,
        reason: 'duplicate',
        priority: 4,
        keepTitle: keep.title,
      });
      claimed.add(row.sessionId);
    }
  }

  /* ---------- 4. 长期未活动 ---------- */
  const staleCutoff = now - staleDays * 24 * 60 * 60 * 1000;
  const staleItems = [];
  for (const row of rows) {
    if (row.archived || row.pinned || row.open) continue;
    if (isBlank(row) || row.turns === 0) continue;
    if (!row.updatedAt || row.updatedAt > staleCutoff) continue;
    staleItems.push(itemOf(row, { action: 'archive', reason: 'stale' }));
  }

  /* ---------- 4.5 每个工作区只保留最近 N 条 ---------- */
  const capItems = [];
  if (keepPerWorkspace > 0) {
    const buckets = new Map();
    // 当前会话也参与「最近 N 条」的名次计算（它占一个名额），但永远不会被归档
    for (const row of ordinaryRows) {
      const isProtected =
        protectedIds.has(row.sessionId) || protectedIds.has(`session-${row.sessionId}`);
      if (row.archived || row.pinned) continue;
      // 当前会话通常处于 open 状态：它照样占一个「最近」名额
      if (row.open && !isProtected) continue;
      if (isBlank(row)) continue;
      // 只对「登记过的工作区」做保留裁剪；未归属的散会话不碰，避免一次归档掉一大片
      if (!row.workspaceId) continue;
      const bucket = buckets.get(row.workspaceId) ?? [];
      bucket.push(row);
      buckets.set(row.workspaceId, bucket);
    }
    const already = new Set([
      ...blankItems.map((item) => item.sessionId),
      ...staleItems.map((item) => item.sessionId),
      ...titleCandidates.map((candidate) => candidate.row.sessionId),
      ...duplicateCandidates.map((candidate) => candidate.row.sessionId),
    ]);
    for (const [, bucket] of buckets) {
      const sorted = [...bucket].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const row of sorted.slice(keepPerWorkspace)) {
        if (already.has(row.sessionId)) continue;
        if (!settled(row)) continue;
        if (protectedIds.has(row.sessionId) || protectedIds.has(`session-${row.sessionId}`)) continue;
        capItems.push(itemOf(row, { action: 'archive', reason: 'workspace-cap' }));
      }
    }
  }

  /* ---------- 5. 分配唯一标题（受上限约束） ---------- */
  const candidates = [...titleCandidates, ...duplicateCandidates]
    .sort((a, b) => a.priority - b.priority || b.row.updatedAt - a.row.updatedAt)
    .slice(0, maxRenames);

  // 命名空间：所有不会被改写的会话（已归档 / 空白 / 未入选）占用原标题
  const renaming = new Set(candidates.map((candidate) => candidate.row.sessionId));
  const used = new Set();
  for (const row of rows) {
    if (row.archived || isBlank(row) || renaming.has(row.sessionId)) continue;
    const key = exactKey(row.title);
    if (key) used.add(key);
  }

  const renameItems = [];
  for (const candidate of candidates) {
    const next = uniqueTitle(candidate.nextTitle, used, limit);
    used.add(exactKey(next));
    if (exactKey(next) === exactKey(candidate.row.title)) continue;
    renameItems.push(
      itemOf(candidate.row, {
        action: 'rename',
        nextTitle: next,
        reason: candidate.reason,
        via: candidate.reason === 'duplicate' ? 'duplicate' : 'title',
      })
    );
  }

  const titleItems = renameItems.filter((item) => item.via === 'title');
  const duplicateItems = renameItems.filter((item) => item.via === 'duplicate');

  const groups = [
    {
      id: 'blank',
      kind: 'archive',
      title: '归档空白会话',
      hint: '从未输入过提示词的会话；归档不删除，可从侧栏归档区恢复。',
      defaultSelected: true,
      items: blankItems,
    },
    {
      id: 'titles',
      kind: 'rename',
      title: '整理标题',
      hint: '去掉角色设定开头、代码块与截断省略号，压到长度上限内。',
      defaultSelected: true,
      items: titleItems,
    },
    {
      id: 'duplicates',
      kind: 'rename',
      title: '区分重名标题',
      hint: '同名会话只保留最近活跃的一个，其余在标题后补「（2）」区分；不改写内容，按需勾选。',
      defaultSelected: false,
      items: duplicateItems,
    },
    {
      id: 'cap',
      kind: 'archive',
      title: `每个工作区只保留最近 ${keepPerWorkspace} 条`,
      hint: '按工作区分组，保留最近 N 条，排在后面的收进归档；归档不删除，可随时恢复。',
      defaultSelected: true,
      items: capItems,
    },
    {
      id: 'stale',
      kind: 'archive',
      title: `归档 ${staleDays} 天未活动的会话`,
      hint: '按「最后活动时间」判断；归档不删除，可随时恢复。上方可切换天数。',
      defaultSelected: true,
      items: staleItems,
    },
  ].filter((group) => group.items.length > 0);

  const totals = {
    sessions: ordinaryRows.length,
    subagent: allRows.length - ordinaryRows.length,
    archived: rows.filter((row) => row.archived).length,
    blank: blankItems.length,
    titles: titleItems.length,
    duplicates: duplicateItems.length,
    stale: staleItems.length,
    capped: capItems.length,
    actionable: groups.reduce(
      (sum, group) => sum + (group.defaultSelected ? group.items.length : 0),
      0
    ),
    groups: groups.reduce((sum, group) => sum + group.items.length, 0),
  };

  return {
    ok: true,
    generatedAt: now,
    stalePresets: STALE_PRESETS,
    inventoryGeneratedAt: inventory.generatedAt ?? now,
    staleDays,
    keepPerWorkspace,
    keepPresets: KEEP_PRESETS,
    titleLimit: limit,
    settleMinutes: Math.round(settleMs / 60000),
    totals,
    workspaces: inventory.workspaces ?? [],
    groups,
  };
}

/** 把客户端提交的动作列表规整成可执行的原子动作。 */
export function normalizeActions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 200) continue;
    const kind = raw.kind === 'archive' || raw.kind === 'unarchive' || raw.kind === 'rename' ? raw.kind : '';
    if (!kind) continue;
    const key = `${kind}:${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (kind === 'rename') {
      const title = normalizeTitle(raw.title).slice(0, 120);
      if (!title) continue;
      if (isPlaceholder(title) && title.length < 2) continue;
      out.push({ kind, sessionId, title });
    } else {
      out.push({ kind, sessionId });
    }
  }
  return out.slice(0, 200);
}
