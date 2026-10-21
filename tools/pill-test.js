/* 验证 0.17.0 的三项改动：
 *   ① 翻译动作在胶囊上显示「翻译成中文 / 翻译成英文」
 *   ② 上次动作只存内存（_lastActionId），settings 里不再有 lastAction
 *   ③ 插件对外显示名 = Hadesr AI，id = obai
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* 用法：node tools/pill-test.js   （放在插件目录下的 tools/ 里，自动找到上级目录） */
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/* ---------- 假的 obsidian 模块 ---------- */
function fakeEl(tag) {
  const el = {
    tag: tag || 'div', textContent: '', title: '', value: '',
    style: {}, dataset: {}, children: [], parent: null,
    _classes: new Set(),
    classList: {
      add: function () { for (const c of arguments) el._classes.add(c); },
      remove: function () { for (const c of arguments) el._classes.delete(c); },
      toggle: function () {}, contains: function (c) { return el._classes.has(c); }
    },
    createEl(t, o) {
      o = o || {};
      const c = fakeEl(typeof t === 'string' ? t : 'div');
      if (o.text) c.textContent = o.text;
      if (o.cls) String(o.cls).split(' ').forEach(function (x) { c.classList.add(x); });
      if (o.title) c.title = o.title;
      if (o.href) c.href = o.href;
      el.children.push(c); c.parent = el;
      return c;
    },
    createDiv(o) { return el.createEl('div', o); },
    createSpan(o) { return el.createEl('span', o); },
    setText(t) { el.textContent = String(t); return el; },
    empty() { el.children = []; return el; },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter(function (x) { return x !== c; }); return c; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    focus() {}, blur() {}, click() {}, remove() {}, scrollTo() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 100, top: 100, right: 200, bottom: 140, width: 100, height: 40 }; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    insertBefore(c) { el.children.push(c); return c; },
    matches() { return false; }, closest() { return null; },
    contains() { return false; },
    get innerHTML() { return ''; }, set innerHTML(v) {}
  };
  return el;
}
const obsidian = {
  Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = fakeEl('div'); } },
  Setting: class {
    constructor(c) { this.containerEl = c; this.el = fakeEl('div'); this.info = fakeEl('div'); }
    setName() { return this; } setDesc() { return this; } setClass() { return this; }
    setHeading() { return this; } addText() { return this; } addTextArea() { return this; }
    addToggle() { return this; } addDropdown() { return this; } addSlider() { return this; }
    addButton() { return this; } addExtraButton() { return this; } then() { return this; }
    setTooltip() { return this; }
  },
  Notice: class { constructor(m) { this.message = m; } setMessage(m) { this.message = m; } hide() {} },
  Modal: class { constructor(app) { this.app = app; this.contentEl = fakeEl('div'); this.modalEl = fakeEl('div'); this.titleEl = fakeEl('div'); } open() {} close() {} },
  Menu: class {
    constructor() { this.items = []; }
    addItem(cb) { const it = { setTitle() { return it; }, setIcon() { return it; }, onClick() { return it; }, setSubmenu() { return new obsidian.Menu(); }, setSection() { return it; } }; cb(it); this.items.push(it); return this; }
    addSeparator() { return this; } showAtMouseEvent() {} showAtPosition() {} close() {}
    setParentElement() { return this; }
  },
  MarkdownView: class {},
  requestUrl: async function () { return { json: {}, status: 200 }; },
  setIcon: function () {},
  MarkdownRenderer: { renderMarkdown: function () {} },
  FuzzySuggestModal: class { constructor(app) { this.app = app; this.inputEl = fakeEl('input'); this.resultContainerEl = fakeEl('div'); } open() {} close() {} },
  TFile: class {}, TFolder: class {},
  debounce: function (f) { return f; }
};

