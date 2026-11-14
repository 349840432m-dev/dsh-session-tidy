/**
 * 规则单测：标题清洗 + 整理计划（node verify/plan.test.mjs）。
 * 全部是纯函数，不读写真实 ~/.dsh。
 */
import assert from 'node:assert/strict';

import { clipTitle, condensePrompt, exactKey, proposeTitle, titleIssues, uniqueTitle } from '../lib/tidy/titles.js';
import { buildPlan, normalizeActions } from '../lib/tidy/plan.js';
import { scanInventory, sessionIdOf, sessionKey } from '../lib/tidy/inventory.js';
import { idVariants } from '../lib/index.js';

const NOW = Date.UTC(2026, 10, 13, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

function row(patch) {
  return {
    key: patch.sessionId.replace(/^session-/, ''),
    sessionId: patch.sessionId,
    title: '',
    createdAt: NOW - 10 * DAY,
    lastPromptAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    blank: false,
    turns: 3,
    steps: 5,
    open: false,
    cwd: '/tmp/work',
    firstPrompt: '做一个一键整理对话的插件',
    workspaceId: 'ws-1',
    workspaceTitle: 'dsh-test',
    workspacePath: '/tmp/work',
    archived: false,
    pinned: false,
    ...patch,
  };
}

/* ---------- 标题清洗 ---------- */

assert.equal(condensePrompt(''), '');
assert.equal(
  condensePrompt('你是一位读者测试者。现在只做一件事：读一篇中文新闻成稿，然后只凭这篇成稿回答 4 个问题。'),
  '读一篇中文新闻成稿，然后只凭这篇成稿回答 4 个问题'
);
assert.equal(
  condensePrompt('请帮我用 React 写一个登录页，要求：\n```js\nconsole.log(1)\n```\n支持暗色模式'),
  '帮我用 React 写一个登录页，要求'
);
assert.equal(condensePrompt('https://example.com/a 这个页面为什么白屏'), '这个页面为什么白屏');
assert.ok(condensePrompt('   \n\n  ').length === 0);

assert.deepEqual(titleIssues('干净的标题'), []);
assert.deepEqual(titleIssues('你是一名没有上下文背景的读者'), ['preamble']);
assert.deepEqual(titleIssues('新会话'), ['placeholder']);
assert.deepEqual(titleIssues(''), ['empty']);
assert.ok(titleIssues('对一个 Python Flask 项目的「后台」做一次代码评审，检查接口与权限').includes('truncated') === false);

const long = '这是一段非常长的标题'.repeat(10);
assert.ok(clipTitle(long, 30).length <= 30 * 1.5 + 2, '截断后不超过字符上限');
assert.ok(!clipTitle(long, 30).endsWith('。'));
assert.ok(!clipTitle(`${long}…`, 30).endsWith('…'));

// 角色设定从句只切到第一个逗号，保留后面的任务句
assert.equal(
  condensePrompt('你是一名没有上下文背景的读者，正在参与一次"成稿可独立阅读性"测试。\n\n规则：…'),
  '正在参与一次"成稿可独立阅读性"测试'
);
// 去掉 markdown 强调符
assert.equal(
  condensePrompt('你是一名严格的中文新闻编辑，对下面这份已完成的中文稿件做一次**对抗性逻辑审查**。'),
  '对下面这份已完成的中文稿件做一次对抗性逻辑审查'
);
// 清洗后仍是通用指令：不给建议，保留原标题
assert.equal(
  proposeTitle({
    title: '你是一名没有上下文的读者测试者',
    firstPrompt: '你是一名没有上下文的读者测试者，你只能看到下面这一篇成稿，不能联网搜索。',
  }),
  null
);

// sessionId 形态：宿主用裸 uuid，旧记录带 session- 前缀
assert.equal(sessionIdOf('f30dffbd-0c83-4b40-9c43-40829f84d7af'), 'f30dffbd-0c83-4b40-9c43-40829f84d7af');
assert.equal(sessionIdOf('orchestrator-abc'), 'orchestrator-abc');
assert.equal(sessionKey('session-f30dffbd-0c83-4b40-9c43-40829f84d7af.json'), 'f30dffbd-0c83-4b40-9c43-40829f84d7af');
assert.deepEqual(idVariants('abc'), ['abc', 'session-abc']);
assert.deepEqual(idVariants('session-abc'), ['session-abc', 'abc']);
assert.equal(typeof scanInventory, 'function');

const used = new Set(['会话']);
assert.equal(uniqueTitle('会话', used), '会话（2）');
used.add(exactKey('会话（2）'));
assert.equal(uniqueTitle('会话', used), '会话（3）');
assert.equal(exactKey('会话（2）'), '会话（2）');

/* ---------- 整理计划 ---------- */

const inventory = {
  generatedAt: NOW,
  workspaces: [{ id: 'ws-1', title: 'dsh-test', path: '/tmp/work', sessionCount: 6 }],
  stats: { sessions: 8, archived: 1, pinned: 1, blank: 2 },
  rows: [
    // 刚创建的空会话：落在 30 分钟镇静窗口内，不动
    row({ sessionId: 'session-blank-recent', blank: true, turns: 0, firstPrompt: '', updatedAt: NOW - 1 * MIN }),
    // 陈旧的空会话：归档
    row({
      sessionId: 'session-blank-old',
      blank: true,
      turns: 0,
      firstPrompt: '',
      title: '',
      updatedAt: NOW - 3 * DAY,
    }),
    // 置顶空会话：不动
    row({
      sessionId: 'session-blank-pinned',
      blank: true,
      turns: 0,
      firstPrompt: '',
      pinned: true,
      updatedAt: NOW - 9 * DAY,
    }),
    // 已归档：不再处理
    row({
      sessionId: 'session-blank-archived',
      blank: true,
      turns: 0,
      firstPrompt: '',
      archived: true,
      updatedAt: NOW - 9 * DAY,
    }),
    // 角色设定开头：清洗
    row({
      sessionId: 'session-preamble-1',
      title: '你是一位读者测试者。现在只做一件事：读一篇中文新闻成稿，然后只凭这篇成稿回答 4 个问题。',
      firstPrompt: '你是一位读者测试者。现在只做一件事：读一篇中文新闻成稿，然后只凭这篇成稿回答 4 个问题。',
      updatedAt: NOW - 1 * DAY,
    }),
    // 同样的提示词：重名补齐
    row({
      sessionId: 'session-preamble-2',
      title: '你是一位读者测试者。现在只做一件事：读一篇中文新闻成稿，然后只凭这篇成稿回答 4 个问题。',
      firstPrompt: '你是一位读者测试者。现在只做一件事：读一篇中文新闻成稿，然后只凭这篇成稿回答 4 个问题。',
      updatedAt: NOW - 2 * DAY,
    }),
    // 干净的重名标题：默认不勾选
    row({ sessionId: 'session-dup-1', title: '哈喽', updatedAt: NOW - 1 * DAY }),
    row({ sessionId: 'session-dup-2', title: '哈喽', updatedAt: NOW - 4 * DAY }),
    // 长期未活动
    row({ sessionId: 'session-stale', title: '旧项目排查', updatedAt: NOW - 200 * DAY }),
    // 置顶的陈旧会话：不动
    row({ sessionId: 'session-stale-pinned', title: '置顶旧会话', pinned: true, updatedAt: NOW - 200 * DAY }),
  ],
};

const plan = buildPlan(inventory, { now: NOW });
const byId = Object.fromEntries(plan.groups.map((group) => [group.id, group]));

assert.ok(byId.blank, '应产出空白会话分组');
assert.deepEqual(
  byId.blank.items.map((item) => item.sessionId).sort(),
  ['session-blank-old'],
  '只归档过了镇静窗口、未置顶、未归档的空会话'
);

assert.ok(byId.titles && byId.titles.items.length === 2, '两条角色设定标题都应被清洗');
const titles = byId.titles.items.map((item) => item.nextTitle);
assert.equal(new Set(titles).size, 2, '同批标题必须唯一');
assert.ok(titles.every((title) => !title.includes('你是一位读者测试者')), '清洗后不应保留角色设定开头');

assert.ok(byId.duplicates, '应产出重名分组');
assert.equal(byId.duplicates.defaultSelected, false, '重名分组默认不勾选');
assert.ok(byId.duplicates.items.every((item) => item.nextTitle.includes('（2）')));

assert.ok(byId.stale, '应产出陈旧分组');
assert.equal(byId.stale.defaultSelected, true, '陈旧分组默认勾选（可用面板档位切换天数）');
assert.deepEqual(byId.stale.items.map((item) => item.sessionId), ['session-stale']);

// 当前打开的会话即使空白也要保留
const guarded = buildPlan(inventory, { now: NOW, protectedIds: ['session-blank-old'] });
const guardedItems = guarded.groups.flatMap((group) => group.items);
assert.ok(!guardedItems.some((item) => item.sessionId === 'session-blank-old'), '当前会话必须被保护');
assert.equal(guarded.totals.subagent, 0);

assert.equal(
  plan.totals.actionable,
  byId.blank.items.length + byId.titles.items.length + byId.stale.items.length,
  '默认可整理数 = 默认勾选组之和'
);

// 档位可调：放宽到 365 天后，200 天未活动的会话不再属于「陈旧」
const relaxed = buildPlan(inventory, { now: NOW, staleDays: 365 });
assert.ok(!relaxed.groups.some((group) => group.id === 'stale'), 'staleDays 调大后不再建议归档该会话');
assert.equal(plan.totals.archived, 1);

/* 动作规整 */
assert.deepEqual(normalizeActions([{ kind: 'rename', sessionId: 'session-a', title: '  新 标题  ' }]), [
  { kind: 'rename', sessionId: 'session-a', title: '新 标题' },
]);
assert.equal(normalizeActions([{ kind: 'rename', sessionId: 'session-a', title: '   ' }]).length, 0);
assert.equal(normalizeActions([{ kind: 'bogus', sessionId: 'session-a' }]).length, 0);
assert.equal(
  normalizeActions([
    { kind: 'archive', sessionId: 'session-a' },
    { kind: 'archive', sessionId: 'session-a' },
  ]).length,
  1,
  '同一会话同一动作去重'
);

console.log('plan.test.mjs: ok');
