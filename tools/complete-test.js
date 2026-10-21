/* 行内补全（阶段三）的纯逻辑测试
 * 用法：node tools/complete-test.js
 *
 * 这里不测 CodeMirror 的渲染 —— Node 里没有 document，也没有 @codemirror 模块。
 * 正好用来验证"拿不到 CM 模块时插件必须静默降级"。
 * 灰字的显示/采纳/丢弃靠 Obsidian 里手动验收（见 memory 里的验收步骤）。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/* ---------- 假 obsidian ---------- */
function fakeEl(tag) {
  const el = {
    tag: tag || 'div', textContent: '', title: '', value: '', style: {}, dataset: {},
    children: [], _classes: new Set(),
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
      el.children.push(c); c.parent = el; return c;
    },
    createDiv(o) { return el.createEl('div', o); },
    createSpan(o) { return el.createEl('span', o); },
    setText(t) { el.textContent = String(t); return el; },
    empty() { el.children = []; return el; },
    appendChild(c) { el.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, click() {}, remove() {}, scrollTo() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    insertBefore(c) { el.children.push(c); return c; },
    matches() { return false; }, closest() { return null; }
  };
  return el;
}
const obsidian = {
  Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = fakeEl('div'); } },
  Setting: class {
    constructor(c) { this.containerEl = c; }
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
    addSeparator() { return this; } showAtMouseEvent() {} showAtPosition() {} close() {} setParentElement() { return this; }
  },
  MarkdownView: class {},
  requestUrl: async function () { return { json: {}, status: 200 }; },
  setIcon: function () {},
  MarkdownRenderer: { renderMarkdown: function () {} },
  FuzzySuggestModal: class { constructor(app) { this.app = app; this.inputEl = fakeEl('input'); this.resultContainerEl = fakeEl('div'); } open() {} close() {} },
  debounce: function (f) { return f; }
};

const sandbox = {
  require: function (n) {
    if (n === 'obsidian') return obsidian;
    /* 关键：@codemirror/* 在 Node 里拿不到 —— 正好模拟"Obsidian 哪天改了内部结构" */
    throw new Error("Cannot find module '" + n + "'");
  },
  module: { exports: {} }, exports: {}, __filename: 'main.js', __dirname: ROOT,
  globalThis: null, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, isFinite,
  fetch: function () { return Promise.resolve({ ok: false }); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  TextEncoder, TextDecoder, Buffer, process, URL
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const withExport = src + '\n;globalThis.__T = {'
  + ' inFenceText: inFenceText, inFrontmatterText: inFrontmatterText,'
  + ' trimOverlap: trimOverlap, cleanCompletion: cleanCompletion,'
  + ' buildCompleteMessages: buildCompleteMessages, buildCompleteMeta: buildCompleteMeta,'
  + ' NO_THINK_MODES: NO_THINK_MODES, buildNoteProfile: buildNoteProfile,'
  + ' clipCodeFirstLine: clipCodeFirstLine,'
  + ' completionBudget: completionBudget, removeRepeatedPrefix: removeRepeatedPrefix,'
  + ' looksSemanticallyComplete: looksSemanticallyComplete,'
  + ' trimCompletionToBoundary: trimCompletionToBoundary,'
  + ' buildCompletionContext: buildCompletionContext,'
  + ' nearestBlockText: nearestBlockText, buildRequestMessages: buildRequestMessages,'
  + ' installCompleter: installCompleter, DEFAULT_SETTINGS: DEFAULT_SETTINGS,'
  + ' COMPLETE_SYSTEM: COMPLETE_SYSTEM, CM: CM };\n';
try {
  vm.runInContext(withExport, sandbox, { filename: 'main.js' });
} catch (e) {
  console.log('✗ 加载 main.js 失败：' + e.message);
  process.exit(1);
}
const T = sandbox.__T;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? '  → 实际：' + JSON.stringify(extra) : '')); }
}

