/* 模拟 Obsidian 的加载过程：new Plugin → loadSettings() → onload()
 * 目的：把"插件加载失败"这类问题在本地复现出来（Node 里能看到真实堆栈）
 * 用法：node tools/load-test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

/* ---------------- 极简 DOM ---------------- */
function el(tag) {
  const e = {
    tag: tag || 'div', textContent: '', className: '', title: '', value: '',
    style: {}, dataset: {}, children: [], _cl: new Set(),
    contains() { return false; },   /* 假元素：永远"不包含"，模拟点在外面 */
    classList: {
      add() { for (const c of arguments) e._cl.add(c); },
      remove() { for (const c of arguments) e._cl.delete(c); },
      toggle() {}, contains(c) { return e._cl.has(c); }
    },
    createEl(t, o) {
      o = o || {}; const c = el(typeof t === 'string' ? t : 'div');
      if (o.text) c.textContent = o.text;
      if (o.cls) String(o.cls).split(' ').forEach((x) => c.classList.add(x));
      e.children.push(c); c.parent = e; return c;
    },
    createDiv(o) { return e.createEl('div', o); },
    createSpan(o) { return e.createEl('span', o); },
    setText(t) { e.textContent = String(t); return e; },
    empty() { e.children = []; return e; },
    appendChild(c) { e.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, click() {}, remove() {}, scrollTo() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    insertBefore(c) { e.children.push(c); return c; }, matches() { return false; }, closest() { return null; }
  };
  return e;
}
const documentStub = {
  createElement: el, createElementNS: el,
  addEventListener() {}, removeEventListener() {},
  body: el('body'), head: el('head'), documentElement: el('html'),
  querySelector() { return null; }, querySelectorAll() { return []; }
};

/* ---------------- 假 obsidian ---------------- */
class FakePlugin {
  constructor(app, manifest) {
    this.app = app; this.manifest = manifest;
    this._data = JSON.parse(JSON.stringify(data));
    this._registered = { commands: [], ribbons: [], extensions: [], settingsTabs: [], events: [] };
  }
  async loadData() { return this._data; }
  async saveData(d) { this._data = d; }
  addRibbonIcon() { this._registered.ribbons.push(1); }
  addCommand(c) { this._registered.commands.push(c); }
  addSettingTab(t) { this._registered.settingsTabs.push(t); }
  registerEvent() { this._registered.events.push(1); }
  registerDomEvent() {}
  registerInterval() {}
  registerEditorExtension(e) { this._registered.extensions.push(e); }
}

const loadtestNotices = [];
const obsidian = {
  Plugin: FakePlugin,
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = el('div'); } },
  Setting: class {
    constructor(c) { this.containerEl = c; }
    setName(n) {
      /* 把名字真的写进假 DOM，测试才能断言某个设置项渲染出来了 */
      try { this.containerEl.createEl('div', { text: String(n), cls: 'setting-item-name' }); } catch (e) { }
      return this;
    }
    setDesc() { return this; } setClass() { return this; }
    setHeading() { return this; } addText() { return this; } addTextArea() { return this; }
    addToggle() { return this; } addDropdown() { return this; } addSlider() { return this; }
    addButton() { return this; } addExtraButton() { return this; } then() { return this; }
    setTooltip() { return this; } setValue() { return this; } setLimits() { return this; }
    setDynamicTooltip() { return this; }
  },
  Notice: class { constructor(m) { this.message = m; loadtestNotices.push(String(m || '')); } setMessage(m) { this.message = m; } hide() {} },
  Modal: class {
    constructor(app) { this.app = app; this.contentEl = el('div'); this.modalEl = el('div'); this.titleEl = el('div'); }
    open() {} close() {}
  },
  Menu: class {
    constructor() { this.items = []; (obsidian.Menu.all || (obsidian.Menu.all = [])).push(this); }
    addItem(cb) {
      const it = {
        title: '',
        setTitle(t) { it.title = String(t); return it; },
        setIcon() { return it; }, onClick() { return it; },
        setSubmenu() { return new obsidian.Menu(); }, setSection() { return it; },
        setDisabled() { return it; }
      };
      cb(it); this.items.push(it); return this;
    }
    addSeparator() { return this; } showAtMouseEvent() {} showAtPosition() {} close() {} setParentElement() { return this; }
  },
  MarkdownView: class {},
  requestUrl: async function () { return { json: {}, status: 200 }; },
  setIcon() {},
  MarkdownRenderer: { renderMarkdown() {} },
  FuzzySuggestModal: class { constructor(app) { this.app = app; this.inputEl = el('input'); this.resultContainerEl = el('div'); } open() {} close() {} },
  debounce(f) { return f; }
};

/* ---------------- 假 CodeMirror（形状要跟真的一致，否则测不出问题） ---------------- */
function facet() {
  const f = { id: 'facet' + Math.random() };
  f.of = () => ({ facet: f, value: null });
  f.compute = (deps, fn) => ({ facet: f, deps: deps, compute: fn });
  f.from = (field) => ({ facet: f, from: field });
  return f;
}
const view = {
  EditorView: {
    decorations: facet(),
    theme: () => ({}),
    baseTheme: () => ({}),
    updateListener: facet(),
  },
  Decoration: {
    none: [],
    set: (ranges) => ranges,
    widget: (spec) => ({ range: (pos) => ({ from: pos, to: pos, spec: spec }) }),
    replace: () => ({ range: (from, to) => ({ from: from, to: to }) }),
    mark: () => ({ range: (from, to) => ({ from: from, to: to }) }),
  },
  WidgetType: class { toDOM() { return documentStub.createElement('span'); } ignoreEvent() { return true; } },
  ViewPlugin: { fromClass: (cls, spec) => ({ cls: cls, spec: spec }) },
  keymap: { of: (b) => ({ bindings: b }) },
};
const state = {
  StateField: { define: (spec) => ({ spec: spec, id: 'field' + Math.random() }) },
  StateEffect: { define: () => ({ is: () => false }) },
  Prec: { highest: (x) => x, lowest: (x) => x },
  EditorState: { selection: facet(), create: () => ({}) },
  RangeSet: { of: () => [] },
  Text: { of: () => ({}) },
};

