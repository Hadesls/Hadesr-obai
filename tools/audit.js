/* obai 体检脚本（一次性静态审计，可长期复跑）
 *   node tools/audit.js
 *
 * 查的是"测试测不到、但线上会咬人"的那类问题：
 *   1. 代码里读了 settings.xxx，但 DEFAULT_SETTINGS 里没有 → undefined
 *   2. CSS 定义了但 JS 没用 / JS 用了但 CSS 没定义
 *   3. addEventListener 有、removeEventListener 没有 → 泄漏
 *   4. 顶层函数定义了却从没被调用 → 死代码
 *   5. 调试残留（console.log / debugger / TODO）
 *   6. 动作 id、命令 id 是否唯一
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let problems = 0;
function head(t) { console.log('\n=== ' + t + ' ==='); }
function bad(msg) { problems++; console.log('  ❌ ' + msg); }
function good(msg) { console.log('  ✅ ' + msg); }
function warn(msg) { console.log('  ⚠️  ' + msg); }

/* ---------- 1. settings 键 ---------- */
head('1. 设置项：代码里读的 vs 默认值里有的');
const defBlock = src.slice(src.indexOf('const DEFAULT_SETTINGS = {'));
const defBody = defBlock.slice(0, defBlock.indexOf('\n};'));
const defKeys = new Set();
defBody.replace(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm, function (m, k) { defKeys.add(k); return m; });

const used = new Set();
const delKeys = new Set();
src.replace(/delete\s+this\.settings\.([A-Za-z_$][\w$]*)/g, function (m, k) { delKeys.add(k); return m; });
src.replace(/\.settings\.([A-Za-z_$][\w$]*)/g, function (m, k) {
  if (!delKeys.has(k)) used.add(k);
  return m;
});
const missing = [...used].filter((k) => !defKeys.has(k));
if (missing.length) bad('读了但默认值里没有：' + missing.join(', '));
else good('代码里读的 ' + used.size + ' 个设置项都有默认值');

/* loadSettings 里补的键（老配置兼容） */
const inLoad = new Set();
src.replace(/this\.settings\.([A-Za-z_$][\w$]*)\s*=/g, function (m, k) { inLoad.add(k); return m; });
const notValidated = [...used].filter((k) => !inLoad.has(k));
if (notValidated.length) warn('没在 loadSettings 里做类型校验（不一定有问题）：' + notValidated.join(', '));

/* ---------- 2. CSS 双向 ---------- */
head('2. 样式类双向核对');
const cssClasses = new Set();
css.replace(/\.(obai-[a-z0-9-]+)/g, function (m, c) { cssClasses.add(c); return m; });
const jsClasses = new Set();
src.replace(/\b(obai-[a-z0-9-]+)\b/g, function (m, c) { jsClasses.add(c); return m; });
/* obai-v1 是加密标记 'hadesr-obai-v1|' 里的片段，不是类名 */
jsClasses.delete('obai-v1');
const cssOnly = [...cssClasses].filter((c) => !jsClasses.has(c));
const jsOnly = [...jsClasses].filter((c) => !cssClasses.has(c));
if (cssOnly.length) warn('CSS 有、JS 没用到（可能是给动态 class 用的，也可能真冗余）：' + cssOnly.join(', '));
else good('没有"定义了却没人用"的样式类');
if (jsOnly.length) bad('JS 用了但 CSS 没定义：' + jsOnly.join(', '));
else good('JS 用到的样式类都定义了');

