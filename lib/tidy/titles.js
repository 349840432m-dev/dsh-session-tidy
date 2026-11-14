/**
 * 标题清洗：DSH 的自动标题本质是「首条提示词的截断前缀」，常见问题是
 * 被截成半句、带换行/代码块/URL、以「你是一个…」这类角色设定开头。
 *
 * 这里只做确定性的清洗，不做语义改写：
 *   1. 去掉代码块、行内代码、XML 标签、URL、绝对路径；
 *   2. 取第一条有意义的文本行；
 *   3. 去掉「你是一个 / 请扮演 / 假设你是…」之类前置设定；
 *   4. 压平空白，按句读或长度上限截断（保留完整词）。
 */

export const TITLE_LIMIT = 30;

const PLACEHOLDER =
  /^(新会话|新的会话|新对话|未命名会话?|无标题|untitled|new chat|new session|session|chat|会话|对话)$/i;

const PREAMBLE =
  /^(?:你是一个?|你是一位|你是一名|你作为一个?|你作为|请你?扮演|请扮演|你现在是|假设你是|作为一个|扮演一个|请你?充当|请你?担任)[^。！？!?，,、；;\n]{0,48}[。！？!?，,、；;]\s*/;

/** 只看开头的角色设定，不要求完整句子（标题常被截断）。 */
const PREAMBLE_PREFIX =
  /^(?:你是一个?|你是一位|你是一名|你作为一个?|你作为|请你?扮演|请扮演|你现在是|假设你是|作为一个|扮演一个|请你?充当|请你?担任)/;

/** 角色设定之后常见的「任务引导语」，本身没有信息量。 */
const TASK_LEAD =
  /^(?:现在|接下来|首先|然后)?\s*(?:只做|需要你?做|要你?做|请做|完成|执行|回答|阅读|阅读并回答|看|查看)?\s*(?:如下|以下|下面|这)?\s*(?:一|两|三|四|五|几|\d+)?\s*(?:件事|个任务|个步骤|项任务)\s*[：:，,、。.!！]?\s*/;

const LEAD_IN = /^(?:请|帮我|帮忙|麻烦|我想|我需要|我要|能否|能不能|可以帮我|可不可以)\s*/;

