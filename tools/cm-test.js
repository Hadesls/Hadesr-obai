/* 用真的 @codemirror/view + state 校验行内补全的扩展与字段行为
 *
 * 为什么必须用真包：之前用自写桩件时，`EditorState.selection` 在我桩里是有的，
 * 于是"依赖里塞了 undefined"这种错误一路绿灯 —— 到 Obsidian 里就是"插件加载失败"。
 * 桩件验证不了对方的 API 形状。
 *
 * 需要真包（插件目录里不放 node_modules）：
 *   mkdir -p /tmp/cmtest && cd /tmp/cmtest && npm i @codemirror/view@6 @codemirror/state@6
 * 运行：
 *   CM_DIR=/tmp/cmtest/node_modules node tools/cm-test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const CM_DIR = process.env.CM_DIR || '/tmp/cmtest/node_modules';
const view = require(path.join(CM_DIR, '@codemirror/view'));
const state = require(path.join(CM_DIR, '@codemirror/state'));

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function el(tag) {
  return {
    tag: tag, textContent: '', className: '', style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    createEl() { return el('div'); }, createDiv() { return el('div'); }, createSpan() { return el('span'); },
    setText() {}, empty() {}, appendChild() {}, addEventListener() {}, setAttribute() {},
    focus() {}, remove() {}, getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
const obsidian = {
  Plugin: class { constructor() {} },
  PluginSettingTab: class { constructor() {} }, Setting: class { constructor() {} },
  Notice: class { constructor(m) { this.message = m; } }, Modal: class { constructor() {} },
  Menu: class { constructor() {} addItem() { return this; } addSeparator() { return this; } },
  MarkdownView: class {}, requestUrl: async () => ({ json: {} }), setIcon() {},
  MarkdownRenderer: { renderMarkdown() {} },
  FuzzySuggestModal: class { constructor() {} },
  debounce: (f) => f
};
const sandbox = {
  require: function (n) {
    if (n === 'obsidian') return obsidian;
    if (n === '@codemirror/view') return view;
    if (n === '@codemirror/state') return state;
    throw new Error("Cannot find module '" + n + "'");
  },
  module: { exports: {} }, exports: {}, __filename: 'main.js', __dirname: ROOT,
  document: { createElement: el, addEventListener() {}, body: el('body') },
  globalThis: null, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, isFinite,
  Map, Set, fetch: async () => ({ ok: false }),
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  TextEncoder, TextDecoder, Buffer, process, URL
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  src + '\n;globalThis.__T={ installCompleter: installCompleter, CM: CM, API: function(){ return obaiGhostAPI; } };',
  sandbox, { filename: 'main.js' });
const T = sandbox.__T;
let API = null;

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

console.log('\n=== ① 装配（真 CM 校验） ===');
ok(!!T.CM, 'CM 模块取到');
let ext = null, err = null;
try { ext = T.installCompleter({ settings: { complete: true }, saveSettings() {} }); } catch (e) { err = e; }
API = T.API();
ok(!err, 'installCompleter 不抛错', err && err.message);
ok(Array.isArray(ext) && ext.length === 4, '返回 4 项扩展（字段 + 插件 + Tab 键位 + Esc 键位）', ext && ext.length);

let st = null;
try {
  st = state.EditorState.create({ doc: '第一行文字\n第二行', extensions: ext });
  console.log('  ✅ EditorState.create 接受（真 CM 不报 Unrecognized extension）');
} catch (e) {
  console.log('  ❌ EditorState.create 拒绝：' + e.message);
  console.log(e.stack);
  process.exit(1);
}

function widgets(s2) {
  const d = s2.facet(view.EditorView.decorations);
  const arr = Array.isArray(d) ? d : [d];
  const out = [];
  arr.forEach(function (rs) {
    if (rs && rs.between) {
      rs.between(0, s2.doc.length, function (from, to, val) { out.push({ from: from, to: to, val: val }); });
    }
  });
  return out;
}

console.log('\n=== ② loading 药丸 → 灰字（真 StateField 行为） ===');
st = st.update({ selection: { anchor: 3 } }).state;
st = st.update({ effects: API.setGhost.of({ pos: 3, text: '', status: 'loading' }) }).state;
let ws = widgets(st);
ok(ws.length === 1, '落了一个 cursor widget', ws.length);
ok(ws[0] && ws[0].val.spec.widget.constructor.name === 'LoadingGhost',
  'loading 状态渲染的是「AI 思考中」药丸', ws[0] && ws[0].val.spec.widget.constructor.name);
ok(ws[0] && ws[0].from === 3 && ws[0].to === 3, 'widget 零宽、就在光标位置');

st = st.update({ effects: API.setGhost.of({ pos: 3, text: '，接一句', status: 'ready' }) }).state;
ws = widgets(st);
ok(ws.length === 1 && ws[0].val.spec.widget.constructor.name === 'GhostWidget',
  'ready 状态换成灰字本体', ws[0] && ws[0].val.spec.widget.constructor.name);
ok(ws[0] && ws[0].val.spec.widget.text === '，接一句', '灰字内容正确', ws[0] && ws[0].val.spec.widget.text);
ok(ws[0] && ws[0].val.spec.widget.showHint === true, '第一次会带「按 Tab 采纳」提示');

st = st.update({ changes: { from: 3, insert: 'X' } }).state;
ok(st.field(API.field) === null, '打字后灰字自动消失');
ok(widgets(st).length === 0, '装饰也一起没了');

st = st.update({ effects: API.setGhost.of({ pos: 2, text: '继续', status: 'ready' }) }).state;
ok(st.field(API.field) !== null, '再放一次灰字');
st = st.update({ selection: { anchor: 5 } }).state;
ok(st.field(API.field) === null, '移动光标后灰字自动消失');

st = st.update({ selection: { anchor: 2 } }).state;
st = st.update({ effects: API.setGhost.of({ pos: 2, text: '尾巴', status: 'ready' }) }).state;
ok(st.field(API.field) !== null, '光标原地不动时灰字保留', st.field(API.field));

console.log('\n=== ③ Tab 采纳 / Esc 忽略 ===');
const tabBind = ext[2] && ext[2].inner && Array.isArray(ext[2].inner.value) ? ext[2].inner.value[0] : null;
const escBind = ext[3] && Array.isArray(ext[3].value) ? ext[3].value[0] : null;
ok(tabBind && tabBind.key === 'Tab' && typeof tabBind.run === 'function', 'Tab 键位存在');
ok(escBind && escBind.key === 'Escape' && typeof escBind.run === 'function', 'Esc 键位存在');

const fakeView = {
  state: st,
  dispatch(tr) { this.state = this.state.update(tr).state; }
};
ok(tabBind.run(fakeView) === true, '有 ready 灰字时 Tab 返回 true');
ok(fakeView.state.doc.toString().indexOf('尾巴') > 0, 'Tab 把灰字写进了正文', fakeView.state.doc.toString());
ok(fakeView.state.field(API.field) === null, '采纳后灰字清掉');
ok(tabBind.run(fakeView) === false, '没有灰字时 Tab 返回 false（放行原生缩进）');
ok(escBind.run(fakeView) === false, '没有灰字时 Esc 也放行');

/* loading 阶段按 Tab 不能把空的灰字塞进正文 */
st = fakeView.state.update({ selection: { anchor: 2 } }).state;
st = st.update({ effects: API.setGhost.of({ pos: 2, text: '', status: 'loading' }) }).state;
const fake2 = { state: st, dispatch(tr) { this.state = this.state.update(tr).state; } };
ok(tabBind.run(fake2) === false, 'loading 阶段 Tab 不采纳（没内容）');
ok(escBind.run(fake2) === true, 'loading 阶段 Esc 能取消');

console.log('\n' + (fail === 0 ? '🎉 全部通过（' + pass + ' 项）' : '⚠️ ' + fail + ' 项未通过（共 ' + pass + ' 项通过）'));
process.exit(fail === 0 ? 0 : 1);