console.log('\n=== ① 代码围栏判断（决定"代码块里补不补"） ===');
ok(T.inFenceText('普通一段话') === false, '没有围栏 → false');
ok(T.inFenceText('说明\n```js\nconst a = 1') === true, '围栏开着 → true');
ok(T.inFenceText('```js\nconst a = 1\n```\n后面是正文') === false, '围栏已闭合 → false');
ok(T.inFenceText('~~~\necho hi') === true, '~~~ 也算围栏');
ok(T.inFenceText('  ```\n缩进的围栏') === true, '缩进的围栏也认');
ok(T.inFenceText('```\n~~~\n```\n完了') === false, '不同类型不互相闭合，最后仍被 ``` 关掉');
ok(T.inFenceText('') === false, '空串不崩');

console.log('\n=== ② frontmatter 判断（防把正文补进属性块） ===');
ok(T.inFrontmatterText('---\ntitle: 测试', 20) === true, '属性块还没结束 → true');
ok(T.inFrontmatterText('---\ntitle: 测试\n---\n正文', 30) === false, '属性块已结束 → false');
ok(T.inFrontmatterText('正文第一行', 6) === false, '没有开头的 --- → false');
ok(T.inFrontmatterText('', 0) === false, '空串不崩');
ok(T.inFrontmatterText('---\n无换行的结尾---', 20) === true, '结尾的 --- 必须独立成行才算结束');

console.log('\n=== ③ 重叠咬合（模型爱把上文再抄一遍） ===');
ok(T.trimOverlap('今天天气很好', '天气很好，适合散步') === '，适合散步',
  '重复的 4 字开头被咬掉', T.trimOverlap('今天天气很好', '天气很好，适合散步'));
ok(T.trimOverlap('模型', '模型的回答') === '模型的回答',
  '短于 4 字的重叠不动（避免误伤正常重复）', T.trimOverlap('模型', '模型的回答'));
ok(T.trimOverlap('', '接着写') === '接着写', '上文为空 → 原样返回');
ok(T.trimOverlap('abc', '') === '', '补全为空 → 空');

console.log('\n=== ④ 清洗（吐出来的东西要能直接贴） ===');
ok(T.cleanCompletion('上文', '```\n下一句\n```') === '下一句', '整段被 ``` 包住 → 取里面');
ok(T.cleanCompletion('上文', '```js') === '', '只吐了个围栏开头 → 丢掉');
ok(T.cleanCompletion('上文', '补全：这句话') === '这句话', '去掉「补全：」前缀');
ok(T.cleanCompletion('上文', 'Completion: hello') === 'hello', '去掉英文前缀');
ok(T.cleanCompletion('上文', '   \n  ') === '', '纯空白 → 空（不显示灰字）');
ok(T.cleanCompletion('上文', '') === '', '空回复 → 空');
ok(T.cleanCompletion('第一行\n', '第二行') === '第二行', '正常续写原样保留');
ok(T.cleanCompletion('句子', '\n\n新段落') === '新段落', '上文没换行 → 去掉开头的空行');
ok(T.cleanCompletion('这', '这是一个很长很长的句子，应该有六十个字符以上才对吧？再补一点，让它超出去。', 20)
  .length <= 20, '超长时被截到上限内',
  T.cleanCompletion('这', '这是一个很长很长的句子，应该有六十个字符以上才对吧？再补一点，让它超出去。', 20));
ok(T.cleanCompletion('这', '第一句话。第二句话很长很长很长很长很长很长很长很长很长很长', 20) === '第一句话。',
  '截断尽量落在句号上（不把半句留给你）',
  T.cleanCompletion('这', '第一句话。第二句话很长很长很长很长很长很长很长很长很长很长', 20));
ok(T.cleanCompletion('今天天气很好', '今天天气很好，出门走走吧') === '，出门走走吧',
  '清洗里也做了一次重叠咬合', T.cleanCompletion('今天天气很好', '今天天气很好，出门走走吧'));
/* 流式期间用 quick：只做最必要的处理，截断走硬切（性能优先） */
ok(T.cleanCompletion('上文', '```有些乱码', 60, true) === '有些乱码', 'quick 模式也剥围栏');
ok(T.cleanCompletion('这', '一二三四五六七八九十', 20, true) === '一二三四五六七八九十',
  'quick 模式不折腾截断（长度没超）');
ok(T.cleanCompletion('这', '一'.repeat(50), 20, true).length === 20, 'quick 模式超长硬切');

