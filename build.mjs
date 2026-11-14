/**
 * 构建 lib/client.js：把 src/runtime/tidy.js 与 tidy.css 打包成
 * `window.__ModuleLoader__.load({ id, factory })` 脚本（DSH 客户端模块格式）。
 *
 * 零依赖：字符串拼接 + 缩进；产物可用 `node --check` 做语法检查。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME_FILE = path.join(ROOT, 'src/runtime/tidy.js');
const CSS_FILE = path.join(ROOT, 'src/runtime/tidy.css');
const OUT_DIR = path.join(ROOT, 'lib');
const OUT_FILE = path.join(OUT_DIR, 'client.js');
const MANIFEST_FILE = path.join(OUT_DIR, 'client.manifest.json');
const MODULE_ID = 'dsh-session-tidy';

function serialize(value) {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

const runtime = await readFile(RUNTIME_FILE, 'utf8');
const css = await readFile(CSS_FILE, 'utf8');
const indentedRuntime = runtime
  .split('\n')
  .map((line) => (line.length > 0 ? `    ${line}` : ''))
  .join('\n');

const bundle = `window.__ModuleLoader__.load({
  id: ${serialize(MODULE_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const CSS = ${serialize(css)};

${indentedRuntime}
    return module.exports;
  },
});
`;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, bundle, 'utf8');
await writeFile(
  MANIFEST_FILE,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      moduleId: MODULE_ID,
      cssBytes: Buffer.byteLength(css),
      runtimeBytes: Buffer.byteLength(runtime),
      bundleBytes: Buffer.byteLength(bundle),
    },
    null,
    2
  )}\n`,
  'utf8'
);

console.log(
  `[build] ${MODULE_ID}: client.js ${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KB ` +
    `(css ${(Buffer.byteLength(css) / 1024).toFixed(1)} KB)`
);