/* ---------- 3. 事件监听配对 ---------- */
head('3. 事件监听配对');
const added = new Map(), removed = new Map();
/* 只统计 document.* / window.* —— 元素上的监听随元素一起回收，不会泄漏 */
src.replace(/(?:document|window)\s*\.\s*addEventListener\(\s*'([^']+)'/g, function (m, ev) { added.set(ev, (added.get(ev) || 0) + 1); return m; });
src.replace(/(?:document|window)\s*\.\s*removeEventListener\(\s*'([^']+)'/g, function (m, ev) { removed.set(ev, (removed.get(ev) || 0) + 1); return m; });
let leak = 0;
for (const [ev, n] of added) {
  const r = removed.get(ev) || 0;
  if (r < n) { leak++; warn("'" + ev + "' 加了 " + n + " 次、只解绑 " + r + ' 次'); }
}
if (!leak) good('每个 addEventListener 都有对应的 removeEventListener');

/* ---------- 4. 死代码 ---------- */
head('4. 顶层函数是否被调用');
const dead = [];
src.replace(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm, function (m, name) {
  const count = (src.match(new RegExp('\\b' + name + '\\s*\\(', 'g')) || []).length;
  if (count <= 1) dead.push(name);
  return m;
});
if (dead.length) warn('定义了但没被调用：' + dead.join(', '));
else good('没有死函数');

/* ---------- 5. 调试残留 ---------- */
head('5. 调试残留');
const logs = (src.match(/console\.log\s*\(/g) || []).length;
const debugs = (src.match(/console\.debug\s*\(/g) || []).length;
const warns = (src.match(/console\.warn\s*\(/g) || []).length;
const dbg = (src.match(/\bdebugger\b/g) || []).length;
const todos = (src.match(/\b(?:TODO|FIXME|XXX)\b/g) || []).length;
console.log('  console.log=' + logs + '  debug=' + debugs + '  warn=' + warns);
if (dbg) bad('有 debugger 残留');
else good('没有 debugger');
if (logs > 0) warn('有 ' + logs + ' 处 console.log');
if (todos) warn('有 ' + todos + ' 处 TODO/FIXME');

/* ---------- 6. id 唯一性 ---------- */
head('6. 动作 / 命令 id 唯一性');
const actionIds = [];
const actBlock = src.slice(src.indexOf('const ACTIONS = ['), src.indexOf('/* ============================ 接口格式'));
actBlock.replace(/id:\s*'([^']+)'/g, function (m, id) { actionIds.push(id); return m; });
const dupAct = actionIds.filter((x, i) => actionIds.indexOf(x) !== i);
if (dupAct.length) bad('动作 id 重复：' + dupAct.join(', '));
else good('内置动作 ' + actionIds.length + ' 个，id 全部唯一');

const cmdIds = [];
src.replace(/addCommand\(\{\s*id:\s*'([^']+)'/g, function (m, id) { cmdIds.push(id); return m; });
const dupCmd = cmdIds.filter((x, i) => cmdIds.indexOf(x) !== i);
if (dupCmd.length) bad('命令 id 重复：' + dupCmd.join(', '));
else good('命令 ' + cmdIds.length + ' 个，id 全部唯一');

/* ---------- 7. 定时器 ---------- */
head('7. 定时器');
const setT = (src.match(/setTimeout\s*\(/g) || []).length;
const clrT = (src.match(/clearTimeout\s*\(/g) || []).length;
const setI = (src.match(/setInterval\s*\(/g) || []).length;
console.log('  setTimeout=' + setT + '  clearTimeout=' + clrT + '  setInterval=' + setI);
if (setI > 0) warn('有 setInterval，确认是否有对应 clear');
else good('没有 setInterval');

/* ---------- 8. manifest ---------- */
head('8. manifest');
const folderName = path.basename(ROOT);
if (manifest.id === folderName) good('id = ' + manifest.id + '（与文件夹名一致）');
else bad('id 与文件夹名不一致：' + manifest.id + ' ≠ ' + folderName);
if (manifest.description.length <= 180) good('描述 ' + manifest.description.length + ' 字（不糊屏）');
else bad('描述过长：' + manifest.description.length);
console.log('  版本 = ' + manifest.version);

console.log('\n' + (problems ? '⚠️  ' + problems + ' 个问题需要处理' : '🎉 体检通过'));
process.exit(problems ? 1 : 0);
