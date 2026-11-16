/*
 * dsh-session-tidy · 浏览器半边运行时
 *
 * 由 build.mjs 拼进 lib/client.js：运行时可访问 React 与 CSS。
 * 职责：
 *   1. conversation.input.dock —— 输入框上方常驻「整理会话」按钮 + 可整理计数；
 *   2. shell.overlay —— 帧级浮层：预览整理建议、逐组/逐条勾选、一键应用、整批撤销；
 *   3. 只调用同源 `/session-tidy-api`，不直接触碰宿主存储。
 */

const API_BASE = '/session-tidy-api';
const DOCK_ID = 'session-tidy';
const OVERLAY_ID = 'session-tidy-overlay';
const STYLE_ID = 'dsh-session-tidy-style';
const PLAN_TTL_MS = 60_000;
const APPLY_CHUNK = 6;

const h = React.createElement;

/* ------------------------------------------------------------------ */
/* 文案                                                               */
/* ------------------------------------------------------------------ */

const TEXT = {
  chip: '整理会话',
  chipBusy: '整理中…',
  chipClean: '会话列表已整理干净',
  chipCount: '{n} 项可整理',
  chipLoading: '读取会话清单…',
  chipError: '读取失败',
  title: '会话整理',
  subtitle: '归档空白会话、清洗标题、区分重名。只改标题与归档状态，可整批撤销。',
  close: '关闭',
  loading: '正在读取本机会话清单…',
  empty: '没有需要整理的会话。',
  emptyHint: '空白会话、过长或被截断的标题、重名标题都会出现在这里。',
  sessions: '会话',
  subagentSkipped: '已跳过 {n} 个子代理会话（它们只挂在父会话下，侧栏不单独列出）',
  archivedLabel: '已归档',
  blank: '空白',
  titles: '标题',
  duplicates: '重名',
  stale: '陈旧',
  stalePresetLabel: '最后活动早于',
  keepLabel: '每个工作区保留最近',
  keepOff: '关闭',
  keepUnit: '{n} 条',
  keepOnlyCurrent: '只留当前',
  apply: '一键整理',
  applyN: '一键整理 · {n} 项',
  applyIdle: '勾选后整理',
  applying: '正在整理 {done}/{total}…',
  cancel: '取消',
  undo: '撤销上次整理',
  undoBusy: '正在撤销…',
  undoDone: '已撤销 {n} 项',
  done: '已整理 {n} 项',
  doneDetail: '改名 {renames} · 归档 {archives}',
  failed: '{n} 项失败',
  retry: '重试',
  refresh: '重新扫描',
  expand: '展开全部 {n} 项',
  collapse: '收起',
  nothingSelected: '还没有勾选任何条目',
  noUndo: '没有可撤销的整理',
  selected: '{n}/{total} 选中',
  renameArrow: '改为',
  reasonPlaceholder: '占位标题',
  reasonPreamble: '角色设定开头',
  reasonNoise: '含代码/链接',
  reasonMultiline: '含换行',
  reasonTruncated: '被截断',
  reasonTooLong: '过长',
  reasonDuplicate: '重名',
  reasonBlank: '没有提示词',
  reasonStale: '{d} 天未活动',
  workspace: '工作区',
  unknownWorkspace: '未归属工作区',
  generated: '扫描于 {time}',
  scopeNote: '不含已归档与子代理会话；5 分钟内还在活动的会话会跳过；当前打开的会话始终保留。',
  sourceNote: '数据来自本机 ~/.dsh 会话投影缓存，不联网。',
};

const STALE_KEY = 'dsh-session-tidy.staleDays';
const KEEP_KEY = 'dsh-session-tidy.keepPerWorkspace';
const STALE_FALLBACK = [1, 3, 7, 14, 30, 90];
const KEEP_FALLBACK = [0, 1, 3, 5, 8, 12];

function readStaleDays() {
  try {
    const value = Number(window.localStorage.getItem(STALE_KEY));
    return Number.isFinite(value) && value >= 1 && value <= 365 ? value : 7;
  } catch {
    return 7;
  }
}

