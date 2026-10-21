/* 发布前检查（push 到 GitHub 之前跑一次）
 *   node tools/release-check.js
 *
 * 和 audit.js 的分工：
 *   audit.js         —— 日常改完就跑，查"代码本身有没有病"
 *   release-check.js —— 发布前跑，查"会不会把你的隐私带上公网" + 仓库完整性
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let problems = 0, warns = 0;
function head(t) { console.log('\n=== ' + t + ' ==='); }
function bad(m) { problems++; console.log('  ❌ ' + m); }
function warn(m) { warns++; console.log('  ⚠️  ' + m); }
function good(m) { console.log('  ✅ ' + m); }

const SHIP = ['main.js', 'manifest.json', 'styles.css', 'README.md'];

/* 白名单：这些是"看起来像密钥、其实不是"的固定常量。
   OBF_KEY 是混淆盐（防随手看，不是加密），公开它不泄露任何用户数据。 */
const ALLOW = [
  /'jMrwmm0BsAPLVMT0g1MbtkSYLnN6qnnhab1p0LvgcvnuIWSiiLHu5YvEauXzWyBS'/,
];
const textOf = {};
SHIP.forEach(function (f) {
  const p = path.join(ROOT, f);
  textOf[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
});

/* ---------- 1. 敏感信息（最重要） ---------- */
head('1. 敏感信息扫描（会随代码上公网的东西）');
const leakRules = [
  { name: '内网 / 公网 IPv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { name: '本机绝对路径', re: /(?:\/Users\/|\/home\/|[A-Za-z]:\\\\)[^\s'"`]+/g },
  { name: 'API Key 形态', re: /\b(?:sk|pk|ak)-[A-Za-z0-9_-]{16,}/g },
  { name: 'Bearer 明文', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: '疑似 base64 密钥', re: /['"][A-Za-z0-9+/]{40,}={0,2}['"]/g },
  { name: '内部文档 / 私有路径引用', re: /(?:知识库|插件手册|设计说明|私有仓库|\/Users\/[^\s'"`]*)/g },
];
let leaked = 0;
SHIP.forEach(function (f) {
  if (!textOf[f]) return;
  leakRules.forEach(function (r) {
    const hits = textOf[f].match(r.re);
    if (hits) {
      /* 版本号像 1.2.3 会被 IPv4 正则误伤，过滤掉纯版本号样式 */
      const real = hits.filter(function (x) {
        if (r.name.indexOf('IPv4') >= 0 && /^\d+\.\d+\.\d+$/.test(x)) return false;
        return !ALLOW.some(function (a) { return a.test(x); });
      });
      if (real.length) {
        leaked++;
        bad(f + ' 含【' + r.name + '】：' + real.slice(0, 3).join(' , '));
      }
    }
  });
});
if (!leaked) good('公开文件里没有 IP、本机路径、明文密钥、内部文档引用');

/* ---------- 2. 绝对不能发布的文件 ---------- */
head('2. 不该进仓库的文件');
const giPath = path.join(ROOT, '.gitignore');
const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
const NEVER = ['data.json', '.DS_Store', 'node_modules'];
NEVER.forEach(function (f) {
  if (!fs.existsSync(path.join(ROOT, f))) return;
  const re = new RegExp('(^|\\n)\\s*' + f.replace(/\./g, '\\.') + '\\s*($|\\n)');
  if (gi && re.test(gi)) {
    good(f + ' 已被 .gitignore 排除（⚠ 别用 git add -f 强加）');
  } else {
    bad('目录里有 ' + f + '，且 .gitignore 没排除它');
  }
});
if (fs.existsSync(path.join(ROOT, 'data.json'))) {
  const d = fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8');
  const ips = d.match(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g);
  if (ips) console.log('     ↳ 注意：data.json 里有真实内网地址 ' + Array.from(new Set(ips)).join(', '));
  if (/apiKey"\s*:\s*"[^"]{8,}"/.test(d)) console.log('     ↳ 注意：data.json 里也有加密后的 API Key');
  console.log('     ↳ 这三个文件才是发布用的：main.js / manifest.json / styles.css');
}

/* ---------- 3. 发布必需文件 ---------- */
head('3. 开源仓库必需文件');
const NEED = [
  ['README.md', '项目说明（截图 + 安装 + 用法）'],
  ['LICENSE', '开源协议（MIT 等）'],
  ['.gitignore', '忽略 data.json / .DS_Store'],
  ['versions.json', 'Obsidian 社区插件提交需要'],
];
NEED.forEach(function (it) {
  if (fs.existsSync(path.join(ROOT, it[0]))) good(it[0] + ' 存在');
  else bad('缺 ' + it[0] + '（' + it[1] + '）');
});

/* ---------- 4. manifest ---------- */
head('4. manifest.json');
let mf = null;
try { mf = JSON.parse(textOf['manifest.json']); } catch (e) { bad('manifest.json 不是合法 JSON'); }
if (mf) {
  ['id', 'name', 'version', 'minAppVersion', 'description', 'author'].forEach(function (k) {
    if (!mf[k]) bad('缺字段 ' + k);
  });
  const folderName = path.basename(ROOT);
  if (mf.id !== folderName) bad('id 与文件夹名不一致：' + mf.id + ' ≠ ' + folderName);
  else good('id = ' + mf.id + '（与文件夹名一致）');
  if (mf.description && mf.description.length > 250) bad('description 过长（' + mf.description.length + '）');
  else good('description 长度 ' + (mf.description || '').length);
  if (typeof mf.isDesktopOnly !== 'boolean') bad('缺 isDesktopOnly');
  if (!/^\d+\.\d+\.\d+$/.test(mf.version)) bad('version 不是 x.y.z：' + mf.version);
  else good('version = ' + mf.version);
}

/* ---------- 5. 代码卫生 ---------- */
head('5. 代码卫生');
const js = textOf['main.js'] || '';

const emptyCatch = (js.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || []).length;
if (emptyCatch > 20) warn('空 catch 有 ' + emptyCatch + ' 处（吞掉异常，排查时看不到原因）');
else good('空 catch ' + emptyCatch + ' 处（多为 DOM 操作兜底，可接受）');

const vars = (js.match(/^\s*var\s+/gm) || []).length;
if (vars) bad('还在用 var：' + vars + ' 处');
else good('没有 var，全是 const/let');

const logs = (js.match(/console\.log\s*\(/g) || []).length;
if (logs) bad('残留 console.log：' + logs + ' 处');
else good('没有 console.log');

if (/\bdebugger\b/.test(js)) bad('残留 debugger');
else good('没有 debugger');

const todos = (js.match(/\b(?:TODO|FIXME|XXX)\b/g) || []).length;
if (todos) warn('TODO/FIXME ' + todos + ' 处');
else good('没有 TODO/FIXME');

/* 超长函数：按缩进 2 的空格方法边界粗测 */
const longFns = [];
const lines = js.split('\n');
let cur = null, start = 0, depth = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (!cur) {
    const m = l.match(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/);
    if (m) { cur = m[1]; start = i; depth = 1; }
  } else {
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    if (depth <= 0) {
      const n = i - start + 1;
      if (n > 150) longFns.push(cur + ' (' + n + ' 行)');
      cur = null;
    }
  }
}
if (longFns.length) warn('超长函数：' + longFns.join(' / '));
else good('没有超过 150 行的函数');

/* 重复行（连续 8 行完全相同 = 复制粘贴痕迹） */
const sig = [];
for (let i = 0; i + 8 <= lines.length; i++) {
  const block = lines.slice(i, i + 8).join('\n');
  if (block.replace(/\s/g, '').length > 80) sig.push(block);
}
const dupCount = sig.length - new Set(sig).size;
if (dupCount > 3) warn('有 ' + dupCount + ' 处 8 行重复块（可能有复制粘贴的屎山）');
else good('没有明显的复制粘贴块');

/* ---------- 6. 运行时风险 ---------- */
head('6. 运行时风险');
const asyncTimers = (js.match(/setTimeout\s*\(\s*async\s*\(/g) || []).length;
if (asyncTimers) bad('setTimeout 里直接写 async（异常会变成 unhandled rejection）：' + asyncTimers + ' 处');
else good('setTimeout 里没有 async 函数');

const thenNoCatch = (js.match(/\.then\s*\(/g) || []).length;
console.log('  .then() ' + thenNoCatch + ' 处（需人工确认都有 catch/二参）');

const fileSize = fs.statSync(path.join(ROOT, 'main.js')).size;
console.log('  main.js 体积 ' + (fileSize / 1024).toFixed(0) + ' KB');
if (fileSize > 600 * 1024) warn('单文件超过 600KB，建议拆模块');
else good('体积正常');

/* ---------- 7. tools 目录 ---------- */
head('7. 测试 / 检查脚本');
const tools = fs.existsSync(path.join(ROOT, 'tools')) ? fs.readdirSync(path.join(ROOT, 'tools')) : [];
console.log('  ' + tools.length + ' 个：' + tools.join(' , '));
if (tools.some(function (f) { return /test|audit|check/.test(f); })) {
  good('有一套可复跑的测试/检查脚本（发布时保留，体现工程质量）');
}

/* ---------- 8. 真实 git 暂存测试（--git） ---------- */
if (process.argv.indexOf('--git') >= 0) {
  head('8. 真实 git 暂存测试（在临时目录模拟一次提交）');
  const os = require('os');
  const cp = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obai-git-'));
  try {
    ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE', '.gitignore', 'versions.json']
      .forEach(function (f) {
        if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
      });
    if (fs.existsSync(path.join(ROOT, 'tools'))) {
      fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true });
    }
    /* 用空文件模拟"这两个文件确实存在"，验证 .gitignore 是否真的拦得住 */
    fs.writeFileSync(path.join(tmp, 'data.json'), '');
    fs.writeFileSync(path.join(tmp, '.DS_Store'), '');

    cp.execSync('git init -q && git add -A', { cwd: tmp, stdio: 'ignore' });
    const staged = cp.execSync('git ls-files', { cwd: tmp, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    const bads = staged.filter(function (f) { return /(^|\/)(data\.json|\.DS_Store)$/.test(f); });

    if (bads.length) bad('这些不该进仓库却被暂存了：' + bads.join(', '));
    else good('暂存 ' + staged.length + ' 个文件；data.json 与 .DS_Store 均未被加入');
    console.log('     将提交：' + staged.join(' , '));
  } catch (e) {
    warn('git 模拟没跑成（可能没装 git）：' + String(e && e.message || e));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }
}

console.log('\n' + (problems
  ? '❌ 有 ' + problems + ' 个必须修的问题' + (warns ? '、' + warns + ' 个建议' : '')
  : '✅ 发布检查通过' + (warns ? '（' + warns + ' 个建议项）' : '')));
process.exit(problems ? 1 : 0);