console.log('\n=== ⑤ 上下文、提示词与 token 预算（照 editing-toolbar 复刻） ===');
const L = ['# 机房巡检', '', '## 网络', '- 检查交换机端口状态', '- 确认'];
const cx = T.buildCompletionContext(L, 4, 2);
ok(cx.headingPath === '机房巡检 > 网络', '标题路径拼出来了', cx.headingPath);
ok(cx.prefixPattern === '- ', '行首列表前缀 = "- "', cx.prefixPattern);
ok(cx.curBefore === '- ' && cx.curAfter === '确认', '光标前后切分正确', [cx.curBefore, cx.curAfter]);
ok(cx.prevBlock.indexOf('检查交换机端口状态') >= 0, '上一段带上了', cx.prevBlock);
ok(T.nearestBlockText(['a', '', 'b'], 0, 1) === 'a', '往下找最近段落');

const meta = T.buildCompleteMeta(cx);
ok(/cursor_line: 5/.test(meta), 'meta 里有行号', meta);
ok(/heading_path: 机房巡检 > 网络/.test(meta), 'meta 里有标题路径');
ok(/line_prefix_pattern: "- "/.test(meta), 'meta 里有行首前缀');
ok(/current_line_before_cursor/.test(meta), 'meta 里有光标前内容');

const msgs = T.buildCompleteMessages('上文\n', '下文', meta, '');
ok(msgs[0].role === 'system' && /inline writing assistant/.test(msgs[0].content),
  'system 是对方那句「inline writing assistant」');
ok(msgs[1].content.indexOf('Text before cursor:') > 0, 'user 里有 Text before cursor');
ok(msgs[1].content.indexOf('<CURSOR>') > 0, 'user 里有 <CURSOR> 标记');
ok(msgs[1].content.indexOf('Text after cursor:') > 0, 'user 里有 Text after cursor');
ok(msgs[1].content.indexOf('Local cursor metadata:') > 0, 'user 里带上了 meta');
ok(msgs[1].content.indexOf('draft continuation') < 0, '没有草稿时不加续写提示');
const msgs2 = T.buildCompleteMessages('上文', '下文', meta, '已经写了一半');
ok(msgs2[1].content.indexOf('draft continuation') > 0, '有草稿时提示"接着草稿写"');
ok(msgs2[1].content.indexOf('已经写了一半') > 0, '草稿拼在光标前文本后面');

/* token 预算：这是"思考吃光额度、正文为空"的解药 */
ok(T.completionBudget('随便一句', '后面还有', '', 1) === 140, '续写轮次预算 140');
ok(T.completionBudget('# ', '', '', 0) === 100, '只打了标题标记 → 100');
ok(T.completionBudget('-', '', '', 0) === 240, '只有列表标记（trimEnd 后是 -）→ 240');
ok(T.completionBudget('一句完整的话', '', '', 0) === 240, '普通情况 → 240（用户要求）');
ok(T.completionBudget('一句完整的话', '后面还有', '', 0) === 240, '后面有内容也是 240');

/* 续写去重 / 完成判断 / 截断 */
ok(T.removeRepeatedPrefix('今天天气很好', '今天天气很好，适合散步') === '，适合散步',
  '续写重复的前缀被咬掉', T.removeRepeatedPrefix('今天天气很好', '今天天气很好，适合散步'));
ok(T.removeRepeatedPrefix('', '全新内容') === '全新内容', '没有旧内容时原样返回');
ok(T.looksSemanticallyComplete('这是一句话。') === true, '句号结尾算讲完了');
ok(T.looksSemanticallyComplete('这是半句') === false, '没有标点算没讲完');
ok(T.looksSemanticallyComplete('- 已经写够八个字了') === true, '列表项够长也算讲完');
ok(T.trimCompletionToBoundary('短句。') === '短句。', '太短就不折腾（参考实现有 12 字下限）');
ok(T.trimCompletionToBoundary('第一句话写得比较完整的。第二句话还在继续写') === '第一句话写得比较完整的。',
  '够长时截到最后一个句读',
  T.trimCompletionToBoundary('第一句话写得比较完整的。第二句话还在继续写'));

console.log('\n=== ⑥ 限长（补全必须限 max_tokens） ===');
const cfgOa = { format: 'openai', baseUrl: 'http://192.0.2.10:8080/v1', model: 'm', apiKey: '' };
const cfgAn = { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' };
const cfgGo = { format: 'google', baseUrl: 'https://generativelanguage.googleapis.com', model: 'm', apiKey: 'k' };
const plainMsgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];