function writeStaleDays(days) {
  try {
    window.localStorage.setItem(STALE_KEY, String(days));
  } catch {
    /* 隐私模式忽略 */
  }
}

function readKeep() {
  try {
    const value = Number(window.localStorage.getItem(KEEP_KEY));
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 5;
  } catch {
    return 5;
  }
}

function writeKeep(value) {
  try {
    window.localStorage.setItem(KEEP_KEY, String(value));
  } catch {
    /* 隐私模式忽略 */
  }
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars && vars[key] !== undefined ? String(vars[key]) : ''));
}

const REASON_TEXT = {
  blank: TEXT.reasonBlank,
  duplicate: TEXT.reasonDuplicate,
  placeholder: TEXT.reasonPlaceholder,
  preamble: TEXT.reasonPreamble,
  noise: TEXT.reasonNoise,
  multiline: TEXT.reasonMultiline,
  truncated: TEXT.reasonTruncated,
  too_long: TEXT.reasonTooLong,
};

function reasonLabel(item) {
  if (item.reason === 'stale') return fill(TEXT.reasonStale, { d: item.staleDays || 90 });
  if (item.reason === 'blank') return TEXT.reasonBlank;
  const parts = String(item.reason || '')
    .split('+')
    .filter(Boolean)
    .map((code) => REASON_TEXT[code] || code);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* 状态仓库（两个挂载点共享）                                          */
/* ------------------------------------------------------------------ */

const store = {
  state: {
    open: false,
    loading: false,
    refreshing: false,
    plan: null,
    currentSessionId: '',
    staleDays: readStaleDays(),
    keepPerWorkspace: readKeep(),
    error: null,
    selected: new Set(),
    applying: false,
    progress: null,
    result: null,
    undoAvailable: false,
    undoing: false,
    notice: null,
  },
  listeners: new Set(),
};

function emit() {
  for (const listener of store.listeners) {
    try {
      listener(store.state);
    } catch {
      /* 单个订阅失败不影响其它 */
    }
  }
}

function patch(next) {
  store.state = { ...store.state, ...next };
  emit();
}

function subscribe(listener) {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

function useStore() {
  const [snapshot, setSnapshot] = React.useState(store.state);
  React.useEffect(() => {
    const dispose = subscribe(setSnapshot);
    setSnapshot(store.state);
    return dispose;
  }, []);
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* 数据请求                                                           */
/* ------------------------------------------------------------------ */

let planFetchedAt = 0;

async function request(pathname, options = {}) {
  const headers = { 'x-dsh-session-tidy': '1' };
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${API_BASE}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || (data && data.ok === false)) {
    const message = (data && data.error) || `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return data || {};
}

function itemId(item) {
  return `${item.action}:${item.sessionId}`;
}

function defaultSelection(plan) {
  const selected = new Set();
  for (const group of plan.groups || []) {
    if (!group.defaultSelected) continue;
    for (const item of group.items || []) selected.add(itemId(item));
  }
  return selected;
}

async function loadPlan(options = {}) {
  const refresh = Boolean(options.refresh);
  if (!refresh && store.state.plan && Date.now() - planFetchedAt < PLAN_TTL_MS) return store.state.plan;
  if (!refresh) patch({ loading: !store.state.plan, error: null });
  else patch({ refreshing: true, error: null });
  try {
    const query = [];
    if (refresh) query.push('refresh=1');
    if (store.state.currentSessionId) query.push(`current=${encodeURIComponent(store.state.currentSessionId)}`);
    if (store.state.staleDays) query.push(`staleDays=${store.state.staleDays}`);
    if (Number(store.state.keepPerWorkspace) > 0) query.push(`keep=${store.state.keepPerWorkspace}`);
    const [plan, undo] = await Promise.all([
      request(`/plan${query.length ? `?${query.join('&')}` : ''}`),
      request('/undo').catch(() => ({ batches: [] })),
    ]);
    planFetchedAt = Date.now();
    const selection = defaultSelection(plan);
    const previous = store.state.selected;
    // 刷新后尽量保留用户的选择：新旧交集
    const kept = new Set([...selection].filter((id) => previous.size === 0 || previous.has(id)));
    patch({
      plan,
      loading: false,
      refreshing: false,
      selected: refresh && previous.size > 0 ? kept : selection,
      undoAvailable: Boolean(undo && undo.lastUndoable),
      error: null,
    });
    return plan;
  } catch (error) {
    patch({ loading: false, refreshing: false, error: error.message });
    throw error;
  }
}

async function loadUndo() {
  try {
    const undo = await request('/undo');
    patch({ undoAvailable: Boolean(undo.lastUndoable) });
  } catch {
    /* 账本读取失败不阻塞主流程 */
  }
}

function selectedGroups() {
  const plan = store.state.plan;
  if (!plan) return [];
  return (plan.groups || [])
    .map((group) => ({
      group,
      items: (group.items || []).filter((item) => store.state.selected.has(itemId(item))),
    }))
    .filter((entry) => entry.items.length > 0);
}

function selectedCount() {
  return selectedGroups().reduce((sum, entry) => sum + entry.items.length, 0);
}

function actionsOf(entries) {
  const actions = [];
  for (const entry of entries) {
    for (const item of entry.items) {
      if (item.action === 'rename') actions.push({ kind: 'rename', sessionId: item.sessionId, title: item.nextTitle });
      else actions.push({ kind: 'archive', sessionId: item.sessionId });
    }
  }
  return actions;
}

async function applySelected() {
  const entries = selectedGroups();
  const actions = actionsOf(entries);
  if (actions.length === 0) {
    patch({ notice: TEXT.nothingSelected });
    return;
  }

  const batchId = `tidy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  let done = 0;
  let renames = 0;
  let archives = 0;
  let failed = 0;
  const failures = [];

  patch({ applying: true, result: null, notice: null, progress: { done: 0, total: actions.length } });

  try {
    for (let index = 0; index < actions.length; index += APPLY_CHUNK) {
      const chunk = actions.slice(index, index + APPLY_CHUNK);
      const response = await request('/apply', { method: 'POST', body: { batchId, actions: chunk } });
      done += response.applied || 0;
      failed += response.failed || 0;
      for (const result of response.results || []) {
        if (!result.ok) {
          failures.push(result.error || '未知错误');
          continue;
        }
        if (result.kind === 'rename') renames += 1;
        else archives += 1;
      }
      patch({ progress: { done: Math.min(index + chunk.length, actions.length), total: actions.length } });
    }

    patch({
      applying: false,
      progress: null,
      result: {
        applied: done,
        failed,
        renames,
        archives,
        errors: [...new Set(failures)].slice(0, 3),
        at: Date.now(),
      },
      undoAvailable: done > 0,
    });
    planFetchedAt = 0;
    await loadPlan({ refresh: true });
  } catch (error) {
    patch({ applying: false, progress: null, error: error.message });
  }
}

async function undoLast() {
  if (store.state.undoing) return;
  patch({ undoing: true, notice: null });
  try {
    const response = await request('/undo', { method: 'POST', body: {} });
    patch({
      undoing: false,
      undoAvailable: false,
      result: null,
      notice: fill(TEXT.undoDone, { n: response.restored || 0 }),
    });
    planFetchedAt = 0;
    await loadPlan({ refresh: true });
  } catch (error) {
    patch({ undoing: false, error: error.message });
  }
}

function toggleItem(id) {
  const selected = new Set(store.state.selected);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  patch({ selected, notice: null });
}

function toggleGroup(group) {
  const ids = (group.items || []).map(itemId);
  const selected = new Set(store.state.selected);
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  for (const id of ids) {
    if (all) selected.delete(id);
    else selected.add(id);
  }
  patch({ selected, notice: null });
}

function setStaleDays(days) {
  if (!Number.isFinite(days) || days < 1) return;
  writeStaleDays(days);
  patch({ staleDays: days, notice: null });
  planFetchedAt = 0;
  loadPlan({ refresh: true }).catch(() => {});
}

function setKeep(value) {
  if (!Number.isFinite(value) || value < 0) return;
  writeKeep(value);
  patch({ keepPerWorkspace: value, notice: null });
  planFetchedAt = 0;
  loadPlan({ refresh: true }).catch(() => {});
}

function setOpen(open) {
  patch({ open, notice: null });
  if (open) {
    loadPlan({ refresh: !store.state.plan }).catch(() => {});
    loadUndo();
  }
}

/* ------------------------------------------------------------------ */
/* 图标                                                               */
/* ------------------------------------------------------------------ */

function TidyGlyph(props) {
  const size = props && props.size ? props.size : 16;
  return h(
    'svg',
    {
      className: 'st-glyph',
      width: size,
      height: size,
      viewBox: '0 0 20 20',
      fill: 'none',
      'aria-hidden': 'true',
    },
    h('path', {
      d: 'M3.2 5.2h8.2M3.2 9.9h5.4M3.2 14.6h6.8',
      stroke: 'currentColor',
      strokeWidth: '1.6',
      strokeLinecap: 'round',
    }),
    h('path', {
      d: 'M13.4 8.2l1.5 1.5 3-3.2',
      stroke: 'currentColor',
      strokeWidth: '1.6',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    h('circle', { cx: '15.1', cy: '13.6', r: '2.6', stroke: 'currentColor', strokeWidth: '1.4' }),
    h('path', { d: 'M15.1 12.3v1.4l1 .6', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' })
  );
}

function Chevron(props) {
  return h(
    'svg',
    {
      className: props && props.open ? 'st-chev st-chev--open' : 'st-chev',
      width: '12',
      height: '12',
      viewBox: '0 0 12 12',
      'aria-hidden': 'true',
    },
    h('path', { d: 'M3 4.5L6 7.5l3-3', stroke: 'currentColor', strokeWidth: '1.4', 'fill-rule': 'evenodd', strokeLinecap: 'round', strokeLinejoin: 'round' })
  );
}

/* ------------------------------------------------------------------ */
/* 格式化                                                             */
/* ------------------------------------------------------------------ */

function formatDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return sameYear ? `${month}-${day}` : `${String(date.getFullYear()).slice(2)}-${month}-${day}`;
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours()
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 常驻入口（输入框上方）                                              */
/* ------------------------------------------------------------------ */

function DockEntry(props) {
  const state = useStore();
  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';

  React.useEffect(() => {
    const changed = Boolean(sessionId) && store.state.currentSessionId !== sessionId;
    if (changed) patch({ currentSessionId: sessionId });
    loadPlan({ refresh: changed }).catch(() => {});
    // 只在挂载/切换会话时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const plan = state.plan;
  const count = plan ? plan.totals.actionable : 0;
  let label = TEXT.chipLoading;
  if (state.applying) label = TEXT.chipBusy;
  else if (state.error && !plan) label = TEXT.chipError;
  else if (plan) label = count > 0 ? fill(TEXT.chipCount, { n: count }) : TEXT.chipClean;

  return h(
    'div',
    { className: 'st-dock' },
    h(
      'button',
      {
        type: 'button',
        className: 'st-chip' + (count > 0 ? ' st-chip--active' : ''),
        onClick: () => setOpen(!state.open),
        'aria-expanded': state.open ? 'true' : 'false',
        'aria-label': TEXT.title,
        title: plan ? TEXT.subtitle : label,
      },
      h(TidyGlyph, { size: 15 }),
      h('span', { className: 'st-chip-label' }, TEXT.chip),
      count > 0 ? h('span', { className: 'st-chip-badge' }, count > 99 ? '99+' : String(count)) : null
    ),
    h('span', { className: 'st-chip-note' }, label)
  );
}

/* ------------------------------------------------------------------ */
/* 浮层                                                               */
/* ------------------------------------------------------------------ */

function SummaryStrip(props) {
  const plan = props.plan;
  const totals = plan.totals || {};
  const cells = [
    { key: 'sessions', label: TEXT.sessions, value: totals.sessions },
    { key: 'archived', label: TEXT.archivedLabel, value: totals.archived },
    { key: 'blank', label: TEXT.blank, value: totals.blank },
    { key: 'titles', label: TEXT.titles, value: totals.titles },
    { key: 'duplicates', label: TEXT.duplicates, value: totals.duplicates },
    { key: 'stale', label: TEXT.stale, value: totals.stale },
  ];
  return h(
    'div',
    { className: 'st-summary' },
    cells.map((cell) =>
      h(
        'div',
        { className: 'st-summary-cell', key: cell.key },
        h('span', { className: 'st-summary-value' }, String(cell.value ?? 0)),
        h('span', { className: 'st-summary-label' }, cell.label)
      )
    )
  );
}

function TitleChange(props) {
  const item = props.item;
  return h(
    'div',
    { className: 'st-title-change' },
    h('span', { className: 'st-title-old' }, item.title),
    h('span', { className: 'st-arrow', 'aria-hidden': 'true' }, '→'),
    h('span', { className: 'st-title-new' }, item.nextTitle)
  );
}

function ItemRow(props) {
  const item = props.item;
  const selected = props.selected;
  const meta = [item.workspace || TEXT.unknownWorkspace, formatDate(item.updatedAt)];
  return h(
    'label',
    { className: 'st-item' + (selected ? ' st-item--on' : '') },
    h('input', {
      type: 'checkbox',
      className: 'st-check',
      checked: selected,
      onChange: () => toggleItem(itemId(item)),
    }),
    h(
      'div',
      { className: 'st-item-body' },
      item.action === 'rename' ? h(TitleChange, { item }) : h('div', { className: 'st-item-title' }, item.title),
      h(
        'div',
        { className: 'st-item-meta' },
        h('span', { className: 'st-reason' }, reasonLabel(item)),
        meta.map((value, index) => [h('span', { className: 'st-dot', key: `d${index}` }, '·'), h('span', { key: `m${index}` }, value)])
      )
    )
  );
}

function PresetChip(props) {
  return h(
    'button',
    {
      type: 'button',
      className: 'st-preset' + (props.active ? ' st-preset--on' : ''),
      onClick: props.onClick,
      'aria-pressed': props.active ? 'true' : 'false',
    },
    props.label
  );
}

function SettingsBar(props) {
  const state = props.state;
  const plan = props.plan || {};
  // 宿主版本可能比页面旧：用本地档位做并集，刷新页面就能拿到新档位
  const stalePresets = [...new Set([...(plan.stalePresets || []), ...STALE_FALLBACK])].sort((a, b) => a - b);
  const keepPresets = [...new Set([...(plan.keepPresets || []), ...KEEP_FALLBACK])].sort((a, b) => a - b);

  return h(
    'div',
    { className: 'st-settings' },
    h(
      'div',
      { className: 'st-setting' },
      h('span', { className: 'st-setting-label' }, TEXT.keepLabel),
      keepPresets.map((value) =>
        h(PresetChip, {
          key: `keep-${value}`,
          label: value === 0 ? TEXT.keepOff : value === 1 ? TEXT.keepOnlyCurrent : fill(TEXT.keepUnit, { n: value }),
          active: Number(state.keepPerWorkspace) === value,
          onClick: () => setKeep(value),
        })
      )
    ),
    h(
      'div',
      { className: 'st-setting' },
      h('span', { className: 'st-setting-label' }, TEXT.stalePresetLabel),
      stalePresets.map((value) =>
        h(PresetChip, {
          key: `stale-${value}`,
          label: `${value} 天`,
          active: Number(state.staleDays) === value,
          onClick: () => setStaleDays(value),
        })
      )
    )
  );
}

function Group(props) {
  const group = props.group;
  const selected = props.selected;
  const [expanded, setExpanded] = React.useState(false);
  const items = group.items || [];
  const chosen = items.filter((item) => selected.has(itemId(item))).length;
  const all = items.length > 0 && chosen === items.length;
  const visible = expanded ? items : items.slice(0, 6);
  const groupId = `st-group-${group.id}`;

  return h(
    'section',
    { className: 'st-group' + (chosen > 0 ? ' st-group--on' : ''), 'aria-labelledby': groupId },
    h(
      'header',
      { className: 'st-group-head' },
      h('input', {
        type: 'checkbox',
        className: 'st-check',
        checked: all,
        ref: (node) => {
          if (node) node.indeterminate = chosen > 0 && !all;
        },
        onChange: () => toggleGroup(group),
        'aria-label': group.title,
      }),
      h(
        'div',
        { className: 'st-group-copy' },
        h(
          'div',
          { className: 'st-group-title', id: groupId },
          h('span', null, group.title),
          h('span', { className: 'st-group-count' }, `${chosen}/${items.length}`)
        ),
        h('p', { className: 'st-group-hint' }, group.hint)
      )
    ),
    h(
      'div',
      { className: 'st-items' },
      visible.map((item) => h(ItemRow, { key: itemId(item), item, selected: selected.has(itemId(item)) }))
    ),
    items.length > 6
      ? h(
          'button',
          { type: 'button', className: 'st-link', onClick: () => setExpanded(!expanded) },
          h(Chevron, { open: expanded }),
          expanded ? TEXT.collapse : fill(TEXT.expand, { n: items.length })
        )
      : null
  );
}

function Overlay() {
  const state = useStore();
  const panelRef = React.useRef(null);

  React.useEffect(() => {
    if (!state.open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.open]);

  if (!state.open) return null;

  const plan = state.plan;
  const count = selectedCount();
  const busy = state.applying || state.undoing;

  return h(
    'div',
    {
      className: 'st-overlay',
      role: 'presentation',
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) setOpen(false);
      },
    },
    h(
      'div',
      {
        className: 'st-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': TEXT.title,
        ref: panelRef,
      },
      h(
        'header',
        { className: 'st-head' },
        h(
          'div',
          { className: 'st-head-copy' },
          h('span', { className: 'st-eyebrow' }, h(TidyGlyph, { size: 13 }), 'SESSION TIDY'),
          h('h2', { className: 'st-title' }, TEXT.title),
          h('p', { className: 'st-subtitle' }, TEXT.subtitle)
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'st-icon-btn',
            onClick: () => setOpen(false),
            'aria-label': TEXT.close,
            title: TEXT.close,
          },
          h(
            'svg',
            { width: '14', height: '14', viewBox: '0 0 14 14', 'aria-hidden': 'true' },
            h('path', {
              d: 'M3 3l8 8M11 3l-8 8',
              stroke: 'currentColor',
              strokeWidth: '1.5',
              strokeLinecap: 'round',
            })
          )
        )
      ),

      plan ? h(SummaryStrip, { plan }) : null,
      plan && plan.totals && plan.totals.subagent > 0
        ? h('p', { className: 'st-subagent-note' }, fill(TEXT.subagentSkipped, { n: plan.totals.subagent }))
        : null,

      h(
        'div',
        { className: 'st-body' },
        state.error
          ? h(
              'div',
              { className: 'st-banner st-banner--error', role: 'alert' },
              h('span', null, state.error),
              h('button', { type: 'button', className: 'st-link', onClick: () => loadPlan({ refresh: true }).catch(() => {}) }, TEXT.retry)
            )
          : null,

        state.notice ? h('div', { className: 'st-banner st-banner--info', role: 'status' }, state.notice) : null,

        state.result
          ? h(
              'div',
              { className: 'st-banner st-banner--ok', role: 'status' },
              h(
                'div',
                { className: 'st-banner-copy' },
                h('strong', null, fill(TEXT.done, { n: state.result.applied })),
                h(
                  'span',
                  null,
                  fill(TEXT.doneDetail, { renames: state.result.renames, archives: state.result.archives }) +
                    (state.result.failed > 0 ? ` · ${fill(TEXT.failed, { n: state.result.failed })}` : '')
                ),
                state.result.errors && state.result.errors.length > 0
                  ? h('span', { className: 'st-banner-note' }, state.result.errors.join(' / '))
                  : null
              ),
              h(
                'button',
                { type: 'button', className: 'st-btn st-btn--ghost', onClick: undoLast, disabled: busy },
                TEXT.undo
              )
            )
          : null,

        state.loading
          ? h(
              'div',
              { className: 'st-loading' },
              h('div', { className: 'st-skel' }),
              h('div', { className: 'st-skel st-skel--short' }),
              h('p', { className: 'st-muted' }, TEXT.loading)
            )
          : null,

        plan && !state.loading ? h(SettingsBar, { plan, state }) : null,

        plan && !state.loading
          ? plan.groups.length === 0
            ? h(
                'div',
                { className: 'st-empty' },
                h('div', { className: 'st-empty-icon' }, h(TidyGlyph, { size: 22 })),
                h('p', { className: 'st-empty-title' }, TEXT.empty),
                h('p', { className: 'st-muted' }, TEXT.emptyHint)
              )
            : h(
                'div',
                { className: 'st-groups' },
                plan.groups.map((group) =>
                  h(Group, { key: group.id, group, selected: state.selected })
                )
              )
          : null,

        state.applying && state.progress
          ? h(
              'div',
              { className: 'st-progress' },
              h(
                'div',
                { className: 'st-progress-head' },
                h('span', null, fill(TEXT.applying, { done: state.progress.done, total: state.progress.total }))
              ),
              h(
                'div',
                { className: 'st-progress-track' },
                h('div', {
                  className: 'st-progress-bar',
                  style: { width: `${Math.round((state.progress.done / Math.max(1, state.progress.total)) * 100)}%` },
                })
              )
            )
          : null
      ),

      h(
        'footer',
        { className: 'st-foot' },
        h(
          'div',
          { className: 'st-foot-left' },
          h(
            'button',
            {
              type: 'button',
              className: 'st-btn st-btn--ghost',
              onClick: undoLast,
              disabled: busy || !state.undoAvailable,
              title: state.undoAvailable ? TEXT.undo : TEXT.noUndo,
            },
            state.undoing ? TEXT.undoBusy : TEXT.undo
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'st-btn st-btn--ghost',
              onClick: () => {
                planFetchedAt = 0;
                loadPlan({ refresh: true }).catch(() => {});
              },
              disabled: busy || state.refreshing,
            },
            state.refreshing ? TEXT.loading : TEXT.refresh
          )
        ),
        h(
          'div',
          { className: 'st-foot-right' },
          h('span', { className: 'st-foot-note' }, plan ? fill(TEXT.generated, { time: formatTime(plan.generatedAt) }) : ''),
          h('button', { type: 'button', className: 'st-btn', onClick: () => setOpen(false), disabled: busy }, TEXT.cancel),
          h(
            'button',
            {
              type: 'button',
              className: 'st-btn st-btn--primary',
              onClick: applySelected,
              disabled: busy || count === 0,
            },
            count > 0 ? fill(TEXT.applyN, { n: count }) : TEXT.applyIdle
          )
        )
      ),
      h(
        'p',
        { className: 'st-foot-hint' },
        `${TEXT.scopeNote} ${TEXT.sourceNote}`
      )
    )
  );
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                           */
/* ------------------------------------------------------------------ */

const inject = ['slots'];

function injectStyles() {
  if (typeof document === 'undefined') return () => {};
  if (document.getElementById(STYLE_ID)) return () => {};
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-dsh-session-tidy-style', '');
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => {
    if (style.isConnected) style.remove();
  };
}

function apply(ctx) {
  const removeStyles = injectStyles();
  ctx.effect(() => () => removeStyles(), 'session-tidy: styles');

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: 'conversation.input.dock', id: DOCK_ID, order: 20 }, DockEntry)
  );

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: 40 }, Overlay)
  );

  ctx.effect(() => {
    window.__DSH_SESSION_TIDY__ = {
      dockId: DOCK_ID,
      overlayId: OVERLAY_ID,
      apiBase: API_BASE,
      components: { DockEntry, Overlay },
      open: () => setOpen(true),
      close: () => setOpen(false),
      plan: () => (store.state.plan ? store.state.plan : loadPlan({ refresh: true })),
    };
    return () => {
      delete window.__DSH_SESSION_TIDY__;
    };
  }, 'session-tidy: automation hook');
}

exports.apply = apply;
exports.inject = inject;