/* ---------- 在沙箱里跑 main.js，把需要的符号掏出来 ---------- */
const sandbox = {
  require: function (n) { if (n === 'obsidian') return obsidian; throw new Error('no module ' + n); },
  module: { exports: {} }, exports: {}, __filename: 'main.js', __dirname: ROOT,
  globalThis: null, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  Promise, fetch: function () { return Promise.resolve({ ok: false }); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  TextEncoder, TextDecoder, Buffer, process, URL, crypto: { getRandomValues: function (a) { return a; } }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const withExport = src + '\n;globalThis.__T = { ACTIONS: ACTIONS, allActions: allActions,'
  + ' SelectionBubble: SelectionBubble, DEFAULT_SETTINGS: DEFAULT_SETTINGS,'
  + ' ObaiPlugin: module.exports, BASE_SYSTEM: BASE_SYSTEM, ResultCard: ResultCard };\n';
try {
  vm.runInContext(withExport, sandbox, { filename: 'main.js' });
} catch (e) {
  console.log('✗ 加载 main.js 失败：' + e.message);
  process.exit(1);
}
const T = sandbox.__T;

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → 实际：' + extra : '')); }
}

console.log('\n=== ① 翻译动作在胶囊上的文案 ===');
const zh = T.ACTIONS.filter(function (a) { return a.id === 'trans-zh'; })[0];
const en = T.ACTIONS.filter(function (a) { return a.id === 'trans-en'; })[0];
ok(zh && zh.pill === '翻译成中文', 'trans-zh 的胶囊文案 = 翻译成中文', zh && zh.pill);
ok(en && en.pill === '翻译成英文', 'trans-en 的胶囊文案 = 翻译成英文', en && en.pill);
ok(zh && zh.name === '中文', '菜单/选项里仍叫「中文」（不带"译成"）', zh && zh.name);
ok(en && en.name === '英文', '菜单/选项里仍叫「英文」', en && en.name);
ok(T.ACTIONS.length === 16, '内置动作共 16 个', String(T.ACTIONS.length));
const other = T.ACTIONS.filter(function (a) { return a.pill && a.id.indexOf('trans-') !== 0; });
ok(other.length === 0, '只有翻译两项有 pill（其余用 name）', JSON.stringify(other.map(function (a) { return a.id; })));

console.log('\n=== ② 上次动作只存内存，不落盘 ===');
const src2 = src;
ok(!/settings\.lastAction/.test(src2), '代码里不再读写 settings.lastAction');
ok(!/lastAction:/.test(T.DEFAULT_SETTINGS ? JSON.stringify(T.DEFAULT_SETTINGS) : ''), 'DEFAULT_SETTINGS 里没有 lastAction 字段');
ok(/this\._lastActionId\s*=\s*action\.id/.test(src2), '_dispatch 记录到 _lastActionId（内存）');
ok(!/this\._lastActionId\s*=\s*action\.id[\s\S]{0,200}saveSettings/.test(src2), '记录时没有跟着 saveSettings（所以不会落盘）');

/* 真的实例化胶囊看看渲染结果 */
const settings = JSON.parse(JSON.stringify(T.DEFAULT_SETTINGS));
const plugin = Object.create(T.ObaiPlugin.prototype);
plugin.settings = settings;
plugin._lastActionId = '';

const bubble = new T.SelectionBubble(plugin);
bubble.toolEl = fakeEl('span');
bubble.mainBtn = fakeEl('button');

/* 场景 A：刚打开软件，还没用过 —— 只显示 AI */
plugin._lastActionId = '';
bubble._refreshLabel();
ok(bubble.toolEl.textContent === '', '刚启动：工具名为空（胶囊只剩 ✦ AI）', JSON.stringify(bubble.toolEl.textContent));
ok(bubble.mainBtn.title === '选择要执行的动作', '刚启动：提示 = 选择要执行的动作', bubble.mainBtn.title);

/* 场景 B：用过翻译中文 */
plugin._lastActionId = 'trans-zh';
bubble._refreshLabel();
ok(bubble.toolEl.textContent === '翻译成中文', '用过翻译中文 → 胶囊显示「翻译成中文」', bubble.toolEl.textContent);
ok(/执行「翻译成中文」/.test(bubble.mainBtn.title), '悬停提示 = 执行「翻译成中文」（点 ▾ 换别的）', bubble.mainBtn.title);

/* 场景 C：用过翻译英文 */
plugin._lastActionId = 'trans-en';
bubble._refreshLabel();
ok(bubble.toolEl.textContent === '翻译成英文', '用过翻译英文 → 胶囊显示「翻译成英文」', bubble.toolEl.textContent);

/* 场景 D：用过润色（没有 pill，用 name） */
plugin._lastActionId = 'polish';
bubble._refreshLabel();
ok(bubble.toolEl.textContent === '润色', '用过润色 → 胶囊显示「润色」', bubble.toolEl.textContent);

/* 场景 E：自定义动作 */
/* 注意：自定义动作在 settings 里存的提示词字段叫 system，不是 instruction */
settings.customActions = [{ id: 'my-x', name: '改写成诗', icon: 'pencil', system: '改写成一首诗' }];
plugin._lastActionId = 'my-x';
bubble._refreshLabel();
ok(bubble.toolEl.textContent === '改写成诗', '自定义动作也能记住', JSON.stringify(bubble.toolEl.textContent));
/* 反证：字段写错的脏数据不该被采纳 */
settings.customActions = [{ id: 'my-y', name: '坏数据', icon: 'pencil' }];
plugin._lastActionId = 'my-y';
bubble._refreshLabel();
ok(bubble.toolEl.textContent === '', '缺提示词的坏数据不会显示出来（回退成空）', JSON.stringify(bubble.toolEl.textContent));

/* 场景 F：模拟重启 —— 新实例 = 又变回空 */
const fresh = Object.create(T.ObaiPlugin.prototype);
fresh.settings = JSON.parse(JSON.stringify(T.DEFAULT_SETTINGS));
fresh._lastActionId = '';
const bubble2 = new T.SelectionBubble(fresh);
bubble2.toolEl = fakeEl('span');
bubble2.mainBtn = fakeEl('button');
bubble2._refreshLabel();
ok(bubble2.toolEl.textContent === '', '重启后（新实例）：胶囊又只剩 ✦ AI', JSON.stringify(bubble2.toolEl.textContent));

console.log('\n=== ③ 插件身份 ===');
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const dirName = require('path').basename(require('path').join(__dirname, '..'));
ok(mf.id === dirName, 'id 与文件夹名一致（' + dirName + '，否则加载不了）', mf.id);
ok(mf.name === 'Hadesr AI', '显示名 = Hadesr AI', mf.name);
ok(/^\d+\.\d+\.\d+$/.test(mf.version), '版本号是三段式', mf.version);
/* 2026-10-18 用户要求：介绍太长，缩短到社区列表里不糊屏 */
ok(mf.description.length <= 180, '介绍不超过 180 字', mf.description.length);
ok(/行内补全/.test(mf.description) && /Tab/.test(mf.description), '介绍里提到行内补全与 Tab');

console.log('\n=== ④ 结果卡的「AI 正在…」标题 ===');
/* 直接调 ResultCard.prototype.showLoading，只给它需要的那几个字段 */
function titleFor(action) {
  const fake = {
    el: fakeEl('div'),
    titleEl: fakeEl('div'),
    body: fakeEl('div'),
    bar: fakeEl('div'),
    opts: { actionName: action.doing || action.name },
    _place: function () {}
  };
  T.ResultCard.prototype.showLoading.call(fake);
  return fake.titleEl.textContent;
}
ok(titleFor({ id: 'trans-zh', name: '中文', doing: '翻译成中文' }) === 'AI 正在翻译成中文',
  '翻译成中文 → 「AI 正在翻译成中文」', titleFor({ id: 'x', name: '中文', doing: '翻译成中文' }));
ok(titleFor({ id: 'trans-en', name: '英文', doing: '翻译成英文' }) === 'AI 正在翻译成英文',
  '翻译成英文 → 「AI 正在翻译成英文」');
ok(titleFor({ id: 'totable', name: '转表格', doing: '转成表格' }) === 'AI 正在转成表格',
  '转成表格 → 「AI 正在转成表格」');
ok(titleFor({ id: 'polish', name: '润色' }) === 'AI 正在润色',
  '没写 doing 的动作退回 name（润色）', titleFor({ id: 'polish', name: '润色' }));
ok(titleFor({}) === 'AI 正在生成', '既没 actionName 也没 name → 「AI 正在生成」', titleFor({}));

/* 拿真实的 16 个动作 + 自定义动作逐个看标题 */
const bad = [];
T.ACTIONS.forEach(function (a) {
  const t = titleFor(a);
  if (/^AI 正在$/.test(t)) bad.push(a.id + ' → 空');
  if (/正在(中文|英文)$/.test(t)) bad.push(a.id + ' → ' + t + '（读不通）');
  if (!a.doing && a.id.indexOf('trans-') === 0) bad.push(a.id + ' → 翻译动作缺 doing');
});
ok(bad.length === 0, '16 个动作的标题都读得通', bad.join(' / '));

const customs = T.allActions({ customActions: [{ id: 'c1', name: '改写成诗', system: 'x' }] })
  .filter(function (a) { return a.custom; });
ok(titleFor(customs[0]) === 'AI 正在改写成诗', '自定义动作也能拼出标题', titleFor(customs[0]));

console.log('\n=== ⑤ 顺带回归 ===');
ok(/如果你会输出思考过程，也请用中文写/.test(T.BASE_SYSTEM), '思考过程要求用中文');
ok(/offsetof|getBoundingClientRect/.test(src2), '胶囊定位用的是位置计算');

console.log('\n' + (fail === 0 ? '🎉 全部通过（' + pass + ' 项）' : '⚠️ ' + fail + ' 项未通过（共 ' + pass + ' 项通过）'));
process.exit(fail === 0 ? 0 : 1);