const b1 = JSON.parse(T.buildRequestMessages('openai', cfgOa, plainMsgs, 0.2, 96).body);
ok(b1.max_tokens === 96, 'openai：传了就带上 max_tokens', b1.max_tokens);
const b2 = JSON.parse(T.buildRequestMessages('openai', cfgOa, plainMsgs, 0.2).body);
ok(!('max_tokens' in b2), 'openai：没传就不加（沿用服务端默认）', Object.keys(b2));
const b3 = JSON.parse(T.buildRequestMessages('anthropic', cfgAn, plainMsgs, 0.2, 96).body);
ok(b3.max_tokens === 96, 'anthropic：用传入值', b3.max_tokens);
const b4 = JSON.parse(T.buildRequestMessages('anthropic', cfgAn, plainMsgs, 0.2).body);
ok(b4.max_tokens === 4096, 'anthropic：默认仍是 4096（普通动作不受影响）', b4.max_tokens);
const b5 = JSON.parse(T.buildRequestMessages('google', cfgGo, plainMsgs, 0.2, 96).body);
ok(b5.generationConfig.maxOutputTokens === 96, 'google：写进 maxOutputTokens', b5.generationConfig);
ok(JSON.parse(T.buildRequestMessages('openai', cfgOa, plainMsgs, 0.2, 96).body).stream === false,
  '补全不走流式');

console.log('\n=== ⑦ 拿不到 CodeMirror 时必须静默降级 ===');
ok(T.CM === null, 'Node 里没有 @codemirror → CM = null');
let threw = false, ext = 'x';
try { ext = T.installCompleter({ settings: {}, app: {} }); } catch (e) { threw = true; }
ok(!threw, 'installCompleter 不抛异常');
ok(ext === null, 'installCompleter 返回 null（onload 里据此跳过，不影响其它功能）', ext);

console.log('\n=== ⑧ 关掉思考（推理模型的关键） ===');
ok(Array.isArray(T.NO_THINK_MODES) && T.NO_THINK_MODES.length === 3, '三种写法备着', T.NO_THINK_MODES && T.NO_THINK_MODES.length);
ok(T.NO_THINK_MODES[0].reasoning_effort === 'none', '第一种是 reasoning_effort=none（实测最有效）');
ok(T.NO_THINK_MODES[1].thinking && T.NO_THINK_MODES[1].thinking.type === 'disabled', '第二种是 thinking.type=disabled');
ok(Object.keys(T.NO_THINK_MODES[2]).length === 0, '第三种是空对象（兼容一切服务的兜底）');
ok(/reasoning_effort/.test(src) && /thinking/.test(src), '请求层里能塞这些字段');