const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]{1,120}`/g;
const XML_TAG = /<[^>\n]{1,60}>/g;
const URL_RE = /https?:\/\/[^\s）)]+/g;
const ABS_PATH = /(?:^|[\s（(])(?:\/[\w.@+\-\u4e00-\u9fff～·]+){2,}(?=[\s）)]|$)/g;
const MD_HEADING = /^#{1,6}\s*/gm;
const MD_LIST = /^\s*(?:[-*+]|\d+[.)])\s+/gm;
const MD_QUOTE = /^\s*>\s?/gm;
const MD_EMPHASIS = /\*\*|__|~~|(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])/g;
const ELLIPSIS_TAIL = /(?:…+|\.{3,}|。{2,})$/;

const SENTENCE_END = /[。！？!?；;]/;

/** 通用指令开头：这类文本不是「这件事是什么」，不该拿来当标题。 */
const GENERIC_LEAD =
  /^(?:忽略|只(?:依据|根据|使用|回答|做|读|看|需要|需)|根据|依据|按照|不要|不得|注意|以下|下面|规则|回答|阅读|读取|打开|运行|完成|执行|确保|给出|列出|禁止|始终|永远|现在|接下来|开始|你(?:只能|只|需要|必须|应该))/;

/** CJK / 全角算 2 个显示宽度，用于「看起来差不多长」的判断。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return width;
}

export function normalizeTitle(text) {
  let s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^["'“”‘’「」『』【】\s]+/, '').replace(/["'“”‘’「」『』】\s]+$/, '');
  return s;
}

export function isPlaceholder(title) {
  return PLACEHOLDER.test(normalizeTitle(title));
}

/** 归一化后的比较键：去空白、标点、序号后缀，用于判断「重名」。 */
export function titleKey(title) {
  return exactKey(title).replace(/[（(]\d+[）)]$/, '');
}

/** 只做大小写与标点归一，保留序号后缀；判断「完全同名」用。 */
export function exactKey(title) {
  return normalizeTitle(title)
    .toLowerCase()
    .replace(/[\s·・,，.。:：;；!！?？'"“”‘’\-—_/\\|]+/g, '');
}

/**
 * 标题问题清单。返回空数组表示「干净」。
 * 取值：empty / placeholder / preamble / multiline / noise / truncated / too_long
 */
export function titleIssues(title, limit = TITLE_LIMIT) {
  const raw = String(title ?? '');
  const clean = normalizeTitle(raw);
  if (!clean) return ['empty'];
  if (isPlaceholder(clean)) return ['placeholder'];

  const issues = [];
  if (PREAMBLE_PREFIX.test(clean)) issues.push('preamble');
  if (/\n/.test(raw.trim())) issues.push('multiline');
  if (/```|`[^`\n]{3,}`|https?:\/\/|<[^>\n]{1,60}>/.test(raw)) issues.push('noise');
  if (ELLIPSIS_TAIL.test(clean)) issues.push('truncated');
  if (displayWidth(clean) > limit * 2 || clean.length > limit * 1.5) issues.push('too_long');
  return issues;
}

export function needsRewrite(title, limit = TITLE_LIMIT) {
  return titleIssues(title, limit).length > 0;
}

/** 从提示词里压出一句可当标题的文本；失败返回 ''。 */
export function condensePrompt(prompt, limit = TITLE_LIMIT) {
  let text = String(prompt ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';

  text = text
    .replace(FENCE, '\n')
    .replace(INLINE_CODE, ' ')
    .replace(XML_TAG, ' ')
    .replace(URL_RE, ' ')
    .replace(ABS_PATH, ' ');

  const lines = text
    .replace(MD_EMPHASIS, '')
    .replace(MD_HEADING, '')
    .replace(MD_LIST, '')
    .replace(MD_QUOTE, '')
    .split('\n')
    .map((line) => normalizeTitle(line))
    .filter((line) => line.length >= 2 && !/^[\s:：\-—=+*#|]+$/.test(line));

  if (lines.length === 0) return '';

  let first = lines[0];
  const stripped = first.replace(PREAMBLE, '');
  if (stripped !== first && stripped.length >= 2) {
    first = stripped;
    const lead = first.replace(TASK_LEAD, '');
    if (lead !== first && lead.length >= 2) first = lead;
  } else {
    const lead = first.replace(TASK_LEAD, '');
    if (lead !== first && lead.length >= 2) first = lead;
  }
  if (isPlaceholder(first) && lines.length > 1) first = lines[1];

  first = first.replace(LEAD_IN, '').trim();
  if (!first) return '';

  return clipTitle(first, limit);
}

/** 去掉标题末尾的句号、逗号与省略号；问号/感叹号保留。 */
function trimTail(text) {
  return String(text)
    .replace(ELLIPSIS_TAIL, '')
    .replace(/[\s,，、.:：;；。\-—_/\\|]+$/, '')
    .trim();
}

/** 在句读或词边界处截断，不留下半截英文单词或悬挂标点。 */
export function clipTitle(text, limit = TITLE_LIMIT) {
  let s = normalizeTitle(text).replace(/^[-—·:：]\s*/, '');
  const maxWidth = limit * 2;
  const maxChars = Math.ceil(limit * 1.5);
  const fits = (value) => displayWidth(value) <= maxWidth && value.length <= maxChars;

  if (fits(s)) return trimTail(s);

  // 优先在句读处收尾（至少保留四成内容）
  let best = -1;
  for (let i = 0; i < s.length; i += 1) {
    if (SENTENCE_END.test(s[i]) && displayWidth(s.slice(0, i)) >= limit) {
      best = i;
      break;
    }
  }
  if (best >= 0) s = s.slice(0, best);

  // 其次在逗号/顿号处收尾，避免半个分句
  if (!fits(s)) {
    let clause = -1;
    let width = 0;
    for (let i = 0; i < s.length; i += 1) {
      width += displayWidth(s[i]);
      if (width > maxWidth) break;
      if (/[，,、;；]/.test(s[i]) && width >= maxWidth * 0.6) clause = i;
    }
    if (clause > 0) s = s.slice(0, clause);
  }

  if (!fits(s)) {
    let cut = '';
    for (const ch of s) {
      const next = cut + ch;
      if (!fits(next)) break;
      cut = next;
    }
    // 别把英文单词切一半
    if (/[A-Za-z0-9]$/.test(cut) && /[A-Za-z0-9]/.test(s[cut.length] ?? '')) {
      const trimmed = cut.replace(/[A-Za-z0-9]+$/, '').trimEnd();
      if (trimmed.length >= 4) cut = trimmed;
    }
    s = cut;
  }

  return trimTail(s);
}

/** 兜底标题：工作区名 + 日期。 */
export function fallbackTitle(row) {
  const workspace = normalizeTitle(row?.workspaceTitle || '');
  const when = Number.isFinite(row?.updatedAt) && row.updatedAt > 0 ? new Date(row.updatedAt) : new Date();
  const stamp = `${String(when.getMonth() + 1).padStart(2, '0')}${String(when.getDate()).padStart(2, '0')}`;
  if (workspace && !PLACEHOLDER.test(workspace)) return clipTitle(`${workspace} · ${stamp}`, TITLE_LIMIT);
  return `会话 · ${stamp}`;
}

/**
 * 为一个会话给出「整理后的标题」。
 * @returns {{title: string, reason: string} | null} null = 不需要改
 */
export function proposeTitle(row, options = {}) {
  const limit = options.limit ?? TITLE_LIMIT;
  const used = options.used ?? new Set();
  const issues = titleIssues(row.title, limit);
  if (issues.length === 0) return null;

  const base =
    condensePrompt(row.firstPrompt, limit) ||
    (isPlaceholder(row.title) ? '' : clipTitle(row.title, limit)) ||
    fallbackTitle(row);

  const cleaned = clipTitle(base, limit);
  if (!cleaned || cleaned.length < 2) return null;
  // 清洗后仍是「通用指令」而不是「这件事是什么」：保留原标题，不做低价值改写
  if (GENERIC_LEAD.test(cleaned)) return null;

  // 清洗后与原文相同（只差省略号/空白）时算作低价值改动，除非原文档位很差。
  const current = normalizeTitle(row.title).replace(ELLIPSIS_TAIL, '').trim();
  const trivial = current && cleaned === current && !issues.some((i) => i === 'placeholder' || i === 'preamble' || i === 'noise');
  if (trivial) return null;

  return { title: uniqueTitle(cleaned, used, limit), reason: issues.join('+') };
}

/** 在同批标题里保证唯一：冲突时追加（2）（3）…。 */
export function uniqueTitle(base, used, limit = TITLE_LIMIT) {
  if (!used.has(exactKey(base))) return base;
  const stem = clipTitle(base, Math.max(6, limit - 3)).replace(ELLIPSIS_TAIL, '').replace(/[（(]\d+[）)]$/, '');
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${stem}（${n}）`;
    if (!used.has(exactKey(candidate))) return candidate;
  }
  return `${stem}（${Date.now() % 1000}）`;
}