const sandbox = {
  require: function (n) {
    if (n === 'obsidian') return obsidian;
    if (n === '@codemirror/view') return view;
    if (n === '@codemirror/state') return state;
    throw new Error("Cannot find module '" + n + "'");
  },
  module: { exports: {} }, exports: {}, __filename: 'main.js', __dirname: ROOT,
  document: documentStub, window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 },
  globalThis: null, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, isFinite,
  Map, Set, WeakMap, Symbol,
  fetch: function () { return Promise.resolve({ ok: false }); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  TextEncoder, TextDecoder, Buffer, process, URL, crypto: { getRandomValues: (a) => a },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' })
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* 和 Obsidian 一样：模块只求值一次，异常会直接冒出来 */
let ObaiPlugin;
try {
  vm.runInContext(src + '\n;globalThis.__X = { RewriteBox: RewriteBox, ResultCard: ResultCard, PROVIDER_EXTRA_TARGETS: PROVIDER_EXTRA_TARGETS, QUICK_TARGET: QUICK_TARGET, ActionMenu: ActionMenu, pushChatHistory: pushChatHistory, CHAT_HISTORY_MAX: CHAT_HISTORY_MAX, ObaiSettingTab: ObaiSettingTab, BatchPanel: BatchPanel, normalizeSegmentOut: normalizeSegmentOut, expandToParagraph: expandToParagraph, locateMatches: locateMatches, QuickAsk: QuickAsk, diffLines: diffLines, compactDiffOps: compactDiffOps, buildOutline: buildOutline, outlineText: outlineText, focusText: focusText, setDebug: setDebug, dlog: dlog, DEFAULT_SETTINGS: DEFAULT_SETTINGS, trimBlankEdges: trimBlankEdges };',
    sandbox, { filename: 'main.js' });
  ObaiPlugin = sandbox.module.exports;
} catch (e) {
  console.log('✗ 模块求值就失败了（连类都没拿到）');
  console.log(e && e.stack ? e.stack : e);
  process.exit(1);
}
console.log('✓ main.js 求值通过，拿到插件类');

const app = {
  workspace: {
    on() { return { id: 'ev' }; },
    getActiveViewOfType() { return null; },
    getLeavesOfType() { return []; },
    onLayoutReady(cb) { if (cb) cb(); }
  },
  vault: { adapter: {}, getName: () => 'vault', getAbstractFileByPath: () => null },
  commands: { addCommand() {} }
};
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

(async () => {
  const plugin = new ObaiPlugin(app, manifest);
  try {
    await plugin.loadSettings();
    console.log('✓ loadSettings 通过，settings 键数 =', Object.keys(plugin.settings).length);
    console.log('  补全相关：', ['complete', 'completeCode', 'completeDelay', 'completeMax', 'completeProvider']
      .map((k) => k + '=' + JSON.stringify(plugin.settings[k])).join('  '));
  } catch (e) {
    console.log('✗ loadSettings 抛错：');
    console.log(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  try {
    await plugin.onload();
    console.log('✓ onload 通过');
    console.log('  注册的命令数 =', plugin._registered.commands.length);
    console.log('  编辑器扩展数 =', plugin._registered.extensions.length,
      plugin._registered.extensions.length ? '（行内补全装上了）' : '（★ 没装上 —— CM 未拿到）');
    console.log('  设置页 =', plugin._registered.settingsTabs.length);
  } catch (e) {
    console.log('✗ onload 抛错 —— 这就是"插件加载失败"的直接原因：');
    console.log(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  /* 设置页也真渲染一遍：设置页崩了虽然不致于加载失败，但一样是 bug */
  try {
    const tab = new (plugin._registered.settingsTabs[0].constructor)(app, plugin);
    tab.containerEl = el('div');
    tab.display();
    console.log('✓ 设置页首页 display() 通过');

    /* 二级页逐个真渲染一遍 —— 重构最容易在这里翻车 */
    const pages = ['providers', 'actions', 'prompts', 'complete', 'custom', 'templates', 'more', 'diag', 'help'];
    for (const pg of pages) {
      tab._page = pg;
      tab.containerEl = el('div');
      tab.display();
      console.log('  ✓ 子页 ' + pg);
    }
  } catch (e) {
    console.log('✗ 设置页 display() 抛错：');
    console.log(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  /* 改写面板：普通模式 / 快速模式都要能开能关（快速模式会跳过模板与引用区） */
  try {
    const X = sandbox.__X;
    const rb1 = new X.RewriteBox(app, plugin);
    rb1.open();
    console.log('✓ AI 对话面板 open/close 通过');
    rb1.close();

    const rb2 = new X.RewriteBox(app, plugin, null, { compact: true });
    rb2.open();
    if (!rb2.compact) throw new Error('compact 标记没生效');
    if (rb2.refsWrap !== null) throw new Error('快速模式不应该建引用区');
    if (rb2.ctxChip !== null) throw new Error('快速模式不应该建上下文 chip');
    console.log('✓ 快速改写面板 open/close 通过（窄版、无引用区、无上下文 chip）');

    /* 没有选中文字时，_send 必须拦住，不能拿整篇笔记去改 */
    loadtestNotices.length = 0;
    rb2.inputEl.value = '改成更简洁';
    await rb2._send();
    if (!loadtestNotices.some(function (m) { return m.indexOf('选中') >= 0; })) {
      throw new Error('缺选中文字时没有给出提示：' + JSON.stringify(loadtestNotices));
    }
    if (rb2.busy) throw new Error('被拦住后 busy 应该回到 false');
    console.log('✓ 快速改写缺选中文字时被正确拦住');

    /* 打开时的选区快照要留下来（焦点移走后兜底用） */
    const rb3 = new X.RewriteBox(app, plugin, null, { compact: true, selection: '原文一段' });
    if (rb3.compactSel !== '原文一段') throw new Error('选区快照没存下来');
    console.log('✓ 快速改写保存了选区快照');

    /* 点「选笔记」弹窗时不能把改写框关掉（mousedown 抢在 click 前面那个 bug） */
    const rbEv = new X.RewriteBox(app, plugin);
    rbEv.open();
    let evClosed = 0;
    rbEv.close = function () { evClosed++; };
    rbEv._onDown({ target: { closest: function (sel) { return sel === '.modal-container' ? {} : null; } } });
    if (evClosed) throw new Error('点 modal 时把改写框关了');
    rbEv._onDown({ target: { closest: function () { return null; } } });
    if (!evClosed) throw new Error('点真正的"外面"却没关');
    rbEv.el = null;
    console.log('✓ 选笔记弹窗里点击不会关掉改写框（点真正外面仍会关）');

    /* 引用关联笔记：把 [[链接]] 到的都拉进来，去重、跳过 missing、不引用自己 */
    const rbRel = new X.RewriteBox(app, plugin);
    rbRel.open();
    const fileA = { path: 'A.md' };
    app.workspace.getActiveFile = function () { return fileA; };
    app.vault = app.vault || {};
    app.vault.cachedRead = async function () { return '见 [[B]] 和 [[C]] 以及 [[B]] 还有 [[A]]'; };
    app.metadataCache = app.metadataCache || {};
    app.metadataCache.getFirstLinkpathDest = function (name) {
      if (name === 'C') return null;
      return { path: name + '.md' };
    };
    await rbRel._addRelatedRefs();
    const got = rbRel.refs.map(function (r) { return r.path; }).join(',');
    if (got !== 'B.md') throw new Error('关联笔记结果不对：' + got);
    console.log('✓ 引用关联笔记：去重 / 跳过缺失 / 不引用自己（' + got + '）');

    rb2.close();
  } catch (e) {
    console.log('✗ 改写面板出错：');
    console.log(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  /* 可单独指定接口的入口：4 个额外目标必须在列表里，且 id 与代码读写的一致 */
  {
    const X = sandbox.__X;
    const ids = X.PROVIDER_EXTRA_TARGETS.map(function (x) { return x.id; });
    const want = ['frontmatter', 'to-canvas', 'quick-rewrite', 'chat'];
    if (ids.join(',') !== want.join(',')) {
      throw new Error('额外入口 id 不对：' + ids.join(',') + '（应为 ' + want.join(',') + '）');
    }
    console.log('✓ 4 个额外入口都能单独指定接口：' + ids.join(' / '));

    /* 胶囊记忆：快速改写要能像动作一样被记住 */
    const old = plugin._lastActionId;
    plugin._lastActionId = X.QUICK_TARGET.id;
    const cur = plugin.bubble._lastAction();
    plugin._lastActionId = old;
    if (!cur || !cur.quick || cur.pill !== '快速改写') {
      throw new Error('快速改写没有被胶囊识别：' + JSON.stringify(cur));
    }
    console.log('✓ 胶囊能记住「快速改写」并在主按钮上显示');
  }

  /* 行级 diff：对比原文靠它，纯函数先测透 */
  {
    const X = sandbox.__X;
    const D = X.diffLines, C = X.compactDiffOps;
    const sig = (ops) => ops.map(function (o) { return o.t + o.text; }).join('|');

    if (sig(D('a\nb\nc', 'a\nb\nc')) !== '=a|=b|=c') throw new Error('相同文本 diff 不对：' + sig(D('a\nb\nc', 'a\nb\nc')));
    if (sig(D('a\nb\nc', 'a\nB\nc')) !== '=a|-b|+B|=c') throw new Error('改一行 diff 不对：' + sig(D('a\nb\nc', 'a\nB\nc')));
    if (sig(D('a', 'a\nb')) !== '=a|+b') throw new Error('尾部新增 diff 不对：' + sig(D('a', 'a\nb')));
    if (sig(D('x\na', 'a')) !== '-x|=a') throw new Error('开头删除 diff 不对：' + sig(D('x\na', 'a')));
    if (sig(D('', 'a')) !== '-|+a') throw new Error('空原文 diff 不对：' + sig(D('', 'a')));
    console.log('✓ diff 基本情形（相同 / 改行 / 增 / 删 / 空）');

    /* 长段未变要折叠，别把卡片撑爆 */
    const big = [];
    for (let i = 0; i < 30; i++) big.push('line' + i);
    const ops2 = C(D(big.join('\n'), big.join('\n')), 6);
    if (!ops2.some(function (o) { return o.t === '…'; })) throw new Error('长段没有折叠');
    if (ops2.length > 12) throw new Error('折叠后还是太长：' + ops2.length);
    console.log('✓ 30 行未改动折叠成 1 条提示（' + ops2.length + ' 行）');

    /* 大文件：掐掉公共前后缀后应该很快 */
    const t0 = Date.now();
    const h1 = new Array(2000).fill('same');
    const h2 = h1.slice();
    h2[1000] = 'changed';
    const ops3 = D(h1.join('\n'), h2.join('\n'));
    const ms = Date.now() - t0;
    if (ms > 120) throw new Error('2000 行 diff 太慢：' + ms + 'ms');
    if (ops3.filter(function (o) { return o.t === '-'; }).length !== 1) throw new Error('大文件 diff 结果不对');
    console.log('✓ 2000 行只改 1 行：' + ms + 'ms');

    /* 结果卡片真渲染一次对比视图（按钮 + 行样式都在这里过一遍） */
    const card = new X.ResultCard(app, plugin, {
      loading: true, providerLabel: 'test', before: 'a\nb\nc', rect: null,
    });
    card.open();
    card.showResult('a\nB\nc');
    if (!card._canDiff()) throw new Error('有原文却判定不能对比');
    card.diffing = true;
    card._renderBody();
    card._renderButtons();
    card.close();
    console.log('✓ 结果卡片能渲染「对比原文」视图');

    /* 引用回链：有来源就渲染「参考了 …」，没有就不渲染 */
    const card3 = new X.ResultCard(app, plugin, {
      loading: false, text: '结果', sources: [{ name: '核心交换机', path: '技术/核心交换机.md' }],
    });
    card3.open();
    card3.showResult('结果');
    const hasSrc = card3.body.children.some(function (c) { return c._cl && c._cl.has('obai-src-row'); });
    card3.close();
    if (!hasSrc) throw new Error('有 sources 却没渲染「参考了」行');
    console.log('✓ 引用回链：有来源时渲染「参考了 …」');

    const card4 = new X.ResultCard(app, plugin, { loading: false, text: '结果' });
    card4.open();
    card4.showResult('结果');
    const noSrc = card4.body.children.some(function (c) { return c._cl && c._cl.has('obai-src-row'); });
    card4.close();
    if (noSrc) throw new Error('没有 sources 不应该渲染来源行');
    console.log('✓ 引用回链：没引用时不出现');

    /* 没有原文时不该出现对比按钮 */
    const card2 = new X.ResultCard(app, plugin, { loading: false, text: 'x', rect: null });
    if (card2._canDiff()) throw new Error('没有原文也应该能对比？');
    console.log('✓ 没有原文时不提供对比');

    /* 存为笔记：应写出一篇 .md */
    const card5 = new X.ResultCard(app, plugin, { loading: false, text: '要保存的内容' });
    card5.open();
    card5.showResult('要保存的内容');
    let saved = null;
    app.vault.getAbstractFileByPath = function () { return null; };
    app.vault.create = async function (p2, body) { saved = { path: p2, body: body }; return { path: p2 }; };
    app.workspace.getLeaf = function () { return { openFile: function () { } }; };
    await card5._saveAsNote();
    if (!saved || !/\.md$/.test(saved.path) || saved.body !== '要保存的内容') {
      throw new Error('存为笔记没写出正确文件：' + JSON.stringify(saved));
    }
    console.log('✓ 存为笔记：写出 ' + saved.path);
  }

  /* 自绘菜单：能开、能出二级、能关 */
  {
    const X = sandbox.__X;
    const byId = {
      polish: { id: 'polish', name: '润色' },
      formal: { id: 'formal', name: '专业语气' },
      hey: { id: 'hey', name: '嘿嘿', custom: true },
    };
    const tree = [{
      label: '编辑',
      children: [{ id: 'polish' }, { label: '语气', children: [{ id: 'formal' }] }],
    }];
    let picked = null;
    const am = new X.ActionMenu(plugin, el('div'), tree, byId,
      function (a) { picked = a.id; },
      [{ label: '快速改写…', run: function () { picked = 'quick'; } }]);
    am.open();
    if (!am.el) throw new Error('菜单没创建');
    if (am.el.children.length < 3) throw new Error('菜单项太少：' + am.el.children.length);
    am._showSub(am.el.children[0], tree[0].children);
    if (!am.subEl) throw new Error('二级菜单没出来');
    am.close();
    if (am.el || am.subEl) throw new Error('关闭后没清理');
    console.log('✓ 自绘菜单：一级 / 二级 / 关闭 都正常');

    /* 设置页必须真能渲染出「记住对话历史」开关（上次就因为插入点写错漏了） */
    const tab2 = new X.ObaiSettingTab(app, plugin);
    tab2._page = 'actions';
    tab2.containerEl = el('div');
    tab2.display();
    const dump = (node, out) => {
      if (!node) return out;
      if (node.textContent) out.push(String(node.textContent));
      (node.children || []).forEach(function (c) { dump(c, out); });
      return out;
    };
    const texts = dump(tab2.containerEl, []);
    if (!texts.some(function (t) { return t.indexOf('记住对话历史') >= 0; })) {
      throw new Error('设置页没渲染出「记住对话历史」');
    }
    console.log('✓ 设置页能渲染「记住对话历史」开关');

    /* 历史菜单：有记录时必须列出来 */
    plugin.settings.chatHistory = [{
      id: 'hx', ts: Date.now(), title: '测试对话',
      msgs: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
    }];
    plugin.settings.promptHistory = ['旧指令'];
    const rbH = new X.RewriteBox(app, plugin);
    const before = (obsidian.Menu.all || []).length;
    rbH._historyMenu(el('button'));
    const mi = (obsidian.Menu.all || [])[before];
    const titles = mi ? mi.items.map(function (x) { return x.title; }) : [];
    if (!titles.some(function (t) { return t.indexOf('最近的对话') >= 0; })) {
      throw new Error('历史菜单没有「最近的对话」：' + JSON.stringify(titles));
    }
    if (!titles.some(function (t) { return t.indexOf('测试对话') >= 0; })) {
      throw new Error('历史菜单没有列出对话：' + JSON.stringify(titles));
    }
    console.log('✓ 历史菜单能列出对话：' + titles.join(' / '));
  }

  /* 对话历史：写入 / 去重 / 上限 / 截断 / 不存 system */
  {
    const X = sandbox.__X;
    const P = X.pushChatHistory;

    let h = P([], { title: '问一句', msgs: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在' }] });
    if (h.length !== 1 || h[0].msgs.length !== 2) throw new Error('基本写入不对');

    h = P(h, { id: h[0].id, title: '同名覆盖', msgs: [] });
    if (h.length !== 1) throw new Error('同 id 没去重');

    for (let i = 0; i < 25; i++) h = P(h, { title: 't' + i, msgs: [{ role: 'user', content: 'x' }] });
    if (h.length !== X.CHAT_HISTORY_MAX) throw new Error('上限没生效：' + h.length);

    const long = P([], { title: 'x', msgs: [{ role: 'user', content: 'a'.repeat(5000) }] });
    if (long[0].msgs[0].content.length !== 2000) throw new Error('单条没截断');

    const many = P([], { msgs: new Array(30).fill(0).map(function () { return { role: 'user', content: 'x' }; }) });
    if (many[0].msgs.length !== 10) throw new Error('轮数没截断：' + many[0].msgs.length);

    /* _saveChat 不能把 system（含选中正文）存进去 */
    plugin.settings.chatHistory = [];
    const rbChat = new X.RewriteBox(app, plugin);
    rbChat._saveChat('问题', '回答', [
      { role: 'system', content: '选中的正文，不该入库' },
      { role: 'user', content: '问题' },
    ]);
    const saved = plugin.settings.chatHistory[0];
    if (!saved || saved.msgs.length !== 2) throw new Error('保存的消息数不对：' + JSON.stringify(saved));
    if (saved.msgs.some(function (m) { return m.role === 'system'; })) throw new Error('system 被存进去了');
    if (saved.msgs[1].role !== 'assistant' || saved.msgs[1].content !== '回答') throw new Error('回答没存上');

    console.log('✓ 对话历史：写入 / 去重 / 上限 20 / 截断 / 不含正文');

    /* 从历史继续时必须出现「正在继续…」提示条 */
    const rbC = new X.RewriteBox(app, plugin,
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      { continueTitle: '添加标题' });
    rbC.open();
    const hasBar = (rbC.el.children || []).some(function (c) {
      return c._cl && c._cl.has('obai-rw-continue');
    });
    rbC.close();
    if (!hasBar) throw new Error('继续对话时没有提示条');
    console.log('✓ 继续对话时有「正在继续…」提示条');

    /* 「查看上次内容」：默认折叠，展开后每条消息一行 */
    const rbR = new X.RewriteBox(app, plugin, [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ], { continueTitle: 'x' });
    rbR.open();
    const det = (rbR.el.children || []).filter(function (c) {
      return c._cl && c._cl.has('obai-rw-recall');
    })[0];
    if (!det) throw new Error('没有「查看上次内容」区');
    if (det.open === true) throw new Error('应该默认折叠');
    const rbody = (det.children || []).filter(function (c) {
      return c._cl && c._cl.has('obai-recall-body');
    })[0];
    if (!rbody || rbody.children.length !== 3) {
      throw new Error('历史行数不对：' + (rbody ? rbody.children.length : 'none'));
    }
    rbR.close();
    console.log('✓ 查看上次内容：默认折叠、3 条消息都列出来了');
  }

  /* 多光标批量：选区识别 + 分流 */
  {
    const mk = function (l, c) { return { line: l, ch: c }; };
    const fakeEd = {
      listSelections: function () {
        return [
          { anchor: mk(2, 0), head: mk(2, 5) },
          { anchor: mk(0, 3), head: mk(0, 0) },   /* 反向选 */
          { anchor: mk(5, 2), head: mk(5, 2) },   /* 空选区，应忽略 */
        ];
      },
      posToOffset: function (p) { return p.line * 100 + p.ch; },
      getValue: function () { return ''; },
      getSelection: function () { return ''; },
    };

    const m = plugin._multiSelections(fakeEd);
    if (m.length !== 2) throw new Error('选区数量不对：' + m.length);
    if (m[0].aOff !== 0 || m[1].aOff !== 200) {
      throw new Error('选区没按顺序排：' + JSON.stringify(m.map(function (x) { return x.aOff; })));
    }
    if (m[0].from.ch !== 0 || m[0].to.ch !== 3) throw new Error('反向选区没归一');

    let routed = 0;
    const oldRunMulti = plugin.runMulti;
    plugin.runMulti = function (a, ed, sels) { routed = sels.length; };
    plugin.run({ id: 'polish', instruction: 'x' }, fakeEd);
    plugin.runMulti = oldRunMulti;

    if (routed !== 2) throw new Error('run 没走批量，收到 ' + routed + ' 段');
    console.log('✓ 多选区：识别 2 段、忽略空选区、自动排序、走批量');
  }

  /* 标记式多段：累积 / 去重 / 分流 / 组装并清空 */
  {
    const mkEditor = function (doc) {
      const ed = {
        _doc: doc, _sel: { start: 0, end: 0 },
        getSelection: function () { return this._doc.slice(this._sel.start, this._sel.end); },
        getCursor: function (which) { return { offset: which === 'to' ? this._sel.end : this._sel.start }; },
        posToOffset: function (p) { return p.offset; },
        offsetToPos: function (o) { return { offset: o }; },
        getRange: function (a, b) { return this._doc.slice(a.offset, b.offset); },
        getValue: function () { return this._doc; },
      };
      return ed;
    };

    const ed = mkEditor('AAAA\n\nBBBB\n\nCCCC');
    plugin.clearMarks(true);

    ed._sel = { start: 0, end: 4 };
    plugin.markSelection(ed);
    ed._sel = { start: 6, end: 10 };
    plugin.markSelection(ed);
    if (plugin._marks.length !== 2) throw new Error('标记没累积：' + plugin._marks.length);

    plugin.markSelection(ed);
    if (plugin._marks.length !== 2) throw new Error('重复标记没拦住');

    let routed = false;
    const oldRunMarked = plugin.runMarked;
    plugin.runMarked = function () { routed = true; };
    plugin.run({ id: 'polish', instruction: 'x' }, ed);
    plugin.runMarked = oldRunMarked;
    if (!routed) throw new Error('有标记时没走 runMarked');

    let segs = null;
    const oldSeg = plugin._runSegments;
    plugin._runSegments = async function (a, e, list) { segs = list; return true; };
    ed._sel = { start: 12, end: 16 };
    await plugin.runMarked({ id: 'polish', instruction: 'x' }, ed);
    plugin._runSegments = oldSeg;

    if (!segs || segs.length !== 3) throw new Error('段数不对（应为 2 个标记 + 当前选区）：' + (segs ? segs.length : 'null'));
    if (plugin._marks.length !== 0) throw new Error('执行后标记没清空');
    if (segs[0].text !== 'AAAA' || segs[2].text !== 'CCCC') throw new Error('段内容不对');
    console.log('✓ 标记式批量：累积 2 段 + 当前选区 = 3 段，执行后清空');

    /* 胶囊菜单能构建（含标记项） */
    plugin._marks = [{ path: '', start: 0, end: 1, text: 'A' }];
    plugin.bubble._openMenu(el('div'));
    if (!plugin.bubble._menu || !plugin.bubble._menu.el) throw new Error('胶囊菜单没建起来');
    plugin.bubble._menu.close();
    plugin._marks = [];
    console.log('✓ 胶囊菜单能构建（含标记项）');

    /* 批量面板：状态与关闭 */
    const bp = new sandbox.__X.BatchPanel(plugin, '润色 · 批量', [{ text: 'aaa' }, { text: 'bbb' }, { text: 'ccc' }]);
    bp.open();
    if (!bp.el) throw new Error('面板没建起来');
    if (bp.rows.length !== 3) throw new Error('行数不对：' + bp.rows.length);
    bp.setStatus(0, 'ok');
    if (bp.rows[0].row.className.indexOf('is-ok') < 0) throw new Error('状态类没切换');
    if (bp.rows[0].state.textContent !== '完成') throw new Error('状态文字不对');
    bp.setStatus(1, 'fail');
    if (bp.rows[1].state.textContent !== '失败') throw new Error('失败状态不对');
    bp.markDone('已处理 3 段');
    if (!bp.done) throw new Error('markDone 没置完成');
    if (bp.cancelBtn.textContent !== '关闭') throw new Error('完成后按钮应变成关闭');
    bp.close();
    if (bp.el) throw new Error('关闭后没清理');
    console.log('✓ 批量面板：3 行状态 / 完成态 / 关闭清理');

    /* 批量输出归一化：空 = 失败、<DELETE> = 删除、剥代码围栏 */
    const N = sandbox.__X.normalizeSegmentOut;
    if (N('').ok) throw new Error('空返回不该算成功');
    const d1 = N('<DELETE>');
    if (!d1.ok || !d1.del || d1.text !== '') throw new Error('<DELETE> 没识别成删除');
    const d2 = N('```\n## 新标题\n```');
    if (!d2.ok || d2.text !== '## 新标题') throw new Error('代码围栏没剥掉');
    const d3 = N('  正常内容  ');
    if (d3.text !== '正常内容' || d3.del) throw new Error('普通内容处理不对');
    console.log('✓ 批量输出归一化：空 / <DELETE> / 代码围栏 / 普通文本');

    /* AI 划范围：段落扩展 + 锚点定位 */
    const doc2 = '第一段内容\n第二行\n\n## U 盘备份\n- 用 U 盘拷一份\n\n第三段';
    const p1 = sandbox.__X.expandToParagraph(doc2, doc2.indexOf('第二行'));
    if (doc2.slice(p1.start, p1.end) !== '第一段内容\n第二行') {
      throw new Error('段落扩展不对：' + JSON.stringify(doc2.slice(p1.start, p1.end)));
    }
    const loc = sandbox.__X.locateMatches(doc2, [
      { anchor: '## U 盘备份', scope: 'paragraph' },
      { anchor: '第三段', scope: 'line' },
      { anchor: '根本不存在的句子', scope: 'paragraph' },
    ]);
    if (loc.hits.length !== 2) throw new Error('命中数不对：' + loc.hits.length);
    if (loc.missed.length !== 1) throw new Error('遗漏数不对：' + loc.missed.length);
    /* 同段落的两条会重叠，保留第一条 */
    if (loc.hits[0].text.indexOf('## U 盘备份') < 0) throw new Error('第一段不对');
    console.log('✓ AI 划范围：段落扩展 / 锚点定位 / 重叠去重 / 找不到计入遗漏');

    /* 阅读模式下不应出现「替换 / 插入」 */
    const oldView = app.workspace.getActiveViewOfType;
    app.workspace.getActiveViewOfType = function () { return { getMode: function () { return 'preview'; } }; };
    const cardRO = new sandbox.__X.ResultCard(app, plugin, { loading: false, text: 'x' });
    cardRO.open(); cardRO.showResult('x');
    const roLabels = (cardRO.bar.children || []).map(function (c) { return String(c.textContent || ''); });
    if (roLabels.indexOf('替换') >= 0) throw new Error('阅读模式下不该有替换：' + roLabels.join(','));
    if (roLabels.indexOf('复制') < 0) throw new Error('阅读模式下应保留复制');
    cardRO.close();

    app.workspace.getActiveViewOfType = function () { return { getMode: function () { return 'source'; } }; };
    const cardED = new sandbox.__X.ResultCard(app, plugin, { loading: false, text: 'x' });
    cardED.open(); cardED.showResult('x');
    const edLabels = (cardED.bar.children || []).map(function (c) { return String(c.textContent || ''); });
    if (edLabels.indexOf('替换') < 0) throw new Error('编辑模式下应有替换：' + edLabels.join(','));
    cardED.close();
    app.workspace.getActiveViewOfType = oldView;
    console.log('✓ 阅读模式隐藏「替换 / 插入」，编辑模式保留');

    /* 有标记时，AI 对话里应出现横幅 */
    plugin._marks = [{ path: '', start: 0, end: 4, text: 'AAAA' }];
    const rbM = new sandbox.__X.RewriteBox(app, plugin);
    rbM.open();
    const hasMBar = (rbM.el.children || []).some(function (c) {
      return c._cl && c._cl.has('obai-rw-marks');
    });
    if (!hasMBar) throw new Error('有标记时对话框没有提示横幅');
    if (!rbM._marksMode) throw new Error('没进入批量模式');
    rbM.close();
    plugin._marks = [];
    console.log('✓ 有标记时对话框显示「已标记 N 段」横幅');

    /* 单行输入条：能开、回车/箭头提交、Esc 关闭 */
    let got = 'none';
    const qa = new sandbox.__X.QuickAsk('要找什么？', function (v) { got = v; });
    qa.open();
    if (!qa.el) throw new Error('输入条没建起来');
    if (!qa.input) throw new Error('没有输入框');
    qa.input.value = '所有提到 U 盘的段落';
    qa._submit();
    if (got !== '所有提到 U 盘的段落') throw new Error('提交值不对：' + got);
    if (qa.el) throw new Error('提交后没清理');

    let got2 = 'none';
    const qa2 = new sandbox.__X.QuickAsk('x', function (v) { got2 = v; });
    qa2.open();
    qa2._finish(null);
    if (got2 !== null) throw new Error('取消应回 null');
    console.log('✓ 单行输入条：回车提交 / Esc 取消 / 清理干净');

    /* 连开两次对话面板：旧的要被关掉 */
    plugin.openRewrite();
    const firstBox = plugin._rwBox;
    plugin.openRewrite();
    const secondBox = plugin._rwBox;
    if (!firstBox || !secondBox) throw new Error('面板没建立');
    if (firstBox === secondBox) throw new Error('第二次没新建');
    if (firstBox.el) throw new Error('旧面板没关闭');
    if (secondBox) secondBox.close();
    console.log('✓ 连开两次对话面板只保留一个');

    /* 徽标只算当前文件的标记 */
    const af0 = app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
    const p0 = af0 ? af0.path : '';
    plugin._marks = [
      { path: p0, start: 0, end: 1, text: 'A' },
      { path: p0 + '-other.md', start: 0, end: 1, text: 'B' },
    ];
    if (plugin.marksHere().length !== 1) throw new Error('marksHere 没按文件过滤：' + plugin.marksHere().length);
    plugin._marks = [];
    console.log('✓ 标记计数只算当前文件');

    /* 升级项：批量面板重试按钮 */
    const bp2 = new sandbox.__X.BatchPanel(plugin, 't', [{ text: 'a' }]);
    bp2.open();
    let retried = 0;
    bp2.markDone('1 段失败', function () { retried++; });
    if (!bp2.retryBtn || bp2.retryBtn.style.display === 'none') throw new Error('失败时没出重试按钮');
    bp2.retryBtn.onclick();
    if (retried !== 1) throw new Error('重试回调没触发');
    if (bp2.el) throw new Error('重试后面板没关');
    console.log('✓ 批量面板：失败时出现「重试失败项」并可用');

    /* 升级项：提示词页有搜索框 */
    const tab3 = new sandbox.__X.ObaiSettingTab(app, plugin);
    tab3._page = 'prompts';
    tab3.containerEl = el('div');
    tab3.display();
    const txt3 = [];
    (function walk(n) {
      if (!n) return;
      if (n.textContent) txt3.push(String(n.textContent));
      (n.children || []).forEach(walk);
    })(tab3.containerEl);
    if (!txt3.some(function (t) { return t.indexOf('搜索') >= 0; })) throw new Error('提示词页没有搜索框');
    console.log('✓ 提示词页有搜索框');

    /* 升级项：对比模式下的「复制改动行」 */
    const cardD = new sandbox.__X.ResultCard(app, plugin, { before: 'a\nb', text: 'a\nc' });
    cardD.open();
    cardD.showResult('a\nc');
    cardD.diffing = true;
    cardD._renderButtons();
    const dl = (cardD.bar.children || []).map(function (c) { return String(c.textContent || ''); });
    if (dl.indexOf('复制改动行') < 0) throw new Error('对比模式没有复制改动行：' + dl.join(','));
    cardD.close();
    console.log('✓ 对比模式出现「复制改动行」');

    /* 接口排序：上移 / 下移 */
    plugin.settings.providers = [
      { id: 'p1', name: '甲', baseUrl: 'http://a', format: 'openai' },
      { id: 'p2', name: '乙', baseUrl: 'http://b', format: 'openai' },
      { id: 'p3', name: '丙', baseUrl: 'http://c', format: 'openai' },
    ];
    const tabM = new sandbox.__X.ObaiSettingTab(app, plugin);
    await tabM._moveProvider(plugin.settings.providers[2], -1);
    if (plugin.settings.providers.map(function (x) { return x.id; }).join() !== 'p1,p3,p2') {
      throw new Error('上移不对：' + plugin.settings.providers.map(function (x) { return x.id; }).join());
    }
    await tabM._moveProvider(plugin.settings.providers[0], -1);   /* 已经在最前，应无变化 */
    if (plugin.settings.providers[0].id !== 'p1') throw new Error('越界时不该改动');
    await tabM._moveProvider(plugin.settings.providers[0], 1);
    if (plugin.settings.providers.map(function (x) { return x.id; }).join() !== 'p3,p1,p2') {
      throw new Error('下移不对');
    }
    console.log('✓ 接口排序：上移 / 下移 / 越界不动');

    /* 批量面板：单段跳过 */
    const bpS = new sandbox.__X.BatchPanel(plugin, 't', [{ text: 'aaa' }, { text: 'bbb' }]);
    bpS.open();
    const skipBtn = (bpS.rows[0].row.children || []).filter(function (c) {
      return c._cl && c._cl.has('obai-batch-skip');
    })[0];
    if (!skipBtn) throw new Error('没有跳过按钮');
    skipBtn.onclick();
    if (!bpS.isSkipped(0)) throw new Error('跳过没记录');
    if (bpS.rows[0].state.textContent !== '跳过') throw new Error('状态没更新');
    bpS.close();
    console.log('✓ 批量面板：可单段跳过');
  }

  /* 升级项（0.53）：调试开关 + 两段式 AI 划范围 */
  {
    const X = sandbox.__X;

    /* 调试默认值 + 归一化 */
    if (X.DEFAULT_SETTINGS.debug !== false) throw new Error('DEFAULT_SETTINGS.debug 默认不是 false');
    plugin.settings.debug = 'yes';          /* 脏值 */
    await plugin.loadSettings();
    if (plugin.settings.debug !== false) throw new Error('debug 脏值没被归一化为 false');
    console.log('✓ 调试开关：默认关，脏值归一化为 false');

    /* dlog：关着时静默，开着时打到控制台 */
    let warns = 0;
    const realWarn = console.warn;
    console.warn = function () { warns++; };
    X.setDebug(false);
    X.dlog('t', new Error('x'));
    if (warns !== 0) throw new Error('关着时不应该有控制台输出');
    X.setDebug(true);
    X.dlog('t', new Error('x'));
    X.setDebug(false);
    if (warns !== 1) throw new Error('开着时应当输出 1 次，实际 ' + warns);
    console.warn = realWarn;
    console.log('✓ dlog：关着静默，开着打印 [obai]');

    /* buildOutline：无标题 → 一节「全文」；有标题且前面有正文 → 先有「开头」 */
    const secs1 = X.buildOutline('正文一段\n# 标题一\n内容一\n## 小节\n内容二');   /* max 不传 */
    if (!secs1.length) throw new Error('buildOutline 返回空');
    if (secs1[0].title !== '（开头）') throw new Error('标题前的正文没形成「开头」节');
    if (secs1.length < 3) throw new Error('分节数不对：' + secs1.length);
    /* 区间必须首尾相接、不越界 */
    for (let k = 0; k < secs1.length; k++) {
      const s = secs1[k];
      if (s.start < 0 || s.end > '正文一段\n# 标题一\n内容一\n## 小节\n内容二'.length) {
        throw new Error('区间越界：' + JSON.stringify(s));
      }
      if (s.end <= s.start) throw new Error('空区间：' + JSON.stringify(s));
    }
    const secs2 = X.buildOutline('就是一段没有标题的文字');
    if (secs2.length !== 1 || secs2[0].title !== '（全文）') throw new Error('无标题小文档应返回「全文」节');
    console.log('✓ 章节目录：分节 / 开头节 / 全文节 / 区间不越界');

    /* outlineText 带编号与层级 */
    const ot = X.outlineText(secs1, '正文一段\n# 标题一\n内容一\n## 小节\n内容二');
    if (!ot.includes('#0')) throw new Error('outlineText 缺编号：' + ot);
    if (!ot.includes('H2')) throw new Error('outlineText 缺层级标记：' + ot);
    console.log('✓ 章节目录文本：带编号与层级');

    /* focusText：取逐字切片，budget 截断不破坏切片 */
    const docT = '正文一段\n# 标题一\n内容一\n## 小节\n内容二';
    const ft = X.focusText(docT, secs1, [1, 2], 999999);
    if (ft.indexOf('内容一') < 0 || ft.indexOf('内容二') < 0) throw new Error('focusText 没拼出选中节：' + ft);
    const ftCap = X.focusText(docT, secs1, [1, 2], 4);
    if (ftCap.length > docT.length) throw new Error('focusText 超出 budget 太多');
    console.log('✓ 节选拼接：逐字切片 + budget 截断');

    /* 映射：在节选上定位到的段落，能 indexOf 回原文（markFromAI 的核心） */
    const docM = 'aaa\n\n# 章一\n目标段落在这里\n\n# 章二\n别的\n';
    const sM = X.buildOutline(docM);
    const ftM = X.focusText(docM, sM, [1], 999999);   /* 只送章一 */
    const lm = X.locateMatches(ftM, [{ anchor: '目标段落在这里', scope: 'paragraph' }]);
    if (!lm.hits.length) throw new Error('节选上没定位到');
    const hitText = lm.hits[0].text;
    const si = docM.indexOf(hitText);
    if (si < 0) throw new Error('节选命中段无法映射回原文');
    if (docM.slice(si, si + hitText.length) !== hitText) throw new Error('映射回原文不一致');
    console.log('✓ 两段式映射：节选命中 → 原文偏移一致');

    /* 设置页「诊断与关于」里有调试日志开关 */
    const tabD = new X.ObaiSettingTab(app, plugin);
    tabD._page = 'more';
    tabD.containerEl = el('div');
    tabD.display();
    const txtD = [];
    (function walk(n) { if (!n) return; if (n.textContent) txtD.push(String(n.textContent)); (n.children || []).forEach(walk); })(tabD.containerEl);
    if (!txtD.some(function (t) { return t.indexOf('调试日志') >= 0; })) throw new Error('诊断页没有「调试日志」开关');
    console.log('✓ 设置页「诊断与关于」含调试日志开关');
  }

  /* 升级项：胶囊主标签——有标记显「标记 N 段」，无标记显上次动作 */
  {
    const bub = plugin.bubble;
    if (!bub) throw new Error('胶囊未初始化');
    if (!bub.el) bub._build();           /* 沙箱里没真实选中，show() 没触发过 _build() */
    if (!bub.toolEl) throw new Error('胶囊工具标签未构建');
    /* 无标记：显示上次动作（翻译胶囊名已改为「翻译成中文」） */
    plugin._marks = [];
    plugin._lastActionId = 'trans-zh';
    bub._refreshLabel();
    if (bub.toolEl.textContent !== '翻译成中文') throw new Error('无标记应显示上次动作：' + bub.toolEl.textContent);
    /* 标记按"当前文件"过滤：取真实活动文件路径，避免和前面测试改过的 getActiveFile 冲突 */
    const af = plugin.app.workspace.getActiveFile ? plugin.app.workspace.getActiveFile() : null;
    const ap = af ? af.path : '';
    /* 有标记：主标签直接反映标记状态 */
    plugin._marks = [{ path: ap, start: 0, end: 1, text: 'x' }];
    bub._refreshLabel();
    if (bub.toolEl.textContent !== '标记 1 段') throw new Error('有标记应显示「标记 1 段」：' + bub.toolEl.textContent);
    plugin._marks = [];
    plugin._lastActionId = '';
    console.log('✓ 胶囊主标签：无标记显上次动作，有标记显「标记 N 段」');
  }

  /* 修复：替换时去掉 AI 结果首尾的换行（否则内联替换会另起一行） */
  {
    const X = sandbox.__X;
    const T = X.trimBlankEdges;
    if (T('\n\n新词\n\n') !== '新词') throw new Error('没去掉首尾空行：' + JSON.stringify(T('\n\n新词\n\n')));
    if (T('\r\n\r\nfoo\r\n') !== 'foo') throw new Error('没处理 CRLF：' + JSON.stringify(T('\r\n\r\nfoo\r\n')));
    if (T('a\nb') !== 'a\nb') throw new Error('不该动中间换行');
    if (T('  foo  ') !== '  foo  ') throw new Error('不该动行内首尾空格');
    if (T('\n  - 缩进项\n') !== '  - 缩进项') throw new Error('不该吃掉正文缩进：' + JSON.stringify(T('\n  - 缩进项\n')));

    /* _apply(true) 写进去的必须是去空行后的文本 */
    const fakeEd = {
      _sel: '旧词',
      replaced: null,
      getSelection() { return this._sel; },
      replaceSelection(t) { this.replaced = t; },
      getCursor() { return { line: 0, ch: 0 }; },
      replaceRange() {},
    };
    const oldAE = plugin._activeEditor;
    plugin._activeEditor = () => fakeEd;
    const cardA = new X.ResultCard(app, plugin, {});
    cardA._text = '\n\n新词\n';
    cardA._apply(true);
    plugin._activeEditor = oldAE;
    if (fakeEd.replaced !== '新词') throw new Error('替换写入的文本没去空行：' + JSON.stringify(fakeEd.replaced));
    console.log('✓ 替换去空行：内联替换不再另起一行');
  }

  /* 修复：重叠标记 —— 先标整段再标段内一句时，不能让区间交叉（写回会冲突） */
  {
    const oldAF = app.workspace.getActiveFile;
    app.workspace.getActiveFile = () => ({ path: 'T.md' });
    const mk = (l, c) => ({ line: l, ch: c });
    const edM = {
      _from: mk(1, 0), _to: mk(2, 0), _sel: 'AAAA',
      getSelection() { return this._sel; },
      posToOffset(p) { return p.line * 100 + p.ch; },
      getCursor(w) { return w === 'from' ? this._from : this._to; },
    };
    plugin._marks = [];
    plugin.markSelection(edM);                       /* 100..200 */
    if (plugin._marks.length !== 1) throw new Error('第一段没标上');
    edM._from = mk(1, 50); edM._to = mk(2, 50); edM._sel = 'BBBB';   /* 150..250，与上一段重叠 */
    plugin.markSelection(edM);
    if (plugin._marks.length !== 1) throw new Error('重叠段应替换旧段，实际 ' + plugin._marks.length);
    if (plugin._marks[0].start !== 150) throw new Error('新标记没生效：' + plugin._marks[0].start);
    edM._from = mk(3, 0); edM._to = mk(4, 0); edM._sel = 'CCCC';     /* 300..400，不相交 */
    plugin.markSelection(edM);
    if (plugin._marks.length !== 2) throw new Error('不相交的段应保留，实际 ' + plugin._marks.length);
    plugin._marks = [];
    app.workspace.getActiveFile = oldAF;
    console.log('✓ 重叠标记：新段替换旧重叠段，不相交的段保留');
  }

  /* 安全网：_runSegments 里重叠的段要被丢掉（否则 transaction 会冲突） */
  {
    const X = sandbox.__X;
    const savedProviders = plugin.settings.providers;
    plugin.settings.providers = [];          /* 让 chat 立即失败，不真的发请求 */
    const origOpen = X.BatchPanel.prototype.open;
    let cap = null;
    X.BatchPanel.prototype.open = function () { cap = this; return origOpen.call(this); };
    const edO = { getValue() { return 'x'.repeat(500); } };
    let threw = false;
    try {
      await plugin._runSegments({ id: 'polish', name: '润色' }, edO, [
        { start: 0, end: 100, text: 'a'.repeat(100) },
        { start: 50, end: 150, text: 'b'.repeat(100) },   /* 与上一段重叠 */
      ], '测试');
    } catch (e) { threw = true; }
    X.BatchPanel.prototype.open = origOpen;
    plugin.settings.providers = savedProviders;
    if (threw) throw new Error('_runSegments 不应向外抛错');
    if (!cap) throw new Error('批量面板没建起来');
    if (cap.rows.length !== 1) throw new Error('重叠段没被丢掉，面板行数 = ' + cap.rows.length);
    console.log('✓ 批量写回：重叠段被丢弃，只剩 1 段');
  }

  console.log('\n🎉 加载链路全通');
})();