console.log('\n=== ⑨ 整篇笔记画像 ===');
const noteRaw = [
  '# 机房巡检手册',
  '',
  '本文记录日常巡检流程。',
  '',
  '## 网络',
  '- 检查 [[核心交换机]] 的端口状态',
  '- 运行 `show interface` 看丢包',
  '',
  '## 电源',
  '- 检查 UPS 负载',
].join('\n');
const prof = T.buildNoteProfile(noteRaw);
ok(/Document outline:/.test(prof), '有标题大纲');
ok(/# 机房巡检手册/.test(prof) && /## 网络/.test(prof), '大纲含各级标题');
ok(/Notes linked from this document: 核心交换机/.test(prof), '提取了双链目标', prof.slice(0, 120));
ok(/Terms used in this document: show interface/.test(prof), '提取了行内术语');
ok(/Document excerpt/.test(prof), '带正文节选供参考语气');
ok(T.buildNoteProfile('')  === '', '空笔记不崩也不产垃圾');
ok(!/Document outline:/.test(T.buildNoteProfile('只有一段话没有标题')), '没标题就不硬塞大纲');

/* 提示词里要能带上整篇背景 */
const msgs3 = T.buildCompleteMessages('上文', '下文', 'meta', '', prof);
ok(msgs3[1].content.indexOf('Whole-document background') > 0, '整篇背景进了 prompt');
ok(Array.isArray(T.buildCompleteMessages('上文', '下文', 'meta', '')), '不传整篇背景也能用');

console.log('\n=== ⑩ 关思考只作用于补全 ===');
ok((src.match(/sendMessages\([^)]*NO_THINK_MODES/g) || []).length === 1,
  '只有 1 处调用传了关思考参数（就是补全）');
ok(!/chatMessages\([^)]*NO_THINK_MODES/.test(src), 'chatMessages（润色/翻译等）不带');
ok(!/chatOnce\([^)]*NO_THINK_MODES/.test(src), 'chatOnce（测试连接）不带');

console.log('\n=== ⑩½ 代码块只补一行 ===');
ok(T.clipCodeFirstLine('interface Vlan-interface 62\nquit') === 'interface Vlan-interface 62',
  '两条命令只留第一条', T.clipCodeFirstLine('interface Vlan-interface 62\nquit'));
ok(T.clipCodeFirstLine('\n\ninterface Vlan-interface 62\nquit') === 'interface Vlan-interface 62',
  '前导空行先去掉');
ok(T.clipCodeFirstLine('interface Vlan-interface 62') === 'interface Vlan-interface 62', '本来就一行时原样');
ok(T.clipCodeFirstLine('') === '', '空串不崩');
ok(T.clipCodeFirstLine('ip route 1.1.1.1 255.255.255.255 \\\n  2.2.2.2') ===
  'ip route 1.1.1.1 255.255.255.255 \\\n  2.2.2.2', '以反斜杠结尾 → 保留续行',
  JSON.stringify(T.clipCodeFirstLine('ip route 1.1.1.1 255.255.255.255 \\\n  2.2.2.2')));
ok(T.clipCodeFirstLine('docker run -d \\\n  nginx') === 'docker run -d \\\n  nginx', 'docker 续行也保留');
ok(T.clipCodeFirstLine('cat a.txt |\ngrep x') === 'cat a.txt |\ngrep x', '管道结尾保留续行');
ok(T.clipCodeFirstLine('a &&\nb') === 'a &&\nb', '&& 结尾保留续行');

/* 提示词里也要说清楚（双保险：模型听话 + 代码兜底） */
const codeMsgs = T.buildCompleteMessages('p', 's', 'm', '', '', true);
ok(codeMsgs[1].content.indexOf('exactly ONE command line') > 0, '代码块里明确要求只输出一行');
const textMsgs = T.buildCompleteMessages('p', 's', 'm', '', '', false);
ok(textMsgs[1].content.indexOf('exactly ONE command line') < 0, '正文里不加这条约束');

console.log('\n=== ⑪ 优于参考实现的几处增强 ===');
ok(/addEventListener\('compositionend'/.test(src), '监听输入法组合结束（修"只有空格/标点才补"）');
ok(/removeEventListener\('compositionend'/.test(src), 'destroy 时解绑，不会泄漏');
ok(/muteUntil/.test(src) && /12000/.test(src), 'Esc 之后静默 12 秒');
ok(/completeChain/.test(src), 'Tab 采纳后自动补下一句');
ok(/view\.plugin\(completer\)/.test(src), '连续补全通过 view.plugin 拿实例');
ok(/Math\.round\(380 \/ parts\.length\)/.test(src), '打字机按块数反算步长（长文本不拖）');
ok(/lastPillAt/.test(src), '即时药丸有 120ms 节流');

console.log('\n=== ⑫ 默认值 ===');
const D = T.DEFAULT_SETTINGS;
ok(D.complete === false, '行内补全默认关');
ok(D.completeCode === false, '代码块补全默认关');
ok(D.completeDelay === 400, '默认 400ms 触发（药丸是即时的）');
ok(D.completeMax === 120, '默认最多 120 字');
ok(D.completeNoteContext === false, '整篇参考默认关（开了会慢一点）');
ok(D.completeChain === true, '连续补全默认开');
ok(D.completeCodeOneLine === true, '代码块只补一行默认开');
ok(D.completeProvider === '', '默认跟随顶部设置');

console.log('\n' + (fail === 0 ? '🎉 全部通过（' + pass + ' 项）' : '⚠️ ' + fail + ' 项未通过（共 ' + pass + ' 项通过）'));
process.exit(fail === 0 ? 0 : 1);
