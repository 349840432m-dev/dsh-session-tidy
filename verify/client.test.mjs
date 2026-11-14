/**
 * 客户端产物单测：在最小 DOM/React 垫片上执行 lib/client.js，
 * 验证模块格式、插槽注册与自动化钩子（node verify/client.test.mjs）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

const created = [];
const effects = [];
const injections = [];
const registrations = [];
const styleNodes = [];

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  Fragment: 'Fragment',
};

const document = {
  getElementById: () => null,
  createElement: (tag) => {
    const node = {
      tag,
      id: '',
      attributes: {},
      style: {},
      textContent: '',
      isConnected: false,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      remove() {
        this.isConnected = false;
      },
    };
    created.push(node);
    return node;
  },
  head: {
    appendChild(node) {
      node.isConnected = true;
      styleNodes.push(node);
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

let loaded = null;
const window = {
  __ModuleLoader__: {
    load(record) {
      loaded = record;
    },
  },
};

vm.runInNewContext(bundle, { window, document, console, fetch: async () => ({ ok: true, json: async () => ({}) }) });

assert.ok(loaded, '模块应通过 window.__ModuleLoader__.load 注册');
assert.equal(loaded.id, 'dsh-session-tidy');
assert.equal(typeof loaded.factory, 'function');

const module = loaded.factory((name) => {
  assert.equal(name, 'react', '客户端只应 require react');
  return React;
});

assert.equal(typeof module.apply, 'function');
assert.equal(module.inject.length, 1);
assert.equal(module.inject[0], 'slots');

const ctx = {
  effect: (factory, label) => {
    effects.push({ dispose: typeof factory === 'function' ? factory() : undefined, label });
    return () => {};
  },
  slots: {
    inject: (name, callback) => {
      injections.push(name);
      callback();
      return () => {};
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

module.apply(ctx);

assert.deepEqual(
  injections.sort(),
  ['conversation.input.dock', 'shell.overlay'],
  '应只注入输入框上方与帧级浮层两个插槽'
);
assert.equal(registrations.length, 2);
const dock = registrations.find((entry) => entry.options.name === 'conversation.input.dock');
const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay');
assert.ok(dock, '应注册输入框上方入口');
assert.equal(dock.options.id, 'session-tidy');
assert.equal(typeof dock.component, 'function');
assert.ok(overlay, '应注册帧级浮层');
assert.equal(overlay.options.id, 'session-tidy-overlay');

assert.equal(styleNodes.length, 1, '样式只注入一次');
assert.ok(styleNodes[0].textContent.includes('.st-overlay'), '样式表应包含浮层规则');

const hook = window.__DSH_SESSION_TIDY__;
assert.ok(hook, '应暴露自动化钩子');
assert.equal(hook.apiBase, '/session-tidy-api');
assert.equal(typeof hook.open, 'function');

// 组件必须是可渲染的函数（不真正渲染，仅检查签名）
assert.equal(typeof hook.components.DockEntry, 'function');
assert.equal(typeof hook.components.Overlay, 'function');

console.log('client.test.mjs: ok');
