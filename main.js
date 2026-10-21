'use strict';
/* Hadesr AI —— 选中文字交给 AI 处理，支持行内补全。 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, Menu, MarkdownView, requestUrl, setIcon, MarkdownRenderer, FuzzySuggestModal } = require('obsidian');

/* 密钥混淆（RC4 + base64，不是加密）：只避免明文出现在 data.json。
   OBF_KEY 是固定盐，不是任何人的 API Key。 */
const OBF_KEY = 'jMrwmm0BsAPLVMT0g1MbtkSYLnN6qnnhab1p0LvgcvnuIWSiiLHu5YvEauXzWyBS';
const OBF_TAG = 'obai1:';
const OBF_MARK = 'hadesr-obai-v1|';

function rc4(keyStr, data) {
  const keyBytes = new TextEncoder().encode(keyStr);
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + keyBytes[i % keyBytes.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    j = (j + S[a]) & 255;
    const t = S[a]; S[a] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[a] + S[j]) & 255];
  }
  return out;
}

function encStr(s) {
  if (!s) return '';
  try {
    const raw = new TextEncoder().encode(OBF_MARK + String(s));
    let bin = '';
    new Uint8Array(rc4(OBF_KEY, raw)).forEach((b) => { bin += String.fromCharCode(b); });
    return OBF_TAG + btoa(bin);
  } catch (e) { return String(s); }
}

function decStr(t) {
  if (!t) return '';
  const s = String(t);
  if (!s.startsWith(OBF_TAG)) return s;      /* 明文（老数据 / 手动填的）→ 原样用 */
  try {
    const bin = atob(s.slice(OBF_TAG.length));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const out = new TextDecoder().decode(rc4(OBF_KEY, arr));
    if (!out.startsWith(OBF_MARK)) return '';  /* 校验不过：密文与密钥不匹配 */
    return out.slice(OBF_MARK.length);
  } catch (e) { return ''; }
}

/* ============================ 调试开关（默认关）
   代码里有一批"静默兜底"的 catch：失败不影响主流程，所以平时不打扰用户。
   但排查问题时（AI 没反应、补全不出字、结果写不回去）光看现象猜不到是哪一步断了，
   于是把这批兜底接上一个开关：开着时把被吞掉的异常打到控制台（[obai] …），关着时完全静默。
   DEBUG 是模块级变量，由插件在 loadSettings / 开关变化时同步。 */
let DEBUG = false;
function setDebug(on) { DEBUG = !!on; }
function dlog(tag, e, extra) {
  if (!DEBUG) return;
  try {
    const msg = String((e && e.message) || e || '');
    if (extra !== undefined) console.warn('[obai] ' + tag, e, extra);
    else if (e) console.warn('[obai] ' + tag + ' ——', msg || e);
    else console.warn('[obai] ' + tag);
  } catch (_) { /* 控制台本身不可用也不该崩主流程 */ }
}

/* ============================ 通用 system prompt
   设计：**一条通用规则 + 每个动作一句短指令**，比给每个动作写长提示词更稳。
   这条把三件事说死了：① 保持 Obsidian Markdown 合法 ② 只输出正文 ③ 不许中途截断。 */
const BASE_SYSTEM = '你是 Obsidian 里的编辑助手。按用户指令改写、转换或生成文本。'
  + '尽量保持 Obsidian 风格 Markdown 的合法与完整 —— 包括 [[双链]]、![[嵌入]]、> [!callout] 标注块、'
  + '任务列表、表格、属性（frontmatter）、行内格式；除非指令明确要求改变格式。'
  + '只返回最终正文：不要解释、不要用 ``` 包起来、不要加引号。'
  + '不要在列表项中间、表格行中间、YAML 块中间或 JSON 结构中间截断。'
  + '如果你会输出思考过程，也请用中文写。';

/* 动作定义：每个动作只给一句 instruction，通用规则由 BASE_SYSTEM 提供。
   name = 菜单名，doing = 「AI 正在…」后的说法，pill = 胶囊上显示的字。 */
const ACTIONS = [
  { id: 'polish',    name: '润色',     icon: 'wand-2',
    instruction: '改善下面这段文字的表达：更通顺、更精炼、用词更准确，但不改变原意、不增删事实、不改变语言。' },

  { id: 'fix',       name: '纠错',     icon: 'spell-check',
    instruction: '只修正下面这段文字里的错别字、别字和语法错误。其余一律原样保留，不要改风格、不要换词、不要调语序。' },

  { id: 'condense',  name: '精简',     icon: 'minimize-2',
    instruction: '把下面这段文字压缩到尽可能短，但不丢任何事实、数字、命令、路径和结论；删掉重复、铺垫和修饰语。' },

  { id: 'expand',    name: '扩写',     icon: 'maximize-2',
    instruction: '把下面这段文字展开写细：补上省略的步骤、理由、例子和注意事项。只能基于原文已有事实展开，缺的信息用「（可补充：…）」标出来，不要编造。' },

  { id: 'simplify',  name: '简化语言', icon: 'align-left',
    instruction: '用更简单的词和更短的句子重写下面这段文字，让外行 / 初中生也能读懂：把术语换成日常说法（必要的专有名词保留并紧跟一句解释）。'
      + '不改变原意、不丢信息，也**不要刻意缩短篇幅** —— 这一项只管"降低难度"，不管"变短"。' },

  { id: 'formal',    name: '专业语气', doing: '改写成专业语气', icon: 'briefcase',
    instruction: '把下面这段文字改写成专业、正式的书面语，适合工作汇报、邮件或技术文档：去掉口头语和感叹，用完整句，统一称谓与术语。' },

  { id: 'casual',    name: '口语语气', doing: '改写成口语', icon: 'message-circle',
    instruction: '把下面这段文字改写成自然口语，像跟同事当面说话：用短句、去掉书面套话，可以带"其实 / 就是说"这类语气词。' },

  { id: 'explain',   name: '解释',     icon: 'help-circle',
    instruction: '解释下面这段内容在说什么：关键术语是什么意思、为什么这样写或这样做。用中文大白话，必要时举例；引用代码时保持原样。' },

  { id: 'summarize', name: '总结',     icon: 'list-collapse',
    instruction: '总结下面这段内容：第一行给一句话结论，然后列 3～6 条要点。保留关键数字、命令、路径、人名等事实，不要臆造。' },

  { id: 'continue',  name: '续写',     icon: 'pen-line',
    instruction: '接着下面这段内容自然地往下写 1～3 段，语气与风格保持一致。不要重复已有内容，不要总结前文，不要写"接下来……"这类过渡语。' },

  { id: 'totable',   name: '转表格',   doing: '转成表格', icon: 'table',
    instruction: '把下面这段内容整理成一张 Markdown 表格：自己判断 2～5 个合适的列，表头用中文短词。原文没有的信息不要编。' },

  { id: 'tolist',    name: '转列表',   doing: '转成列表', icon: 'list',
    instruction: '把下面这段内容拆成分条列表：每条一句话，按逻辑顺序排，可以带二级列表。原文没有的信息不要编。' },

  { id: 'tocode',    name: '转代码块', doing: '转成代码块', icon: 'code',
    instruction: '把下面这段内容整理成一个 Markdown 围栏代码块：先判断类型选合适的语言标记（shell / powershell / bash / python / json / yaml / conf 等）；'
      + '命令或配置一行一条；解释性文字写成 # 注释放在对应行上方。原文没有的命令不要编造。只输出代码块本身。' },

  { id: 'todos',     name: '提取待办', icon: 'check-square',
    instruction: '从下面这段内容里抽出可以行动的待办事项，输出成 Markdown 复选框列表（- [ ] …）。每条以动词开头、写清对象；能看出负责人或时间就写在后面。没有待办就只输出「（没找到可执行的待办）」。' },

  { id: 'trans-zh',  name: '中文', pill: '翻译成中文', doing: '翻译成中文', icon: 'languages',
    instruction: '**不管下面是什么语言，一律翻译成简体中文。**'
      + '（英语、日语、法语、韩语……全都译成中文；只有原文本来就是简体中文时，才原样返回。）'
      + '代码块、行内代码、命令、路径、专有名词保持原样不译。' },

  { id: 'trans-en',  name: '英文', pill: '翻译成英文', doing: '翻译成英文', icon: 'languages',
    instruction: '**不管下面是什么语言，一律翻译成英文。**'
      + '（中文、日语、法语、韩语……全都译成英文；只有原文本来就是英文时，才原样返回。）'
      + '代码块、行内代码、命令、路径、专有名词保持原样不译。' },
];

/* ============================ 接口格式
   三种都封装在这里 —— 加格式只要在这里补一条，请求层和 UI 会自动跟上。 */
const FORMATS = {
  openai: {
    label: 'OpenAI 兼容',
    hint: 'vLLM / Ollama / DeepSeek / 千问 / 绝大多数服务。地址填到 /v1 为止',
    urlPlaceholder: 'http://你的地址:端口/v1',
    needsKey: false,
  },
  anthropic: {
    label: 'Anthropic 兼容',
    hint: 'Claude 官方 / DeepSeek 的 /anthropic 端点。地址填到域名或末尾 /v1',
    urlPlaceholder: 'https://api.anthropic.com',
    needsKey: true,
  },
  google: {
    label: 'Google 兼容',
    hint: 'Gemini API。地址填到 generativelanguage.googleapis.com 即可',
    urlPlaceholder: 'https://generativelanguage.googleapis.com',
    needsKey: true,
  },
};
const FORMAT_KEYS = Object.keys(FORMATS);

/* 首次安装时预置的接口（用户可随意增删改） */
const SEED_PROVIDERS = [
  { id: 'local',    name: '本地',              format: 'openai', baseUrl: '', model: '' },
  { id: 'deepseek', name: 'DeepSeek',          format: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
  { id: 'qwen',     name: '千问（DashScope）', format: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
];

const MODE_AUTO = 'auto';

/* 对话窗口里「一点就填」的提示词模板（可增删改）。
   ⚠ 这 7 条是**从同类插件源码里原样搬过来的**默认模板，变量名也一致，
     所以 `{{selection}}` / `{{file:content}}` / `{{date}}` 在这里都能直接用。 */
const DEFAULT_TEMPLATES = [
  {
    id: 't-summary',
    name: '📝 总结要点',
    text: '分析 {{file:content}} 的内容结构,重点关注:\n{{selection}}\n\n请提供:\n1. 内容概要\n2. 关键要点\n3. 改进建议',
  },
  {
    id: 't-task',
    name: '提炼任务',
    text: '当前日期{{date}}，从 {{file:content}} 中提取所有待办事项，重点关注:\n{{selection}}\n\n请严格按 Obsidian Tasks 插件格式输出，每条任务单独一行：\n\n- [ ] 任务描述 ⏫/🔼/🔽/⏬ 优先级\n- [ ] 任务描述 📅 YYYY-MM-DD 截止日期\n- [ ] 任务描述 ⏰ YYYY-MM-DD HH:mm 提醒时间\n- [ ] 任务描述 🛫 YYYY-MM-DD 开始日期\n- [ ] 任务描述 🔁 every day/week/month 重复周期\n- [ ] 任务描述 #标签 #项目名\n\n提取规则：\n1. 如果原文提到"紧急/马上/立即/今天"，添加 ⏫（最高优先级）\n2. 如果提到"明天/本周/尽快"，添加 🔼（高优先级）\n3. 如果提到具体日期，转换为 📅 YYYY-MM-DD 格式\n4. 如果提到时间，转换为 ⏰ YYYY-MM-DD HH:mm 格式\n5. 如果提到周期性工作，添加 🔁 every week/month\n6. 为每个任务添加合适的标签（如 #工作 #会议 #跟进）\n\n示例输出：\n- [ ] 完成项目报告 ⏫ 📅 2026-04-25 #工作\n- [ ] 每周团队例会 🔁 every week on Monday ⏰ 09:00 #会议\n- [ ] 跟进客户需求 🔼 📅 2026-04-23 #跟进',
  },
  {
    id: 't-dataview',
    name: '生成 Dataview',
    text: '根据我的需求,帮我生成一个 Obsidian Dataview 查询代码块。要求:\n1. 使用 DataviewJS 或 DQL 语法\n2. 包含必要的字段筛选和排序\n3. 添加注释说明每个部分的作用\n4. 如果需要复杂逻辑,使用 DataviewJS\n\n我的需求:',
  },
  {
    id: 't-templater',
    name: '设计 Templater 模板',
    text: '帮我设计一个 Obsidian Templater 模板。要求:\n1. 使用 Templater 语法 (<%  %>)\n2. 包含动态日期、时间等变量\n3. 支持用户输入提示\n4. 添加必要的条件判断和循环\n5. 注释说明每个部分的用途\n\n模板用途:',
  },
  {
    id: 't-mermaid',
    name: '绘制 Mermaid 图表',
    text: '根据我选中的文本内容 {{selection}},生成 Mermaid 图表代码。要求:\n1. 选择合适的图表类型(流程图/时序图/类图/甘特图等)\n2. 使用清晰的节点命名\n3. 添加必要的样式和注释\n4. 确保语法正确可渲染\n',
  },
  {
    id: 't-yaml',
    name: '设计 YAML',
    text: '根据当前笔记内容 {{file:content}},帮我设计一个适合当前笔记的 YAML Frontmatter 元数据结构。要求:\n1. 根据笔记内容推荐合适的字段\n2. 包含常用字段(tags, aliases, date等)\n3. 添加自定义字段建议\n4. 注释说明每个字段的用途\n\n笔记类型:',
  },
  {
    id: 't-callout',
    name: '使用Callout包装',
    text: '根据我选中的文本内容 {{selection}},帮我使用 Obsidian Callout 块进行包装。要求:\n1. 选择合适的 callout 类型(note/tip/warning/danger等)\n2. 支持嵌套和折叠\n3. 包含标题和内容\n4. 可以包含代码块或列表\n\n内容需求:',
  },
];

const DEFAULT_SETTINGS = {
  mode: 'manual',
  activeProvider: 'deepseek',
  providers: SEED_PROVIDERS.map(function (f) {
    return { id: f.id, name: f.name, format: f.format, baseUrl: f.baseUrl, apiKey: '', model: f.model };
  }),
  temperature: 0.3,
  selectionBubble: true,      /* 选中文字是否浮出小工具条 */
  bubblePosition: 'below',    /* 浮条位置：below 选区下方 / above 上方 */
  customActions: [],          /* [{ id, name, icon, system }] */
  actionProviders: {},        /* { [动作id]: 接口id } —— 为空表示跟随顶部设置 */
  promptTemplates: DEFAULT_TEMPLATES.map(function (t) { return { id: t.id, name: t.name, text: t.text }; }),
  stream: true,               /* 流式输出：边生成边显示，失败自动退回普通请求 */
  fmZh: false,                /* 生成的 YAML 字段名用中文（标题 / 摘要）；默认关，用 title / summary */
  promptHistory: [],          /* 对话框「↺ 最近用过」的历史（最多 20 条） */

  /* ── 行内补全（阶段三）──
     默认**关**：它会在你每次停手时发一次请求，用得多才值得开。
     代码块内默认也关 —— 补错的网络命令风险太高。 */
  complete: false,            /* 总开关：光标后用灰字猜下文 */
  completeCode: false,        /* 代码块里也补 */
  completeDelay: 400,         /* 停手多少毫秒后触发（药丸是即时的，这里只决定何时真正发请求） */
  completeMax: 120,           /* 一次最多补多少个字（只作保险；正常由模型自己说完一句就收） */
  completeProvider: '',       /* '' = 跟随顶部设置；否则固定某个接口（建议用小模型） */
  completeTrigger: 'auto',    /* auto = 停手后自动补；manual = 只在命令里补 */
  completeHintShown: false,   /* 「按 Tab 采纳」只提示一次 */
  completeNoteContext: false, /* 补全时参考整篇笔记（更懂术语与风格，代价是首字慢一点） */
  completeChain: true,        /* Tab 采纳后自动猜下一句（连续写作） */
  completeCodeOneLine: true,  /* 代码块里只补一行命令（模型爱把下一条也带上） */
  actionPrompts: {},          /* 覆盖内置动作的提示词：{ actionId: '...' } */
  chatHistory: [],            /* 最近的对话（只存提问与回答，不含选中的正文） */
  rememberChat: true,         /* 是否记录对话历史 */
  debug: false,               /* 调试开关：开着时把被静默兜底的异常打到控制台（[obai] …） */

};

/* 除 16 个正文动作外，这几处入口也支持单独指定接口（id 必须与代码读写一致）。 */
/* 「快速改写」的特殊身份：它不是 16 个动作之一，但用户希望胶囊也记住它
   （用过一次之后，下次选中文字，主按钮直接就是「✦ AI 快速改写」）。 */
const QUICK_TARGET = { id: 'quick-rewrite', name: '快速改写', pill: '快速改写', icon: 'pen-line', quick: true };

const PROVIDER_EXTRA_TARGETS = [
  { id: 'frontmatter', name: '添加笔记属性' },
  { id: 'to-canvas', name: '转 Canvas' },
  { id: 'quick-rewrite', name: '快速改写' },
  { id: 'chat', name: 'AI 对话' },
];

/* 内置 + 自定义，统一成同一个形状（后面的菜单/命令只认这个） */
function allActions(s) {
  const custom = ((s && s.customActions) || [])
    .filter(function (c) { return c && c.name && c.system; })
    .map(function (c) {
      return { id: c.id, name: c.name, icon: c.icon || 'sparkles', instruction: c.system || '', custom: true };
    });
  return ACTIONS.concat(custom);
}

/* 请求层 */

function trimBase(b) { return String(b || '').trim().replace(/\/+$/, ''); }

/* Anthropic：base 已带 /v1 就用 /messages，否则补 /v1/messages */
function anthropicUrl(base) {
  const b = trimBase(base);
  return /\/v1$/i.test(b) ? b + '/messages' : b + '/v1/messages';
}
function anthropicModelsUrl(base) {
  const b = trimBase(base);
  return /\/v1$/i.test(b) ? b + '/models' : b + '/v1/models';
}
/* Google：base 带 /v1beta 就用，否则补 */
function googleBase(base) {
  const b = trimBase(base);
  return /\/v1(beta)?[0-9]*$/i.test(b) ? b : b + '/v1beta';
}

/* 把 [{role,content}] 拼成各家的请求体 —— 多轮对话和单次动作共用这一层。
   role 只认 system / user / assistant；Anthropic 与 Google 的 system 是单独字段，得拆出来。 */
function buildRequestMessages(fmt, cfg, messages, temperature, maxTokens) {
  const base = trimBase(cfg.baseUrl);
  const key = decStr(cfg.apiKey);
  const msgs = (messages || []).filter(function (m) { return m && m.content; });
  const sys = msgs.filter(function (m) { return m.role === 'system'; })
    .map(function (m) { return m.content; }).join('\n\n');
  const turns = msgs.filter(function (m) { return m.role !== 'system'; });

  if (fmt === 'anthropic') {
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (key) headers['x-api-key'] = key;
    return {
      url: anthropicUrl(base),
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens || 4096,
        system: sys,
        messages: turns.map(function (m) {
          return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
        }),
        temperature: temperature,
      }),
    };
  }

  if (fmt === 'google') {
    const model = String(cfg.model || '').replace(/^models\//i, '');
    const url = googleBase(base) + '/models/' + encodeURIComponent(model) + ':generateContent'
      + (key ? '?key=' + encodeURIComponent(key) : '');
    const contents = turns.map(function (m) {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    });
    const gc = { temperature: temperature };
    if (maxTokens) gc.maxOutputTokens = maxTokens;
    const body = { contents: contents, generationConfig: gc };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    return { url: url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  /* 默认 OpenAI 兼容 */
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const oaBody = {
    model: cfg.model,
    messages: msgs.map(function (m) {
      return {
        role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
        content: m.content,
      };
    }),
    temperature: temperature,
    stream: false,
  };
  /* 行内补全要限长 —— 不传就让服务端按默认来，可能吐一大段 */
  if (maxTokens) oaBody.max_tokens = maxTokens;
  return {
    url: base + '/chat/completions',
    method: 'POST',
    headers: headers,
    body: JSON.stringify(oaBody),
  };
}

function parseReply(fmt, j) {
  if (!j) return '';

  if (fmt === 'anthropic') {
    const arr = j.content;
    if (Array.isArray(arr)) {
      return arr.filter(function (b) { return b && b.type === 'text'; })
        .map(function (b) { return b.text || ''; }).join('').trim();
    }
    return '';
  }

  if (fmt === 'google') {
    const cand = j.candidates && j.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    if (Array.isArray(parts)) return parts.map(function (p) { return p.text || ''; }).join('').trim();
    return '';
  }

  const m = j.choices && j.choices[0] && j.choices[0].message;
  return m && typeof m.content === 'string' ? m.content.trim() : '';
}

/* ---------------------------- 故障排查用的说明转换 ---------------------------- */

function checkUrl(base) {
  const b = trimBase(base);
  if (!b) return '还没填地址';
  try { new URL(b); } catch (e) { return '地址格式不对 —— 要以 http:// 或 https:// 开头'; }
  return '';
}

/* 把 fetch/requestUrl 的报错翻成人话 */
function explainNetError(msg) {
  const m = String(msg || '');
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(m)) return '连不上 —— 服务没启动，或端口不对';
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(m)) return '域名解析失败 —— 地址写错了，或当前网络没有 DNS';
  if (/ETIMEDOUT|ERR_TIMED_OUT|timed ?out/i.test(m)) return '超时 —— 可能不在同一个网络，或被防火墙拦了';
  if (/CERT|SSL|TLS|self.signed/i.test(m)) return '证书问题 —— 服务是 http 你写了 https（或反过来）';
  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH/i.test(m)) return '这台机器到不了那个地址 —— 没联网，或不在同一网段';
  return m;
}

/* 把 HTTP 状态码翻成人话 */
function explainHttp(status) {
  if (status === 401 || status === 403) return '鉴权被拒 —— Key 没填 / 填错了；也可能这个服务压根不需要 Key 但接口要求带';
  if (status === 404 || status === 405) return '路径不对 —— 地址多写或少写了 /v1、/v1beta 之类；也可能这个服务不是这种接口格式';
  if (status === 429) return '被限流了 —— 请求太频繁，或额度用完了';
  if (status >= 500) return '服务端自己出错 —— 服务本身有问题（看服务端日志）';
  return '';
}

/* 打一下 /models（同时验证「网络通不通」和「Key 认不认」），不抛异常 */
async function probeModelsEndpoint(cfg) {
  const base = trimBase(cfg.baseUrl);
  const key = decStr(cfg.apiKey);
  const fmt = cfg.format || 'openai';

  let url, headers = {};
  if (fmt === 'anthropic') {
    url = anthropicModelsUrl(base);
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (fmt === 'google') {
    url = googleBase(base) + '/models' + (key ? '?key=' + encodeURIComponent(key) : '');
  } else {
    url = base + '/models';
    if (key) headers.Authorization = 'Bearer ' + key;
  }

  const t0 = Date.now();
  try {
    const res = await requestUrl({ url: url, method: 'GET', headers: headers, throw: false });
    return { url: url, status: res.status, ms: Date.now() - t0, json: res.json, text: res.text };
  } catch (e) {
    return { url: url, status: 0, ms: Date.now() - t0, error: String((e && e.message) || e) };
  }
}

/* 从 /models 的返回里抽模型名 */
function idsFromModelsJson(fmt, j) {
  const o = j || {};
  let ids = [];
  if (fmt === 'google') {
    const arr = o.models || [];
    ids = arr.filter(function (m) {
      const meth = m.supportedGenerationMethods;
      return !meth || (Array.isArray(meth) && meth.indexOf('generateContent') >= 0);
    }).map(function (m) { return String(m.name || '').replace(/^models\//i, ''); });
  } else {
    const arr = o.data || o.models || [];
    ids = arr.map(function (x) { return typeof x === 'string' ? x : (x.id || x.name || ''); });
  }
  return ids.filter(Boolean);
}

/* 抽「思考过程」：OpenAI 兼容看 reasoning_content，Anthropic 看 thinking 块，Google 看 thought 部分 */
function parseReasoning(fmt, j) {
  if (!j) return '';

  if (fmt === 'anthropic') {
    const arr = j.content;
    if (Array.isArray(arr)) {
      return arr.filter(function (b) { return b && b.type === 'thinking'; })
        .map(function (b) { return b.thinking || ''; }).join('\n').trim();
    }
    return '';
  }

  if (fmt === 'google') {
    const c = j.candidates && j.candidates[0];
    const parts = c && c.content && c.content.parts;
    if (Array.isArray(parts)) {
      return parts.filter(function (p) { return p && p.thought; })
        .map(function (p) { return p.text || ''; }).join('\n').trim();
    }
    return '';
  }

  const m = j.choices && j.choices[0] && j.choices[0].message;
  return (m && (m.reasoning_content || m.reasoning)) || '';
}

/* 取模型列表（UI 按钮用）—— 失败时把「试的地址」和「人话原因」都带上 */
async function fetchModels(cfg) {
  if (checkUrl(cfg.baseUrl)) throw new Error(checkUrl(cfg.baseUrl));

  const r = await probeModelsEndpoint(cfg);
  if (r.error) {
    throw new Error(explainNetError(r.error) + '\n试的地址：' + r.url);
  }
  if (r.status < 200 || r.status >= 300) {
    const hint = explainHttp(r.status);
    throw new Error('HTTP ' + r.status + (hint ? ' · ' + hint : '')
      + '\n试的地址：' + r.url
      + '\n返回：' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 160));
  }

  const ids = idsFromModelsJson(cfg.format || 'openai', r.json);
  if (!ids.length) {
    throw new Error('接口通了，但没返回可用模型列表\n试的地址：' + r.url
      + '\n返回：' + JSON.stringify(r.json || {}).slice(0, 160));
  }
  return ids;
}

/* ============================ 故障检测 ============================
   回答"AI 用不了，到底是哪一段坏了"。
   ⚠ @codemirror 那几项是为将来的行内补全预备的（探针结论：Obsidian 直接提供）。 */
const PROBE_MODULES = [
  { mod: '@codemirror/view', need: ['Decoration', 'ViewPlugin', 'WidgetType'] },
  { mod: '@codemirror/state', need: ['StateField', 'StateEffect', 'RangeSet'] },
  { mod: '@codemirror/language', need: ['syntaxTree'] },
  { mod: '@lezer/highlight', need: ['tags'] },
  { mod: '@codemirror/commands', need: ['defaultKeymap'] },
];

function probeModules() {
  return PROBE_MODULES.map(function (t) {
    const r = { mod: t.mod, ok: false, missing: [], err: '' };
    try {
      const m = require(t.mod);
      r.ok = !!m;
      r.missing = t.need.filter(function (k) { return !m || typeof m[k] === 'undefined'; });
    } catch (e) { r.err = String((e && e.message) || e); }
    return r;
  });
}

/* 单个接口的体检：地址 → 连通/鉴权 → 模型 */
async function testProvider(p) {
  const out = [];

  const urlErr = checkUrl(p.baseUrl);
  if (urlErr) { out.push({ ok: false, label: '地址', detail: urlErr }); return out; }
  out.push({ ok: true, label: '地址', detail: trimBase(p.baseUrl) + '　（' + (FORMATS[p.format] || FORMATS.openai).label + '）' });

  const r = await probeModelsEndpoint(p);
  if (r.error) {
    out.push({ ok: false, label: '连通', detail: explainNetError(r.error) });
    return out;
  }
  if (r.status >= 400) {
    const hint = explainHttp(r.status);
    out.push({ ok: false, label: '连通 + Key', detail: 'HTTP ' + r.status + (hint ? ' · ' + hint : '') });
    return out;
  }
  out.push({ ok: true, label: '连通 + Key', detail: 'HTTP ' + r.status + ' · ' + r.ms + ' ms' });

  if (!p.model) {
    out.push({ ok: false, label: '模型', detail: '还没填 —— 先点「获取模型」从列表里挑一个（或手动输入）' });
    return out;
  }

  const ids = idsFromModelsJson(p.format || 'openai', r.json);
  if (ids.length && ids.indexOf(p.model) < 0) {
    out.push({ ok: false, label: '模型', detail: '「' + p.model + '」不在这个接口返回的列表里（列表里共 ' + ids.length + ' 个）—— 名字可能写错了' });
    return out;
  }

  try {
    const t0 = Date.now();
    await chatOnce(p, { system: '只回复 OK' }, 'ping', 0);
    out.push({ ok: true, label: '模型', detail: p.model + ' 可用（' + (Date.now() - t0) + ' ms）' });
  } catch (e) {
    out.push({ ok: false, label: '模型', detail: String((e && e.message) || e).slice(0, 240) });
  }
  return out;
}

/* 候选接口：自动 = 按列表顺序取「配齐了的」；手动 = 只用选中的那个 */
function candidateProviders(s) {
  const all = (s.providers || []).filter(function (p) { return p && p.baseUrl && p.model; });
  if (s.mode === MODE_AUTO) return all;
  const one = (s.providers || []).filter(function (p) { return p.id === s.activeProvider; })[0];
  return one ? [one] : [];
}

/* ---------------- 对外入口 ----------------
   通用版：传一组 messages（多轮对话用）；chat() 是它的单动作包装。
   自动模式下逐个试，第一个成功就返回；指定了接口就只用那一个。 */
async function chatMessages(plugin, messages, forceProviderId, onDelta) {
  const s = plugin.settings;
  let list;

  if (forceProviderId) {
    const one = (s.providers || []).filter(function (p) { return p.id === forceProviderId; })[0];
    if (!one) throw new Error('这个动作指定的接口已被删除 —— 去设置里重新指定一个');
    if (!trimBase(one.baseUrl) || !one.model) {
      throw new Error('这个动作指定的接口「' + (one.name || '未命名') + '」还没配好（缺地址或模型）');
    }
    list = [one];
  } else {
    list = candidateProviders(s);
    if (!list.length) {
      throw new Error('没有可用的接口：设置 → Hadesr AI，至少给一个接口填上「API 地址」和「模型」');
    }
  }

  const errors = [];
  for (let i = 0; i < list.length; i++) {
    try {
      let got = null;

      /* 想流式就先试流式，任何一步失败都退回普通请求 —— 不能因为 CORS 就打不开 */
      if (onDelta && s.stream !== false) {
        try {
          got = await sendStream(list[i], messages, s.temperature, onDelta);
        } catch (e) {
          got = null;
        }
      }
      if (!got) got = await sendMessages(list[i], messages, s.temperature);

      return { text: got.text, reasoning: got.reasoning, provider: list[i], tried: i + 1 };
    } catch (e) {
      errors.push((list[i].name || '未命名') + '：' + String((e && e.message) || e));
    }
  }

  if (errors.length === 1) throw new Error(errors[0]);
  throw new Error('所有接口都失败了（自动模式逐个试过）：\n' + errors.join('\n'));
}

/* 单动作：一条 system + 一条 user */
async function chat(plugin, action, text, forceProviderId, onDelta) {
  /* 用户在设置里改过这个动作的提示词就用改过的 */
  const override = (plugin.settings && plugin.settings.actionPrompts || {})[action.id];
  const instr = override || action.instruction || action.system || '';
  return chatMessages(plugin, [
    { role: 'system', content: BASE_SYSTEM },
    { role: 'user', content: instr ? (instr + '\n\n' + text) : text },
  ], forceProviderId, onDelta);
}

/* 真的发一次（不重试、不切换接口）
   maxTokens 只有行内补全用得上 —— 其它地方不传，沿用服务端默认 */
async function sendMessages(cfg, messages, temperature, maxTokens, extra) {
  if (!trimBase(cfg.baseUrl)) throw new Error('没填 API 地址');
  if (!cfg.model) throw new Error('没填模型');

  const fmt = cfg.format || 'openai';
  const req = buildRequestMessages(fmt, cfg, messages, temperature, maxTokens);

  /* extra：往请求体里补字段（补全用它关掉思考，见 NO_THINK_MODES）。
     只有 OpenAI 兼容格式认这些字段，其它格式原样发。 */
  let bodyStr = req.body;
  if (extra && fmt === 'openai') {
    const jb = JSON.parse(bodyStr);
    Object.keys(extra).forEach(function (k) { jb[k] = extra[k]; });
    bodyStr = JSON.stringify(jb);
  }

  const res = await requestUrl({
    url: req.url, method: req.method, headers: req.headers, body: bodyStr, throw: false,
  });

  if (res.status < 200 || res.status >= 300) {
    const detail = String(res.text || '').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
  }

  const out = parseReply(fmt, res.json);
  if (!out) throw new Error('返回里没找到正文：' + JSON.stringify(res.json || {}).slice(0, 300));
  return {
    text: out,
    reasoning: parseReasoning(fmt, res.json),
    finishReason: finishReasonOf(fmt, res.json),
  };
}

/* 从 SSE 的一行 JSON 里取增量 */
function extractDelta(fmt, j) {
  if (fmt === 'anthropic') {
    if (j && j.type === 'content_block_delta' && j.delta) {
      if (typeof j.delta.text === 'string') return { text: j.delta.text };
      if (typeof j.delta.thinking === 'string') return { reasoning: j.delta.thinking };
    }
    return {};
  }
  if (fmt === 'google') return {};      /* Google 走流式要换 URL，这里不折腾，退回普通请求 */
  const d = j && j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
  if (!d) return {};
  const out = {};
  if (typeof d.content === 'string' && d.content) out.text = d.content;
  const r = d.reasoning_content || d.reasoning;
  if (typeof r === 'string' && r) out.reasoning = r;
  return out;
}

/* 结束原因：续写循环靠它判断"是不是被上限截断了" */
function finishReasonOf(fmt, j) {
  let r = '';
  if (!j) return '';
  if (fmt === 'anthropic') r = j.stop_reason;
  else if (fmt === 'google') r = j.candidates && j.candidates[0] && j.candidates[0].finishReason;
  else r = j.choices && j.choices[0] && j.choices[0].finish_reason;
  r = String(r || '').toLowerCase();
  return r === 'max_tokens' ? 'length' : r;
}

/* 流式请求：逐块回调 onDelta。 */
async function sendStream(cfg, messages, temperature, onDelta, opts) {
  const o = opts || {};
  const fmt = cfg.format || 'openai';
  const req = buildRequestMessages(fmt, cfg, messages, temperature, o.maxTokens);
  const body = JSON.parse(req.body);
  body.stream = true;

  const init = { method: 'POST', headers: req.headers, body: JSON.stringify(body) };
  if (o.signal) init.signal = o.signal;

  const res = await fetch(req.url, init);
  if (!res.ok || !res.body) throw new Error('stream HTTP ' + res.status);

  /* 服务端没按 SSE 回（有的代理直接丢一整段 JSON）→ 交给外面回落普通请求 */
  const ct = (res.headers && typeof res.headers.get === 'function')
    ? String(res.headers.get('content-type') || '') : '';
  if (ct && ct.indexOf('event-stream') < 0) throw new Error('stream 返回的不是 SSE：' + ct);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let stop = false;

  while (!stop) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || line.indexOf('data:') !== 0) continue;

      const data = line.slice(5).trim();
      if (data === '[DONE]') { stop = true; break; }

      let j = null;
      try { j = JSON.parse(data); } catch (e) { continue; }

      const d = extractDelta(fmt, j);
      if (d.reasoning) reasoning += d.reasoning;
      if (d.text) text += d.text;
      if ((d.reasoning || d.text) && typeof onDelta === 'function') {
        onDelta({ text: text, reasoning: reasoning });
      }
    }
  }

  if (!text.trim() && !o.allowEmpty) throw new Error('流式返回里没有正文');
  return { text: text, reasoning: reasoning };
}

/* 单动作的发送（测试连接等处直接用） */
async function chatOnce(cfg, action, text, temperature) {
  const instr = action.instruction || action.system || '';
  const got = await sendMessages(cfg, [
    { role: 'system', content: BASE_SYSTEM },
    { role: 'user', content: instr ? (instr + '\n\n' + text) : text },
  ], temperature);
  return got.text;
}

/* ============================================================ 诊断报告弹窗
   把「环境 / 模块 / 每个接口」的结果摆成一张表：哪一步标红，就是哪里坏了。 */
class DiagModal extends Modal {
  constructor(app, title, sections) {
    super(app);
    this.diagTitle = title;
    this.sections = sections;   /* [{ heading, lines: [{ ok, label, detail }] }] */
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('obai-diag');
    contentEl.createEl('h2', { text: this.diagTitle });

    const bad = [];
    this.sections.forEach((sec) => {
      if (sec.heading) contentEl.createEl('h4', { text: sec.heading });
      const box = contentEl.createDiv({ cls: 'obai-diag-box' });
      sec.lines.forEach((l) => {
        const row = box.createDiv({ cls: 'obai-diag-row' });
        row.createEl('span', { text: l.ok ? '✅' : '✗', cls: 'obai-diag-mark' });
        row.createEl('span', { text: l.label, cls: 'obai-diag-label' });
        row.createEl('span', { text: l.detail || '', cls: 'obai-diag-detail' });
        if (!l.ok) bad.push(sec.heading ? sec.heading + ' · ' + l.label : l.label);
      });
    });

    const verdict = contentEl.createEl('p', { cls: 'obai-diag-verdict' });
    if (!bad.length) {
      verdict.setText('全部通过 —— 目前没查出问题。');
      verdict.style.color = 'var(--color-green, #0a0)';
    } else {
      verdict.setText('有 ' + bad.length + ' 项没过：' + bad.join('；'));
      verdict.style.color = 'var(--text-error)';
    }
    verdict.style.fontWeight = 'bold';
    verdict.style.marginTop = '12px';

    const btn = contentEl.createEl('button', { text: '关闭', cls: 'mod-cta' });
    btn.style.marginTop = '10px';
    btn.onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

/* 菜单层级：动作列表是平的，这里定义分层结构。
   setSubmenu 属未文档化 API —— 构建前探测，不支持则退化为平铺。 */
const MENU_TREE = [
  {
    label: '编辑', icon: 'pencil',
    children: [
      { id: 'polish' },
      { id: 'fix' },
      { id: 'condense' },
      { id: 'expand' },
      { id: 'simplify' },
      { label: '语气', icon: 'message-square', children: [{ id: 'formal' }, { id: 'casual' }] },
    ],
  },
  {
    label: '生成', icon: 'sparkles',
    children: [
      { id: 'explain' }, { id: 'summarize' }, { id: 'continue' },
      { id: 'totable' }, { id: 'tolist' }, { id: 'tocode' }, { id: 'todos' },
    ],
  },
  /* 翻译：明确方向，不再让模型自己猜中英 */
  {
    label: '翻译', icon: 'languages',
    children: [{ id: 'trans-zh' }, { id: 'trans-en' }],
  },
];

/* 用一个丢弃的 Menu 探一下 setSubmenu 在不在（不显示，无副作用） */
function menuSupportsSubmenu() {
  let yes = false;
  try {
    const probe = new Menu();
    probe.addItem(function (i) { yes = typeof i.setSubmenu === 'function'; });
  } catch (e) { yes = false; }
  return yes;
}

/* 把 MENU_TREE 渲染进 menu。onPick(action) 在点了具体动作时调用。 */
/* 给菜单打标，样式只作用于本插件弹出的菜单 */
/* 收窄本插件弹出的菜单。
   ⚠ menu.dom 要到 show 之后才存在，所以必须在 show 后调用；
     拿不到时退回"扫当前所有 .menu"（此刻在屏上的只可能是我们刚弹的那个）。 */
let menuSweep = 0;

function tagMenu(menu) {
  const apply = function (el) {
    try {
      if (!el || !el.classList) return;
      el.classList.add('obai-menu');
      el.style.minWidth = '0';
      el.style.width = 'max-content';
    } catch (e) { dlog('L865', e); }
  };

  const sweep = function () {
    try {
      if (menu && menu.dom) apply(menu.dom);
      const doc = (typeof document !== 'undefined') ? document : null;
      if (!doc || !doc.querySelectorAll) return;
      const list = doc.querySelectorAll('.menu');
      for (let i = 0; i < list.length; i++) apply(list[i]);
    } catch (e) { dlog('L875', e); }
  };

  sweep();

  /* 子菜单是 hover 时才插进 DOM 的，一次打标赶不上；
     菜单打开后 1.2 秒内持续补打（只作用于当前在屏的菜单）。 */
  try {
    if (menuSweep) clearInterval(menuSweep);
    let n = 0;
    menuSweep = setInterval(function () {
      sweep();
      if (++n >= 10) { clearInterval(menuSweep); menuSweep = 0; }
    }, 120);
  } catch (e) { dlog('L889', e); }

  return menu;
}

function buildActionMenu(menu, actions, onPick) {
  const byId = {};
  actions.forEach(function (a) { byId[a.id] = a; });
  const used = {};
  const canSub = menuSupportsSubmenu();

  const addLeaf = function (sub, a) {
    used[a.id] = true;
    sub.addItem(function (i) {
      i.setTitle(a.name);
      i.onClick(function () { onPick(a); });
    });
  };

  /* 平铺模式下需要改写文案，单独走一遍 */
  const walkFlat = function (sub, nodes, prefix) {
    nodes.forEach(function (node) {
      if (node.id) {
        const a = byId[node.id];
        if (!a) return;
        used[a.id] = true;
        sub.addItem(function (i) {
          i.setTitle(prefix + a.name);
          i.onClick(function () { onPick(a); });
        });
        return;
      }
      if (canSub) {
        sub.addItem(function (i) {
          i.setTitle(node.label);
          const child = tagMenu(i.setSubmenu());
          try {
            if (i.dom && i.dom.addEventListener) {
              i.dom.addEventListener('mouseenter', function () {
                setTimeout(function () { tagMenu(child); }, 0);
              });
            }
          } catch (e) { dlog('L931', e); }
          if (child) walkFlat(child, node.children, '');
        });
      } else {
        walkFlat(sub, node.children, prefix + node.label + ' · ');
      }
    });
  };

  walkFlat(menu, MENU_TREE, '');

  /* 自定义动作 / 任何没进 MENU_TREE 的 → 统一放最后 */
  const rest = actions.filter(function (a) { return !used[a.id]; });
  if (rest.length) {
    menu.addSeparator();
    rest.forEach(function (a) { addLeaf(menu, a); });
  }
}

/* 选中浮条：✦ AI + 上次用过的动作 + ▾ 菜单。
   只在编辑区出现；按钮拦 mousedown 防止选区塌掉；滚动 / Esc / 选区消失即收起。 */
/* 单行输入条：跟 AI 对话框一个风格，输入 + 箭头，无确定/取消 */
class QuickAsk {
  constructor(placeholder, onDone) {
    this.placeholder = placeholder || '';
    this.onDone = onDone;
    this.el = null;
    this._onDown = (e) => {
      if (this.el && !this.el.contains(e.target)) this._finish(null);
    };
    this._onKey = (e) => { if (e.key === 'Escape') this._finish(null); };
  }

  open() {
    const el = document.createElement('div');
    el.className = 'obai-askbar';
    this.el = el;

    const input = el.createEl('input', { cls: 'obai-askbar-input' });
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', this.placeholder);
    this.input = input;

    const send = el.createEl('button', { cls: 'obai-askbar-send' });
    setIcon(send, 'send');
    send.onclick = () => this._submit();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._submit(); }
    });

    document.body.appendChild(el);
    setTimeout(function () { try { input.focus(); } catch (e) { dlog('L983', e); } }, 0);
    /* 延迟挂监听，免得打开这一下就被自己的 click 关掉 */
    setTimeout(() => {
      document.addEventListener('mousedown', this._onDown, true);
      document.addEventListener('keydown', this._onKey, true);
    }, 0);
    return this;
  }

  _submit() {
    const v = String((this.input && this.input.value) || '').trim();
    if (!v) { try { this.input.focus(); } catch (e) { dlog('L994', e); } return; }
    this._finish(v);
  }

  _finish(v) {
    try { document.removeEventListener('mousedown', this._onDown, true); } catch (e) { dlog('L999', e); }
    try { document.removeEventListener('keydown', this._onKey, true); } catch (e) { dlog('L1000', e); }
    if (this.el) { this.el.remove(); this.el = null; }
    if (this.onDone) this.onDone(v);
  }
}

function askText(app, title, placeholder) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (v) { if (done) return; done = true; resolve(v); };
    const ph = (title ? title + '　' : '') + (placeholder || '');
    new QuickAsk(ph, finish).open();
  });
}

/* 批量处理面板：能看见正在处理哪一段，也能随时关掉 */
class BatchPanel {
  constructor(plugin, title, segs) {
    this.plugin = plugin;
    this.title = title;
    this.segs = segs || [];
    this.el = null;
    this.rows = [];
    this.done = false;
    this.cancelled = false;
    this.skipped = new Set();
    this._onKey = (e) => { if (e.key === 'Escape') this._requestClose(); };
  }

  open() {
    const el = document.createElement('div');
    el.className = 'obai-batch';
    this.el = el;

    const head = el.createDiv({ cls: 'obai-batch-head' });
    head.createEl('span', { cls: 'obai-batch-title', text: this.title });
    head.createEl('span', { cls: 'obai-batch-count', text: this.segs.length + ' 段' });
    const x = head.createEl('button', { cls: 'obai-batch-x', text: '×' });
    x.onclick = () => this._requestClose();

    const list = el.createDiv({ cls: 'obai-batch-list' });
    this.segs.forEach((seg, i) => {
      const row = list.createDiv({ cls: 'obai-batch-row is-wait' });
      row.createSpan({ cls: 'obai-batch-idx', text: String(i + 1) });
      const txt = String(seg.text || '').replace(/\s+/g, ' ');
      row.createSpan({
        cls: 'obai-batch-text',
        text: txt.length > 46 ? txt.slice(0, 46) + '…' : txt,
      });
      const st = row.createSpan({ cls: 'obai-batch-state', text: '等待' });
      const sk = row.createEl('button', { cls: 'obai-batch-skip', text: '跳过' });
      sk.title = '这一段不处理';
      sk.onclick = () => {
        this.skipped.add(i);
        this.setStatus(i, 'skip', '跳过');
      };
      this.rows.push({ row: row, state: st });
    });

    const foot = el.createDiv({ cls: 'obai-batch-foot' });
    this.footEl = foot.createSpan({ cls: 'obai-batch-msg', text: '准备中…' });
    this.retryBtn = foot.createEl('button', { cls: 'obai-batch-retry', text: '重试失败项' });
    this.retryBtn.style.display = 'none';
    this.retryBtn.onclick = () => {
      const fn = this._onRetry;
      this.close();
      if (fn) fn();
    };

    this.cancelBtn = foot.createEl('button', { cls: 'obai-batch-cancel', text: '取消' });
    this.cancelBtn.onclick = () => this._requestClose();

    document.body.appendChild(el);
    this._place();
    document.addEventListener('keydown', this._onKey, true);
    return this;
  }

  _place() {
    const el = this.el;
    if (!el) return;
    const rect = ResultCard.selectionRect();
    const vw = (typeof window.innerWidth === 'number') ? window.innerWidth : 1200;
    const vh = (typeof window.innerHeight === 'number') ? window.innerHeight : 800;
    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 260;
    let left;
    let top;
    if (rect) {
      left = Math.min(Math.max(8, rect.left), vw - w - 8);
      top = rect.bottom + 10;
      if (top + h > vh - 8) top = Math.max(8, rect.top - h - 10);
    } else {
      left = (vw - w) / 2;
      top = Math.max(8, (vh - h) / 2 - 40);
    }
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  isSkipped(i) { return this.skipped.has(i); }

  setStatus(i, state, label) {
    const r = this.rows[i];
    if (!r) return;
    const map = { wait: '等待', run: '处理中…', ok: '完成', fail: '失败' };
    r.row.className = 'obai-batch-row is-' + state;
    r.state.textContent = label || map[state] || '';
  }

  setFoot(text) {
    if (this.footEl) this.footEl.textContent = text;
  }

  markDone(text, onRetry) {
    this.done = true;
    this.setFoot(text || '完成');
    if (onRetry && this.retryBtn) {
      this._onRetry = onRetry;
      this.retryBtn.style.display = '';
    }
    if (this.cancelBtn) {
      this.cancelBtn.textContent = '关闭';
      this.cancelBtn.onclick = () => this.close();
    }
  }

  _requestClose() {
    if (this.done) { this.close(); return; }
    this.cancelled = true;
    this.setFoot('已取消');
    this.close();
  }

  close() {
    try { document.removeEventListener('keydown', this._onKey, true); } catch (e) { dlog('L1135', e); }
    if (this.el) { this.el.remove(); this.el = null; }
  }
}

/* 胶囊 ▾ 的菜单：自绘，不用原生 Menu —— 原生菜单宽度由 Obsidian 固定，改不动。
   结构：一级是分类，hover 出二级；最下面放"快速改写/开关补全/Canvas/属性/对话"。 */
class ActionMenu {
  constructor(plugin, anchorEl, tree, byId, onPick, extras) {
    this.plugin = plugin;
    this.anchorEl = anchorEl;
    this.tree = tree;
    this.byId = byId;
    this.onPick = onPick;
    this.extras = extras || [];
    this.el = null;
    this.subEl = null;
    this._subTimer = 0;
    this._onDown = (e) => {
      if (this.el && this.el.contains(e.target)) return;
      if (this.subEl && this.subEl.contains(e.target)) return;
      this.close();
    };
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
  }

  open() {
    const self = this;
    const el = document.createElement('div');
    el.className = 'obai-actions';
    this.el = el;

    const row = (parent, label, onClick, hasSub) => {
      const r = parent.createDiv({ cls: 'obai-action-row' });
      r.createSpan({ cls: 'obai-action-label', text: label });
      if (hasSub) {
        const ic = r.createSpan({ cls: 'obai-action-arrow' });
        setIcon(ic, 'chevron-right');
      }
      if (onClick) r.onclick = onClick;
      return r;
    };

    this.tree.forEach(function (node) {
      const r = row(el, node.label, null, true);
      r.onmouseenter = function () {
        if (self._subTimer) { clearTimeout(self._subTimer); self._subTimer = 0; }
        self._showSub(r, node.children);
      };
      r.onmouseleave = function () { self._scheduleSubHide(); };
    });

    const customs = Object.keys(this.byId)
      .map(function (k) { return self.byId[k]; })
      .filter(function (a) { return a.custom; });
    if (customs.length) {
      el.createDiv({ cls: 'obai-action-sep' });
      customs.forEach(function (a) {
        row(el, a.name, function () { self.close(); self.onPick(a); }, false);
      });
    }

    if (this.extras.length) {
      el.createDiv({ cls: 'obai-action-sep' });
      this.extras.forEach(function (x) {
        row(el, x.label, function () { self.close(); x.run(); }, false);
      });
    }

    document.body.appendChild(el);
    this._place();
    document.addEventListener('mousedown', this._onDown, true);
    document.addEventListener('touchstart', this._onDown, true);
    document.addEventListener('keydown', this._onKey, true);
    return this;
  }

  /* 二级面板：贴在分组行右边；右边放不下就翻到左边 */
  _showSub(rowEl, children) {
    const self = this;
    if (this.subEl) { this.subEl.remove(); this.subEl = null; }

    const sub = document.createElement('div');
    sub.className = 'obai-actions obai-actions-sub';
    this.subEl = sub;

    children.forEach(function (node) {
      if (node.id) {
        const a = self.byId[node.id];
        if (!a) return;
        const r = sub.createDiv({ cls: 'obai-action-row' });
        r.createSpan({ cls: 'obai-action-label', text: a.name });
        r.onclick = function () { self.close(); self.onPick(a); };
        return;
      }
      /* 再往下一层（比如「语气」）—— 平铺成小标题 + 子项，避免第三级菜单 */
      sub.createDiv({ cls: 'obai-action-sub-title', text: node.label });
      (node.children || []).forEach(function (leaf) {
        const a = self.byId[leaf.id];
        if (!a) return;
        const r = sub.createDiv({ cls: 'obai-action-row' });
        r.createSpan({ cls: 'obai-action-label', text: a.name });
        r.onclick = function () { self.close(); self.onPick(a); };
      });
    });

    sub.onmouseenter = function () {
      if (self._subTimer) { clearTimeout(self._subTimer); self._subTimer = 0; }
    };
    sub.onmouseleave = function () { self._scheduleSubHide(); };

    document.body.appendChild(sub);

    const r = rowEl.getBoundingClientRect();
    const w = sub.offsetWidth || 140;
    const h = sub.offsetHeight || 160;
    const vw = (typeof window.innerWidth === 'number') ? window.innerWidth : 1200;
    const vh = (typeof window.innerHeight === 'number') ? window.innerHeight : 800;

    let left = r.right + 4;
    if (left + w > vw - 8) left = Math.max(8, r.left - w - 4);
    let top = r.top - 4;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    sub.style.left = Math.round(left) + 'px';
    sub.style.top = Math.round(top) + 'px';
  }

  _scheduleSubHide() {
    const self = this;
    if (this._subTimer) clearTimeout(this._subTimer);
    this._subTimer = setTimeout(function () {
      self._subTimer = 0;
      if (self.subEl) { self.subEl.remove(); self.subEl = null; }
    }, 140);
  }

  _place() {
    const el = this.el;
    if (!el) return;
    const r = this.anchorEl.getBoundingClientRect();
    const w = el.offsetWidth || 180;
    const h = el.offsetHeight || 300;
    const vw = (typeof window.innerWidth === 'number') ? window.innerWidth : 1200;
    const vh = (typeof window.innerHeight === 'number') ? window.innerHeight : 800;

    let left = Math.min(r.left, vw - w - 8);
    let top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = Math.round(Math.max(8, left)) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  close() {
    if (this.plugin && this.plugin._rwBox === this) this.plugin._rwBox = null;
    document.removeEventListener('mousedown', this._onDown, true);
    document.removeEventListener('touchstart', this._onDown, true);
    document.removeEventListener('keydown', this._onKey, true);
    if (this._subTimer) { clearTimeout(this._subTimer); this._subTimer = 0; }
    if (this.subEl) { this.subEl.remove(); this.subEl = null; }
    if (this.el) { this.el.remove(); this.el = null; }
  }
}

class SelectionBubble {
  constructor(plugin) {
    this.plugin = plugin;
    this.el = null;
    this._timer = 0;
    this._onChange = () => this._schedule();
    this._onScroll = () => this.hide();
    this._onKey = (e) => { if (e.key === 'Escape') this.hide(); };
  }

  mount() {
    document.addEventListener('selectionchange', this._onChange);
    window.addEventListener('scroll', this._onScroll, true);
    document.addEventListener('keydown', this._onKey, true);
  }

  destroy() {
    document.removeEventListener('selectionchange', this._onChange);
    window.removeEventListener('scroll', this._onScroll, true);
    document.removeEventListener('keydown', this._onKey, true);
    clearTimeout(this._timer);
    if (this.el) { this.el.remove(); this.el = null; }
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._refresh(), 140);
  }

  _refresh() {
    if (!this.plugin.settings.selectionBubble) return this.hide();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return this.hide();
    if (!String(sel.toString() || '').trim()) return this.hide();

    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest || !el.closest('.cm-editor')) return this.hide();
    if (this.el && this.el.contains(el)) return;      /* 别在自己身上递归 */

    const r = range.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return this.hide();
    this.show(r);
  }

  show(rect) {
    if (!this.el) this._build();
    this._refreshLabel();          /* 动作可能变了 —— 每次显示都刷新 */
    this.el.style.display = 'flex';

    const pad = 8;
    const w = this.el.offsetWidth || 150;
    const h = this.el.offsetHeight || 34;
    const vh = (typeof window.innerHeight === 'number' && window.innerHeight) ? window.innerHeight : 800;

    let left = rect.right - w;
    if (left < pad) left = pad;

    /* 位置偏好：默认放选区下方（上方常被别的插件/工具栏占着）。
       任何一种放不下都会自动翻到另一边，不会跑出屏幕。 */
    const mode = this.plugin.settings.bubblePosition || 'below';
    let top;
    if (mode === 'above') {
      top = rect.top - h - 6;
      if (top < pad) top = rect.bottom + 6;      /* 上面没地方 → 翻到下面 */
    } else {                                     /* below（默认） */
      top = rect.bottom + 6;
      if (top + h > vh - pad) top = rect.top - h - 6;   /* 到底了 → 翻到上面 */
    }

    this.el.style.left = Math.round(left) + 'px';
    this.el.style.top = Math.round(Math.max(pad, top)) + 'px';
  }

  hide() { if (this.el) this.el.style.display = 'none'; }

  /* 设置改了（勾选的动作变了）→ 丢掉旧的，下次 show 时按新配置重建 */
  rebuild() {
    if (this.el) { this.el.remove(); this.el = null; }
  }

  /* 上次用过的动作（没使用过就返回 null） */
  _lastAction() {
    const id = this.plugin._lastActionId;
    if (!id) return null;
    if (id === QUICK_TARGET.id) return QUICK_TARGET;   /* 快速改写也参与记忆 */
    const all = allActions(this.plugin.settings);
    return all.filter(function (a) { return a.id === id; })[0] || null;
  }

  _refreshLabel() {
    if (!this.toolEl) return;
    const n = this.plugin.marksHere().length;

    /* 当前文件有标记：胶囊主标签直接反映标记状态（点开即去 AI 对话处理） */
    if (n > 0) {
      this.toolEl.textContent = '标记 ' + n + ' 段';
      this.toolEl.style.display = '';
      if (this.mainBtn) {
        this.mainBtn.classList.remove('is-bare');
        this.mainBtn.title = '已标记 ' + n + ' 段 · 点这里打开 AI 对话处理（点 ▾ 换别的）';
      }
      return;
    }

    const a = this._lastAction();
    this.toolEl.textContent = a ? (a.pill || a.name) : '';
    this.toolEl.style.display = a ? '' : 'none';   /* 空的时候别占位 */
    if (this.mainBtn) {
      this.mainBtn.classList.toggle('is-bare', !a);
      this.mainBtn.title = a
        ? ((a.quick ? '打开「快速改写」' : '执行「' + (a.pill || a.name) + '」') + '（点 ▾ 换别的）')
        : '选择要执行的动作';
    }
  }

  /* 下拉菜单：完整动作 + 整篇级功能 */
  _openMenu(anchor) {
    const self = this;
    const acts = allActions(this.plugin.settings);
    const byId = {};
    acts.forEach(function (a) { byId[a.id] = a; });

    const on = this.plugin.settings.complete === true;
    const markCount = this.plugin.marksHere().length;
    const extras = [];
    extras.push({ label: '标记此段', run: function () { self.plugin.markSelection(); } });
    if (markCount) {
      extras.push({ label: '清除 ' + markCount + ' 段标记', run: function () { self.plugin.clearMarks(); } });
    }
    extras.push(
      { label: '快速改写', run: function () { self.plugin.openQuickRewrite(); } },
      { label: on ? '关闭行内补全' : '开启行内补全', run: function () { self.plugin.toggleComplete(); } },
      { label: '添加笔记属性', run: function () { self.plugin.runFrontmatter(); } },
      { label: '转 Canvas', run: function () { self.plugin.runCanvas(); } },
      { label: 'AI 对话', run: function () { self.plugin.openRewrite(); } }
    );

    if (this._menu) { try { this._menu.close(); } catch (e) { dlog('L1434', e); } }
    this._menu = new ActionMenu(this.plugin, this.el || anchor, MENU_TREE, byId, function (a) {
      self.hide();
      self.plugin.runActionById(a.id);
    }, extras);
    this._menu.open();
  }

  _build() {
    const bar = document.createElement('div');
    bar.className = 'obai-bubble';
    bar.style.display = 'none';


    /* 主按钮：✦ + 「AI」（蓝色）+ 上次用过的工具名（正常色） */
    const main = document.createElement('button');
    main.className = 'obai-bubble-main';
    const ic = document.createElement('span');
    ic.className = 'obai-bubble-icon';
    setIcon(ic, 'sparkles');
    main.appendChild(ic);

    const ai = document.createElement('span');
    ai.className = 'obai-pill-ai';
    ai.textContent = 'AI';
    main.appendChild(ai);

    this.toolEl = document.createElement('span');
    this.toolEl.className = 'obai-pill-tool';
    main.appendChild(this.toolEl);

    this.mainBtn = main;
    this._refreshLabel();

    main.onmousedown = (e) => e.preventDefault();
    main.onclick = (e) => {
      e.preventDefault();
      /* 有标记时，主按钮直接去 AI 对话处理这些段（而不是跑上次那个动作） */
      if (this.plugin.marksHere().length > 0) { this.plugin.openRewrite(); this.hide(); return; }
      const cur = this._lastAction();
      if (cur && cur.quick) this.plugin.openQuickRewrite();
      else if (cur) this.plugin.runActionById(cur.id);
      else this._openMenu(more);
      this.hide();
    };
    bar.appendChild(main);

    /* 下拉：完整的分类菜单（编辑 / 生成 / 翻译 / 自定义） */
    const more = document.createElement('button');
    more.className = 'obai-bubble-more';
    more.title = '换成别的动作';
    setIcon(more, 'chevron-down');
    more.onmousedown = (e) => e.preventDefault();
    more.onclick = (e) => {
      e.preventDefault();
      this._openMenu(more);
    };

    bar.appendChild(more);

    document.body.appendChild(bar);
    this.el = bar;
  }
}

/* ============================================================ 添加笔记属性（frontmatter）
   让 AI 给出 {title, summary, tags}，再**只补缺失字段**合并进已有 YAML —— 不动你手写的东西。 */
function mergeFrontmatter(text, data, zh) {
  const src = String(text);

  /* 字段名：中文模式用「标题 / 摘要」，但 tags 必须保持英文 ——
     它是 Obsidian 的内置属性，改成中文就失去标签功能了。 */
  const kTitle = zh ? '标题' : 'title';
  const kSummary = zh ? '摘要' : 'summary';
  const kTags = 'tags';

  const lines = [];
  if (data && data.title) lines.push(kTitle + ': ' + JSON.stringify(String(data.title)));
  if (data && data.summary) lines.push(kSummary + ': ' + JSON.stringify(String(data.summary)));
  if (data && Array.isArray(data.tags) && data.tags.length) {
    lines.push(kTags + ': [' + data.tags.map(function (t) { return JSON.stringify(String(t)); }).join(', ') + ']');
  }
  if (!lines.length) return src;

  /* 从一行里取字段名（中文键也要认得） */
  const keyOf = function (l) {
    const m = String(l).match(/^\s*([^:#\n]+?)\s*:/);
    return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
  };

  /* 认出"开头就是 YAML 头"的情况。⚠ 光看到两行 --- 不算 ——
     笔记也可能以一条分割线开头，那种不是 frontmatter，硬改会毁掉正文。 */
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)---[ \t]*(\r?\n|$)/);
  const looksYaml = !!m && (m[1].trim() === '' || /^[^\s:#][^:\n]*\s*:/m.test(m[1]));

  if (!m || !looksYaml) {
    return '---\n' + lines.join('\n') + '\n---\n\n' + src;
  }

  const bodyLines = m[1].replace(/\r\n/g, '\n').split('\n');
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();

  const have = {};
  bodyLines.forEach(function (l) {
    const k = keyOf(l);
    if (k) have[k] = true;
  });

  const add = lines.filter(function (l) {
    const k = keyOf(l);
    return k && !have[k];
  });
  if (!add.length) return src;      /* 三个字段都已存在 → 一个字节都不动 */

  const rest = src.slice(m[0].length);
  return '---\n' + bodyLines.concat(add).join('\n') + '\n---\n' + rest;
}

/* ============================ 模板变量
   发出去之前先在本地展开 —— 那些 {{}} 不会被模型看到。
   变量表：{{selection}} {{file:content}} {{file:path}} {{date}} {{time}} {{datetime}} {{vault:name}} */
function tplContext(plugin) {
  const ed = plugin._activeEditor();
  const d = new Date();
  const p2 = function (n) { return String(n).padStart(2, '0'); };
  const ymd = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());

  let filePath = '';
  try {
    const f = plugin.app.workspace.getActiveFile ? plugin.app.workspace.getActiveFile() : null;
    if (f) filePath = f.path || '';
  } catch (e) { dlog('L1574', e); }

  let vaultName = '';
  try { vaultName = plugin.app.vault.getName ? plugin.app.vault.getName() : ''; } catch (e) { dlog('L1577', e); }

  const content = ed ? (ed.getValue() || '') : '';
  return {
    selection: ed ? (ed.getSelection() || '') : '',
    fileContent: content.length > 8000 ? (content.slice(0, 8000) + '\n…（后面省略）') : content,
    filePath: filePath,
    date: ymd,
    time: hm,
    datetime: ymd + ' ' + hm,
    vaultName: vaultName,
  };
}

function renderTemplate(text, ctx) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z:]+)\s*\}\}/g, function (m, key) {
    switch (String(key).toLowerCase()) {
      case 'selection': return ctx.selection || '';
      case 'file:content': return ctx.fileContent || '';
      case 'file:path': return ctx.filePath || '';
      case 'date': return ctx.date || '';
      case 'time': return ctx.time || '';
      case 'datetime': return ctx.datetime || '';
      case 'vault:name': return ctx.vaultName || '';
      default: return m;                    /* 不认识的变量原样留着，别吞掉 */
    }
  });
}

/* 模板编辑弹窗 */
/* 改一个内置动作的提示词。textarea + 保存 / 恢复默认 / 取消 */
class PromptEditModal extends Modal {
  constructor(app, title, value, fallback, onSave) {
    super(app);
    this.heading = title;
    this.value = value;
    this.fallback = fallback;
    this.onSave = onSave;
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('obai-tpledit');
    c.createEl('h3', { text: this.heading });

    const ta = c.createEl('textarea', { cls: 'obai-prompt-edit' });
    ta.value = this.value || '';

    const row = c.createDiv({ cls: 'obai-tplfoot' });
    const ok = row.createEl('button', { text: '保存', cls: 'obai-chipbtn is-accent' });
    ok.onclick = () => { this.onSave(ta.value); this.close(); };
    const reset = row.createEl('button', { text: '恢复默认', cls: 'obai-chipbtn' });
    reset.onclick = () => { ta.value = this.fallback || ''; };
    const cancel = row.createEl('button', { text: '取消', cls: 'obai-chipbtn' });
    cancel.onclick = () => this.close();
  }
}

class TemplateEditModal extends Modal {
  constructor(app, tpl, onSave) {
    super(app);
    this.tpl = tpl;
    this.onSave = onSave;
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('obai-tpledit');
    c.createEl('h3', { text: '编辑模板' });

    new Setting(c).setName('名字')
      .addText((t) => t.setValue(this.tpl.name || '')
        .onChange((v) => { this.tpl.name = v.trim(); }));

    new Setting(c).setName('内容')
      .setDesc('可用变量：{{selection}} · {{file:content}} · {{file:path}} · {{date}} · {{time}} · {{datetime}} · {{vault:name}}')
      .addTextArea((ta) => {
        ta.setValue(this.tpl.text || '').onChange((v) => { this.tpl.text = v; });
        ta.inputEl.style.minWidth = '100%';
        ta.inputEl.style.minHeight = '150px';
      });

    const bar = c.createDiv({ cls: 'obai-btns' });
    const ok = bar.createEl('button', { text: '保存', cls: 'mod-cta' });
    ok.onclick = () => { this.onSave(); this.close(); };
    const cancel = bar.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

/* 选一篇笔记（给「引用笔记」用） */
class NoteSuggestModal extends FuzzySuggestModal {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder('搜一篇笔记，回车引用它');
  }
  getItems() {
    try { return this.app.vault.getMarkdownFiles(); } catch (e) { return []; }
  }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onPick(f); }
}

/* 转 Canvas：按连通分量分层排布，尺寸按显示宽度估算（中文算两格）。
   id 用 16 位小写 hex。 */

const CANVAS_COL = 420;
const CANVAS_ROW_GAP = 42;
const CANVAS_GROUP_PAD = 70;

/* 16 位小写 hex id（JSON Canvas 的惯例） */
function hexId(used) {
  for (let k = 0; k < 80; k++) {
    let out = '';
    const buf = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < 8; i++) out += buf[i].toString(16).padStart(2, '0');
    if (!used.has(out)) { used.add(out); return out; }
  }
  return (Date.now().toString(16) + Math.floor(Math.random() * 1e8).toString(16)).slice(-16);
}

function numOr(v, def) {
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function clampNum(v, def, min, max) {
  return Math.max(min, Math.min(max, Math.round(numOr(v, def))));
}

/* 按「显示宽度」估文字节点尺寸：汉字算 2，其它算 1 */
function estimateTextSize(text) {
  const lines = String(text || '').split('\n');
  let widest = 0;
  lines.forEach(function (l) {
    let w = 0;
    for (let i = 0; i < l.length; i++) w += (l.charCodeAt(i) > 255 ? 2 : 1);
    if (w > widest) widest = w;
  });
  return {
    width: Math.min(560, Math.max(240, 140 + 6 * widest)),
    height: Math.min(360, Math.max(100, 62 + 26 * lines.length)),
  };
}

function canvasBounds(nodes) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  nodes.forEach(function (n) {
    if (n.x < x1) x1 = n.x;
    if (n.y < y1) y1 = n.y;
    if (n.x + n.width > x2) x2 = n.x + n.width;
    if (n.y + n.height > y2) y2 = n.y + n.height;
  });
  if (!isFinite(x1)) return { x: 0, y: 0, width: 400, height: 300 };
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/* 清洗：id 换成 16 位 hex、字段补全、尺寸按内容估、脏连线丢掉 */
function normalizeCanvas(raw) {
  const nodes = [];
  const idMap = Object.create(null);
  const used = new Set();

  const list = (raw && Array.isArray(raw.nodes)) ? raw.nodes : [];
  list.forEach(function (n, i) {
    if (!n || typeof n !== 'object') return;

    const rawId = String(n.id == null ? ('n' + i) : n.id);
    const id = hexId(used);
    idMap[rawId] = id;

    let type = String(n.type || 'text').toLowerCase();
    if (['text', 'file', 'link', 'group'].indexOf(type) < 0) type = 'text';
    const color = (typeof n.color === 'string' && n.color.trim()) ? n.color.trim() : undefined;

    if (type === 'file' && typeof n.file === 'string' && n.file.trim()) {
      nodes.push({
        id: id, type: 'file',
        x: numOr(n.x, 0), y: numOr(n.y, 0),
        width: clampNum(n.width, 360, 260, 560),
        height: clampNum(n.height, 240, 160, 420),
        file: n.file.trim().replace(/^\[\[|\]\]$/g, ''),
        color: color,
      });
      return;
    }

    if (type === 'link' && typeof n.url === 'string' && n.url.trim()) {
      nodes.push({
        id: id, type: 'link',
        x: numOr(n.x, 0), y: numOr(n.y, 0),
        width: clampNum(n.width, 320, 240, 520),
        height: clampNum(n.height, 180, 120, 320),
        url: n.url.trim(),
        color: color,
      });
      return;
    }

    let text = '';
    ['text', 'label', 'title', 'name'].forEach(function (k) {
      if (!text && typeof n[k] === 'string' && n[k].trim()) text = n[k];
    });
    text = String(text || '').replace(/\\n/g, '\n').trim();

    /* 模型有时不用 id、直接拿节点文字当 fromNode —— 把文字也登记一份，连线就不会白丢 */
    if (text && !idMap[text]) idMap[text] = id;

    if (type === 'group') {
      nodes.push({
        id: id, type: 'group',
        x: numOr(n.x, 0), y: numOr(n.y, 0),
        width: clampNum(n.width, 420, 200, 2400),
        height: clampNum(n.height, 320, 160, 2400),
        label: text || undefined,
        color: color || '4',
      });
      return;
    }

    const size = estimateTextSize(text);
    nodes.push({
      id: id, type: 'text',
      x: numOr(n.x, 0), y: numOr(n.y, 0),
      width: clampNum(n.width, size.width, 220, 620),
      height: clampNum(n.height, size.height, 90, 420),
      text: text || '（空）',
      color: color,
    });
  });

  const ids = new Set(nodes.map(function (n) { return n.id; }));
  const edges = [];
  const pair = new Set();
  const rawEdges = (raw && Array.isArray(raw.edges)) ? raw.edges : [];

  rawEdges.forEach(function (e) {
    if (!e || typeof e !== 'object') return;
    const from = idMap[String(e.fromNode)];
    const to = idMap[String(e.toNode)];
    if (!from || !to || from === to) return;
    if (!ids.has(from) || !ids.has(to)) return;
    const key = from + '>' + to;
    if (pair.has(key)) return;
    pair.add(key);

    const ed = { id: hexId(used), fromNode: from, toNode: to, toEnd: 'arrow' };
    if (typeof e.label === 'string' && e.label.trim()) ed.label = e.label.trim();
    if (typeof e.fromSide === 'string' && /^(top|right|bottom|left)$/.test(e.fromSide)) ed.fromSide = e.fromSide;
    if (typeof e.toSide === 'string' && /^(top|right|bottom|left)$/.test(e.toSide)) ed.toSide = e.toSide;
    if (typeof e.toEnd === 'string' && /^(none|arrow)$/.test(e.toEnd)) ed.toEnd = e.toEnd;
    edges.push(ed);
  });

  return { nodes: nodes, edges: edges };
}

/* 排布：BFS 分层 → 列间距 420、行距 42、每列垂直居中；孤立分量顺延到后面的列 */
function layoutCanvas(canvas, noteTitle) {
  const plain = canvas.nodes.filter(function (n) { return n.type !== 'group'; });
  const groups = canvas.nodes.filter(function (n) { return n.type === 'group'; });
  if (!plain.length) return canvas;

  const byId = Object.create(null);
  const adj = Object.create(null);
  const deg = Object.create(null);
  plain.forEach(function (n) { byId[n.id] = n; adj[n.id] = []; deg[n.id] = 0; });

  canvas.edges.forEach(function (e) {
    if (!adj[e.fromNode] || !adj[e.toNode]) return;
    adj[e.fromNode].push(e.toNode);
    adj[e.toNode].push(e.fromNode);
    deg[e.fromNode] += 1;
    deg[e.toNode] += 1;
  });

  if (!canvas.edges.length) {
    plain.forEach(function (n, i) {
      n.x = (i % 4) * CANVAS_COL;
      n.y = Math.floor(i / 4) * 200;
    });
  } else {
    let root = plain.filter(function (n) { return /^#\s/.test(String(n.text || '').trim()); })[0];
    if (!root) {
      const t = String(noteTitle || '').trim();
      if (t) root = plain.filter(function (n) { return String(n.text || '').indexOf(t) >= 0; })[0];
    }
    if (!root) {
      root = plain.slice().sort(function (a, b) {
        const d = (deg[b.id] || 0) - (deg[a.id] || 0);
        if (d) return d;
        return String(b.text || '').length - String(a.text || '').length;
      })[0];
    }

    const placed = new Set();
    const columns = [];
    const order = [root].concat(plain.filter(function (n) { return n !== root; }));

    order.forEach(function (startNode) {
      if (!startNode || placed.has(startNode.id)) return;

      const levels = [];
      const queue = [{ node: startNode, depth: 0 }];
      placed.add(startNode.id);

      while (queue.length) {
        const cur = queue.shift();
        if (!levels[cur.depth]) levels[cur.depth] = [];
        levels[cur.depth].push(cur.node);

        (adj[cur.node.id] || []).forEach(function (nid) {
          if (placed.has(nid) || !byId[nid]) return;
          placed.add(nid);
          queue.push({ node: byId[nid], depth: cur.depth + 1 });
        });
      }

      const base = columns.length;
      levels.forEach(function (lv, d) {
        if (!lv || !lv.length) return;
        const c = base + d;
        if (!columns[c]) columns[c] = [];
        columns[c] = columns[c].concat(lv);
      });
    });

    columns.forEach(function (col, ci) {
      if (!col || !col.length) return;
      const total = col.reduce(function (sum, n) { return sum + n.height; }, 0)
        + CANVAS_ROW_GAP * Math.max(0, col.length - 1);
      let y = -Math.round(total / 2);
      col.forEach(function (n) {
        n.x = ci * CANVAS_COL;
        n.y = y;
        y += n.height + CANVAS_ROW_GAP;
      });
    });
  }

  if (plain.length === 1) { plain[0].x = 0; plain[0].y = 0; }

  const box = canvasBounds(plain);
  groups.forEach(function (g, i) {
    const off = 24 * (i + 1);
    g.x = box.x - CANVAS_GROUP_PAD + off;
    g.y = box.y - CANVAS_GROUP_PAD + off;
    g.width = Math.max(200, box.width + CANVAS_GROUP_PAD * 2 - off * 2);
    g.height = Math.max(160, box.height + CANVAS_GROUP_PAD * 2 - off * 2);
    if (!g.label) g.label = String(noteTitle || '') || undefined;
  });

  canvas.nodes = groups.concat(plain);
  return canvas;
}

/* ============================ [[笔记]] 引用
   从指令里抽出 [[笔记名]]（支持 [[名|别名]] 和 [[名#标题]]），把对应笔记的正文读出来当参考。
   读不到的直接标 missing，让用户知道名字写错了，而不是悄悄忽略。 */
async function collectLinkRefs(plugin, text, sourcePath) {
  const out = [];
  const seen = {};
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m;

  while ((m = re.exec(String(text || '')))) {
    const name = String(m[1] || '').trim();
    if (!name || seen[name]) continue;
    seen[name] = 1;

    let file = null;
    try {
      file = plugin.app.metadataCache.getFirstLinkpathDest(name, sourcePath || '');
    } catch (e) { file = null; }

    if (!file) { out.push({ name: name, missing: true }); continue; }

    let body = '';
    try { body = await plugin.app.vault.cachedRead(file); } catch (e) { body = ''; }
    out.push({
      name: name,
      path: file.path,
      content: body.length > 4000 ? (body.slice(0, 4000) + '\n…（后面省略）') : body,
    });
  }
  return out;
}

/* ============================================================ 对话框（紧凑浮动面板）
   点左侧 ✨ 打开。一个输入框 + 模板 + 上下文，没有消息历史 ——
   答完就换成一张「AI 生成」小卡片。 */
class RewriteBox {
  /* opts.compact = 快速改写模式：只留一个输入框，不显示模板/引用（选中文字 → 一句话 → 直接改） */
  constructor(app, plugin, prevMsgs, opts) {
    this.app = app;
    this.plugin = plugin;
    this.compact = !!(opts && opts.compact);
    /* 打开那一刻的选区快照 —— 焦点移到输入框后，某些情况下编辑器选区会塌，
       有这份快照就不会把"选中文字"误判成"没选中" */
    this.compactSel = (opts && opts.selection) || '';
    this.continueTitle = (opts && opts.continueTitle) || '';
    this._marksMode = false;
    this.ctxMode = 'auto';        /* auto=有选中用选中，没选中用整篇 / note / none */
    this.busy = false;
    this.msgs = (prevMsgs || []).slice();   /* 带着上一轮的对话进来 = 多轮改稿 */
    this.refs = [];                         /* 手动引用进来的笔记 */
    this.el = null;
    this._onDown = (e) => {
      if (!this.el || this.el.contains(e.target)) return;
      /* 点的是我们自己的弹窗 / 下拉（选笔记的搜索框、历史指令菜单）→ 不算"点外面"。
         不排除的话，mousedown 会先把面板关掉，那一下 click 就落空 ——
         表现就是"鼠标点一下窗口就没了，只能键盘回车"。 */
      const t = e.target;
      if (t && t.closest && (t.closest('.modal-container')
        || t.closest('.suggestion-container')
        || t.closest('.menu'))) return;
      this.close();
    };
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
  }

  /* 自己画浮动面板，**不用 Obsidian 的 Modal**。
     原因：Modal 的宽高被 .modal 限制、内边距被 .modal-content 限制，还有一层遮罩，
     怎么调都显得大。自绘（无遮罩、自定圆角阴影）才能做到这么小。 */
  open() {
    if (this.el) this.close();

    const el = document.createElement('div');
    el.className = 'obai-rwbox' + (this.compact ? ' is-compact' : '');
    this.el = el;

    /* 顶栏（可拖） */
    const head = el.createDiv({ cls: 'obai-rw-head' });
    const markN0 = (this.plugin._marks || []).length;
    head.createEl('span', {
      cls: 'obai-rw-title',
      text: this.compact
        ? ('快速改写' + (markN0 ? ' · ' + markN0 + ' 段' : ''))
        : 'AI 对话',
    });
    const tools = head.createDiv({ cls: 'obai-chat-tools' });
    const closeBtn = tools.createEl('button', { cls: 'obai-rw-x', text: '×' });
    closeBtn.onclick = () => this.close();
    this._drag(head);

    /* 有标记时：告诉用户"这条指令会作用到已标记的段" */
    if (!this.compact && (this.plugin._marks || []).length) {
      const n0 = this.plugin._marks.length;
      const mbar = el.createDiv({ cls: 'obai-rw-marks' });
      mbar.createSpan({ cls: 'obai-rw-marks-text', text: '已标记 ' + n0 + ' 段 · 发送的指令会作用到它们' });
      const mx = mbar.createEl('button', { cls: 'obai-rw-marks-x', text: '取消标记' });
      mx.onclick = () => {
        this._marksMode = false;
        this.plugin.clearMarks(true);
        if (mbar.parentNode) mbar.parentNode.removeChild(mbar);
      };
      this._marksMode = true;
    }

    /* 带着历史进来时：一条提示 + 一个可展开的"上次聊了什么" */
    if (this.msgs.length && !this.compact) {
      const bar = el.createDiv({ cls: 'obai-rw-continue' });
      bar.createSpan({
        cls: 'obai-rw-continue-text',
        text: '↩ 正在继续' + (this.continueTitle ? '「' + this.continueTitle + '」' : '上次对话')
          + ' · ' + this.msgs.length + ' 条消息',
      });
      const x = bar.createEl('button', { cls: 'obai-rw-continue-x', text: '不用了' });

      const det = el.createEl('details', { cls: 'obai-rw-recall' });
      det.createEl('summary', { text: '查看上次内容' });
      const body = det.createDiv({ cls: 'obai-recall-body' });
      this.msgs.forEach(function (m) {
        const isAI = m && m.role === 'assistant';
        const line = body.createDiv({ cls: 'obai-recall-line ' + (isAI ? 'is-ai' : 'is-user') });
        line.createSpan({ cls: 'obai-recall-who', text: isAI ? 'AI' : '你' });
        const txt = String((m && m.content) || '');
        line.createSpan({
          cls: 'obai-recall-text',
          text: txt.length > 400 ? txt.slice(0, 400) + '…' : txt,
        });
      });

      x.onclick = () => {
        this.msgs = [];
        this.continueTitle = '';
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        if (det.parentNode) det.parentNode.removeChild(det);
      };
    }

    /* 输入框（三个小图标内嵌右下角） */
    const wrap = el.createDiv({ cls: 'obai-rw-inputwrap' });
    this.inputEl = wrap.createEl('textarea', { cls: 'obai-rw-input' });
    this.inputEl.setAttribute('placeholder',
      this.compact ? '一句话说明怎么改，例如「改得更简洁」' : '描述你想让 AI 做什么…');
    const inner = wrap.createDiv({ cls: 'obai-rw-inner' });

    if (!this.compact) {
      const scanBtn = inner.createEl('button', { cls: 'obai-rw-iconbtn' });
      setIcon(scanBtn, 'scan-search');
      scanBtn.title = '找出相关段落并标记（不改正文）';
      scanBtn.onclick = () => {
        this.close();
        this.plugin.markFromAI();
      };
    }

    const hisBtn = inner.createEl('button', { cls: 'obai-rw-iconbtn' });
    setIcon(hisBtn, 'history');
    hisBtn.title = '历史：最近的对话 / 用过的指令';
    hisBtn.onclick = () => this._historyMenu(hisBtn);

    this.optBtn = inner.createEl('button', { cls: 'obai-rw-iconbtn' });
    setIcon(this.optBtn, 'sparkles');
    this.optBtn.title = '优化提示词';
    this.optBtn.onclick = () => this._optimize(this.optBtn);

    const sendBtn = inner.createEl('button', { cls: 'obai-rw-iconbtn is-send' });
    setIcon(sendBtn, 'send');
    sendBtn.title = '发送（Enter）';
    sendBtn.onclick = () => this._send();

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    this.inputEl.addEventListener('input', () => {
      try {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight + 2, 180) + 'px';
      } catch (e) { dlog('L2115', e); }
    });

    /* 模板 chips（快速模式不显示，省地方） */
    const tpls = this.compact ? [] : (this.plugin.settings.promptTemplates || []);
    if (tpls.length) {
      const tplWrap = el.createDiv({ cls: 'obai-tpl' });
      tpls.forEach((t) => {
        const chip = tplWrap.createEl('button', { text: t.name, cls: 'obai-chipbtn' });
        chip.title = t.text || '';
        chip.onclick = () => this._insertText(renderTemplate(t.text || '', tplContext(this.plugin)));
      });
    }

    /* 引用的笔记：按钮 + chip 区（快速模式不显示） */
    if (this.compact) this.refsWrap = null;
    else {
    const refRow = el.createDiv({ cls: 'obai-rw-refs' });
    const addRefBtn = refRow.createEl('button', { text: '＋ 引用笔记', cls: 'obai-chipbtn' });
    addRefBtn.title = '选一篇笔记一起发给 AI（也可以直接在输入框里写 [[笔记名]]）';
    addRefBtn.onclick = () => {
      new NoteSuggestModal(this.app, async (file) => {
        if (this.refs.some(function (r) { return r.path === file.path; })) {
          new Notice('Hadesr AI：这篇已经引用过了');
          return;
        }
        let body = '';
        try { body = await this.app.vault.cachedRead(file); } catch (e) { body = ''; }
        this.refs.push({
          name: file.basename,
          path: file.path,
          content: body.length > 4000 ? (body.slice(0, 4000) + '\n…（后面省略）') : body,
        });
        this._renderRefs();
      }).open();
    };
    const relBtn = refRow.createEl('button', { text: '＋ 关联笔记', cls: 'obai-chipbtn' });
    relBtn.title = '把这篇笔记里 [[链接]] 到的笔记一次都引用进来（最多 10 篇）';
    relBtn.onclick = () => this._addRelatedRefs();
    this.refsWrap = refRow.createDiv({ cls: 'obai-ref-chips' });
    }

    /* 上下文 chip —— 快速模式不建：
       快速改写的语义是"改我选中的这段"，不该出现"换成整篇笔记 / 不带上下文"这种切换 */
    if (this.compact) {
      this.ctxChip = null;
    } else {
      const ctxRow = el.createDiv({ cls: 'obai-rw-ctx' });
      this.ctxChip = ctxRow.createEl('button', { cls: 'obai-chipbtn obai-ctx-chip' });
      this.ctxChip.onclick = () => this._ctxMenu();
      this._refreshCtx();
    }

    el.createEl('div', { cls: 'obai-rw-hint', text: this.compact
      ? '回车直接改 · Shift+Enter 换行 · Esc 关闭'
      : '回车发送 · Shift+Enter 换行 · Esc 关闭 · 点 ⏱ 看历史' });

    document.body.appendChild(el);
    this._place();

    document.addEventListener('mousedown', this._onDown, true);
    document.addEventListener('touchstart', this._onDown, true);
    document.addEventListener('keydown', this._onKey, true);

    setTimeout(() => { try { this.inputEl.focus(); } catch (e) { dlog('L2179', e); } }, 20);
  }

  /* 贴选区下方（放不下就翻上去）；没选区就居中偏上 */
  _place() {
    const el = this.el;
    if (!el) return;
    const rect = ResultCard.selectionRect();
    const pad = 12;
    const w = el.offsetWidth || (this.compact ? 380 : 520);
    const h = el.offsetHeight || 320;
    const vw = (typeof window.innerWidth === 'number' && window.innerWidth) ? window.innerWidth : 1200;
    const vh = (typeof window.innerHeight === 'number' && window.innerHeight) ? window.innerHeight : 800;

    if (rect) {
      el.style.left = Math.round(Math.min(Math.max(pad, rect.left), vw - w - pad)) + 'px';
      let top = rect.bottom + 10;
      if (top + h > vh - pad) top = Math.max(pad, rect.top - h - 10);
      el.style.top = Math.round(Math.max(pad, top)) + 'px';
    } else {
      el.style.left = Math.round((vw - w) / 2) + 'px';
      el.style.top = Math.round(Math.max(pad, (vh - h) / 2 - 60)) + 'px';
    }
  }

  /* 拖顶栏 */
  _drag(handle) { makeDraggable(this.el, handle); }

  /* ---------- 上下文 ---------- */
  _ctxLabel() {
    const ed = this.plugin._activeEditor();
    const sel = ed ? (ed.getSelection() || '') : '';
    const len = ed ? (ed.getValue() || '').length : 0;
    if (this.ctxMode === 'none') return '🚫 不带上下文';
    if (this.ctxMode === 'note') return '📄 整篇笔记（' + len + ' 字）';
    if (sel.trim()) {
      /* 带一小段预览 —— 一眼看出带进去的是哪段 */
      const flat = sel.trim().replace(/\s+/g, ' ');
      return '📝 选中文本 · ' + flat.slice(0, 16) + (flat.length > 16 ? '…' : '');
    }
    return '📄 整篇笔记（' + len + ' 字）';
  }

  /* 把已引用的笔记画成一排 chip，每个带 × 可移除 */
  _renderRefs() {
    if (!this.refsWrap) return;
    this.refsWrap.empty();
    const self = this;
    this.refs.forEach(function (r, i) {
      const chip = self.refsWrap.createDiv({ cls: 'obai-ref-chip' });
      chip.createSpan({ text: '📄 ' + r.name });
      const x = chip.createSpan({ cls: 'obai-ref-x', text: '×' });
      x.title = '不再引用这篇';
      x.onclick = function (ev) {
        ev.stopPropagation();
        self.refs.splice(i, 1);
        self._renderRefs();
      };
    });
  }

  /* 一键引用"关联笔记"：把当前这篇里 [[链接]] 到的笔记都拉进来。
     比"整个文件夹"精准得多 —— 只带这篇真正提到的东西，不会把上下文撑爆。 */
  async _addRelatedRefs() {
    const f = this.app.workspace.getActiveFile ? this.app.workspace.getActiveFile() : null;
    if (!f) { new Notice('Hadesr AI：先打开一篇笔记'); return; }

    let body = '';
    try { body = await this.app.vault.cachedRead(f); } catch (e) { body = ''; }
    if (!String(body).trim()) { new Notice('Hadesr AI：这篇笔记是空的'); return; }

    let found = [];
    try { found = await collectLinkRefs(this.plugin, body, f.path); } catch (e) { found = []; }

    const MAX = 10;
    const self = this;
    let added = 0, dup = 0, miss = 0;
    found.forEach(function (r) {
      if (added >= MAX) return;
      if (r.missing) { miss++; return; }
      if (r.path === f.path) return;                                   /* 别引用自己 */
      if ((self.refs || []).some(function (x) { return x.path === r.path; })) { dup++; return; }
      self.refs.push({ name: r.name, path: r.path, content: r.content });
      added++;
    });
    this._renderRefs();

    if (!found.length) { new Notice('Hadesr AI：这篇笔记里没有 [[链接]]'); return; }
    let msg = 'Hadesr AI：引用了 ' + added + ' 篇关联笔记';
    if (dup) msg += '，' + dup + ' 篇已在列表里';
    if (miss) msg += '，' + miss + ' 个链接没找到';
    if (added >= MAX) msg += '（一次最多 ' + MAX + ' 篇）';
    new Notice(msg, 5000);
  }

  _refreshCtx() {
    if (!this.ctxChip) return;
    this.ctxChip.setText(this._ctxLabel());
    const ed = this.plugin._activeEditor();
    const sel = ed ? (ed.getSelection() || '').trim() : '';
    if (sel) this.ctxChip.title = sel;      /* 悬停看全文 */
    else this.ctxChip.title = '';
  }

  _ctxMenu() {
    const menu = tagMenu(new Menu());
    const mk = (t, mode) => menu.addItem((i) => i.setTitle(t).onClick(() => {
      this.ctxMode = mode;
      this._refreshCtx();
    }));
    mk('📝 选中文本', 'auto');
    mk('📄 整篇笔记', 'note');
    mk('🚫 不带上下文', 'none');
    const r = this.ctxChip.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
    tagMenu(menu);
  }

  /* ---------- 最近用过的 ---------- */
  _historyMenu(btn) {
    const plug = this.plugin;
    const s = plug.settings;
    const hist = (s.promptHistory || []).slice();
    const chats = (s.chatHistory || []).slice(0, 8);
    const menu = tagMenu(new Menu());

    /* 第一段：最近的对话 */
    menu.addItem(function (i) { i.setTitle('最近的对话'); if (i.setDisabled) i.setDisabled(true); });
    if (!chats.length) {
      menu.addItem(function (i) {
        i.setTitle('（还没有 —— 用对话框问一次就会记下）');
        if (i.setDisabled) i.setDisabled(true);
      });
    } else {
      chats.forEach((c) => {
        const d = new Date(c.ts || 0);
        const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        const label = hh + '　' + (c.title || '（无标题）');
        menu.addItem((i) => i.setTitle(label.length > 50 ? label.slice(0, 50) + '…' : label)
          .onClick(() => {
            this.close();
            new RewriteBox(this.app, this.plugin, c.msgs, { continueTitle: c.title }).open();
          }));
      });
      menu.addItem((i) => i.setTitle('清空对话历史').onClick(async () => {
        s.chatHistory = [];
        await plug.saveSettings();
        new Notice('Hadesr AI：已清空对话历史');
      }));
    }

    menu.addSeparator();

    /* 第二段：最近用过的指令 */
    menu.addItem(function (i) { i.setTitle('最近用过的指令'); if (i.setDisabled) i.setDisabled(true); });
    if (!hist.length) {
      menu.addItem(function (i) { i.setTitle('（还没有）'); if (i.setDisabled) i.setDisabled(true); });
    } else {
      hist.forEach((h) => {
        menu.addItem((i) => i.setTitle(h.length > 46 ? h.slice(0, 46) + '…' : h)
          .onClick(() => { this.inputEl.value = h; this.inputEl.focus(); }));
      });
      menu.addItem((i) => i.setTitle('清空最近用过的指令').onClick(async () => {
        s.promptHistory = [];
        await plug.saveSettings();
        new Notice('Hadesr AI：已清空最近用过的指令');
      }));
    }

    const r = btn.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
    tagMenu(menu);
  }

  _remember(text) {
    const s = this.plugin.settings;
    s.promptHistory = Array.isArray(s.promptHistory) ? s.promptHistory : [];
    s.promptHistory = [text].concat(s.promptHistory.filter((x) => x !== text)).slice(0, 20);
    this.plugin.saveSettings();
  }

  /* 存一条对话（只留提问与回答） */
  _saveChat(prompt, reply, turns) {
    try {
      const s = this.plugin.settings;
      if (s.rememberChat === false) return;
      const msgs = (turns || [])
        .filter(function (m) { return m && m.role !== 'system'; })
        .concat([{ role: 'assistant', content: String(reply || '') }]);
      s.chatHistory = pushChatHistory(s.chatHistory, { title: prompt, msgs: msgs });
      this.plugin.saveSettings();
    } catch (e) { dlog('L2370', e); }
  }

  _insertText(text) {
    const el = this.inputEl;
    if (!el) return;
    const at = (typeof el.selectionStart === 'number') ? el.selectionStart : el.value.length;
    const cur = el.value || '';
    const before = cur.slice(0, at);
    const after = cur.slice(at);
    el.value = before + (before && !before.endsWith('\n') ? '\n' : '') + text + after;
    el.focus();
    el.selectionStart = el.selectionEnd = el.value.length;
  }

  /* ---------- 优化提示词 ---------- */
  async _optimize(btn) {
    if (this.busy) return;
    const raw = String(this.inputEl.value || '').trim();
    if (!raw) { new Notice('Hadesr AI：先随手写一句你想要什么，再点优化'); return; }

    this.busy = true;
    btn.setText('优化中…');
    btn.setAttribute('disabled', '');
    try {
      const res = await chatMessages(this.plugin, [
        {
          role: 'system',
          content: '你是提示词工程师。把用户这句粗糙的指令改写成一条**更明确、可执行**的中文提示词：' +
            '补齐"要处理什么、怎么处理、输出什么格式、不许做什么"。' +
            '不要解释、不要加引号、不要分点列清单，只输出改写后的那一条提示词。',
        },
        { role: 'user', content: raw },
      ], '');
      this.inputEl.value = String(res.text || '').trim();
      this.inputEl.focus();
      new Notice('Hadesr AI：提示词已优化，你可以再改');
    } catch (e) {
      new Notice('Hadesr AI：优化失败 —— ' + String((e && e.message) || e), 10000);
    } finally {
      this.busy = false;
      btn.setText('✨ 优化提示词');
      btn.removeAttribute('disabled');
    }
  }

  /* ---------- 发送 ---------- */
  async _send() {
    if (this.busy) return;
    const input = String(this.inputEl.value || '').trim();
    if (!input) { new Notice('Hadesr AI：先说你想让它做什么'); return; }

    /* 快速改写的硬约束：一定要有选中的文字。
       少了这道检查，用户若在输入框里操作时把选区弄丢，就会拿着整篇笔记去"改写"，
       结果完全不是他要的，还以为插件坏了。 */
    /* 对话框里发的指令，直接作用到已标记的段 */
    if (!this.compact && this._marksMode && (this.plugin._marks || []).length) {
      const edM = this.plugin._activeEditor();
      if (!edM) { new Notice('Hadesr AI：先打开一篇笔记'); return; }
      const actM = {
        id: 'adhoc',
        name: '批量指令',
        instruction: input + '\n\n只输出处理后的这一段内容本身；'
          + '若指令要求删除这一段，只输出 <DELETE>；不要解释、不要加引号、不要加代码块。',
      };
      this.close();
      this.plugin.runMarked(actM, edM, { includeSelection: false });
      return;
    }

    if (this.compact) {
      const ed0 = this.plugin._activeEditor();
      const markN = (this.plugin._marks || []).length;

      /* 有标记 → 这条指令作用到所有标记的段上 */
      if (markN) {
        const act = {
          id: 'quick-rewrite',
          name: '快速改写',
          instruction: input + '\n\n只输出处理后的这一段内容本身；'
            + '若指令要求删除这一段，只输出 <DELETE>；不要解释、不要加引号、不要加代码块。',
        };
        this.close();
        this.plugin.runMarked(act, ed0, { includeSelection: false });
        return;
      }

      const live0 = ed0 ? (ed0.getSelection() || '') : '';
      if (!live0.trim() && !String(this.compactSel || '').trim()) {
        new Notice('Hadesr AI：先在正文里选中要改的文字');
        return;
      }
    }

    this.busy = true;
    let card = null;

    try {
      const ctx = tplContext(this.plugin);
      const instr = renderTemplate(input, ctx);

      let sys = '你是 Obsidian 笔记助手。用中文，简洁具体。只输出结果本身，不要"以下是……"这类前后缀。';
      /* 实时选区优先；塌掉了就用打开面板时的快照（快速改写必须有"要改的那段"） */
      const selText = String(ctx.selection || '').trim()
        ? ctx.selection
        : (this.compact ? this.compactSel : '');
      const mode = this.ctxMode === 'auto' ? (String(selText || '').trim() ? 'sel' : 'note') : this.ctxMode;
      if (mode === 'sel' && String(selText || '').trim()) {
        sys += '\n\n【要处理的文本】\n' + selText;
      } else if (mode === 'note' && ctx.fileContent) {
        sys += '\n\n【当前笔记】\n' + ctx.fileContent;
      }
      if (ctx.filePath) sys += '\n\n（文件：' + ctx.filePath + '）';

      /* 引用的笔记 = 点「＋ 引用笔记」选的 + 输入框里手写的 [[笔记名]]，按路径去重 */
      let typed = [];
      try { typed = await collectLinkRefs(this.plugin, instr); } catch (e) { typed = []; }

      const merged = [];
      const seenPath = {};
      (this.refs || []).forEach(function (r) {
        if (!r || seenPath[r.path]) return;
        seenPath[r.path] = 1;
        merged.push(r);
      });
      typed.forEach(function (r) {
        if (r.missing) { merged.push(r); return; }
        if (seenPath[r.path]) return;
        seenPath[r.path] = 1;
        merged.push(r);
      });

      if (merged.length) {
        sys += '\n\n【引用的笔记】';
        merged.forEach(function (r) {
          if (r.missing) {
            sys += '\n\n《' + r.name + '》：没有找到这篇笔记';
          } else {
            sys += '\n\n《' + r.name + '》（' + r.path + '）\n' + r.content;
          }
        });
        const miss = merged.filter(function (r) { return r.missing; }).map(function (r) { return r.name; });
        if (miss.length) new Notice('Hadesr AI：没找到这些笔记 —— ' + miss.join('、'), 6000);
      }

      /* 第一轮才塞 system；后面几轮沿用它 */
      const turns = this.msgs.slice();
      if (!turns.some(function (m) { return m.role === 'system'; })) {
        turns.unshift({ role: 'system', content: sys });
      }
      turns.push({ role: 'user', content: instr });

      const self = this;
      /* 结果卡就落在对话框原来的位置 —— 视觉上像"这个框直接变成了 AI 生成" */
      const rect = (this.el && this.el.getBoundingClientRect)
        ? this.el.getBoundingClientRect()
        : ResultCard.selectionRect();

      card = new ResultCard(this.app, this.plugin, {
        loading: true,
        providerLabel: this.plugin._activeName(),
        before: String(selText || ''),   /* → 「对比」按钮 */
        /* → 「参考了 …」回链：只列真的找到的（missing 的不列） */
        sources: merged.filter(function (r) { return r && !r.missing; })
          .map(function (r) { return { name: r.name, path: r.path }; }),
        rect: rect,
        onRetry: function (c) {
          c.showLoading();
          chatMessages(self.plugin, turns, '')
            .then(function (r) { c.showResult(r.text); })
            .catch(function (e) { c.showError(String((e && e.message) || e)); });
        },
        onContinue: function (c) {
          const next = turns.concat([{ role: 'assistant', content: c._curText() }]);
          c.close();
          new RewriteBox(self.app, self.plugin, next).open();
        },
      }).open();

      /* 发出去就把对话框收掉 —— 同一时刻只留一个面板 */
      this.close();

      const targetId = this.compact ? 'quick-rewrite' : 'chat';
      const forceId = (this.plugin.settings.actionProviders || {})[targetId] || '';
      const res = await chatMessages(this.plugin, turns, forceId, function (snap) { card.streamUpdate(snap); });
      if (!this.compact) {
        this._remember(input);                    /* 快速改写不记进「最近用过」 */
        this._saveChat(input, res.text, turns);
      }

      card.setProviderLabel((res.provider.name || '未命名') + ' / ' + (res.provider.model || '')
        + (res.tried > 1 ? '（前 ' + (res.tried - 1) + ' 个没通）' : ''));
      card.showResult(res.text, res.reasoning);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (card) card.showError(msg);
      else new Notice('Hadesr AI：' + msg, 12000);
    } finally {
      this.busy = false;
    }
  }

  close() {
    if (this.plugin && this.plugin._rwBox === this) this.plugin._rwBox = null;
    document.removeEventListener('mousedown', this._onDown, true);
    document.removeEventListener('touchstart', this._onDown, true);
    document.removeEventListener('keydown', this._onKey, true);
    if (this.el) { this.el.remove(); this.el = null; }
  }
}

/* 让浮动面板可以拖顶栏。
   改写框和结果卡共用这一份拖拽实现。 */
function makeDraggable(el, handle) {
  if (!el || !handle) return;
  handle.style.cursor = 'move';
  handle.style.userSelect = 'none';
  handle.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = function (ev) {
      const vw = (typeof window.innerWidth === 'number') ? window.innerWidth : 1200;
      const vh = (typeof window.innerHeight === 'number') ? window.innerHeight : 800;
      const w = el.offsetWidth;
      const l = Math.max(8, Math.min(ev.clientX - dx, vw - w - 8));
      const t = Math.max(8, Math.min(ev.clientY - dy, vh - 56));
      el.style.left = Math.round(l) + 'px';
      el.style.top = Math.round(t) + 'px';
    };
    const up = function () {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/* 模型经常把 JSON 包在 ``` 里、或者前后带一句解释 —— 抠出第一个 {...} 再解析 */
function parseJsonLoose(text) {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : String(text || ''));
  } catch (e) { return null; }
}

/* ============================================================ AI 划范围
   让模型只做"找段落"，返回锚点；本地定位后变成"标记"，不碰正文。 */

const LOCATE_SYSTEM = [
  '你在帮用户定位笔记中的段落。根据描述，找出所有相关段落。',
  '只输出严格 JSON：{"matches":[{"anchor":"该段内唯一的一段原文（10~40字，逐字复制）","scope":"paragraph"}]}',
  'scope：paragraph = 整段（到空行为止）；line = 仅这一行。',
  'anchor 必须能在原文中逐字找到；找不到的不要输出。不要解释、不要加代码块。',
].join('\n');

/* 从 idx 向外扩到空行边界（段落） */
function expandToParagraph(doc, idx) {
  const src = String(doc || '');
  let start = src.lastIndexOf('\n\n', idx);
  start = (start < 0) ? 0 : start + 2;
  let end = src.indexOf('\n\n', idx);
  end = (end < 0) ? src.length : end;
  while (start < end && /\s/.test(src[start])) start++;
  while (end > start && /\s/.test(src[end - 1])) end--;
  return { start: start, end: end };
}

/* 两段式 AI 划范围（见 markFromAI）：
   第一段只把「章节目录」发给模型，让它挑出可能相关的章节编号；
   第二段只把挑中的章节正文发给模型定位锚点。
   全文很长时，模型看到的 token 少 5~10 倍：首字更快、锚点也更准（不会被大段无关正文带偏）。 */

const PICK_SYSTEM = [
  '你在帮用户从一篇笔记里挑出「可能包含目标内容」的章节。',
  '下面给出笔记的章节目录：每行「#编号 [层级] 标题」加开头一小段预览。',
  '判断哪些章节里可能有用户说的东西 —— 宁可多选一节，也不要漏（漏掉就找不到了）。',
  '只输出严格 JSON：{"sections":[编号, ...]}，最多挑 8 个。不要解释、不要加代码块。',
].join('\n');

const OUTLINE_MAX = 40;   /* 目录超过这么多节，就只保留 H1/H2 分组（避免目录比正文还长） */

/* 把文档拆成章节（按标题切）。标题前若有正文，先有一节「（开头）」。
   没有标题的小文档：返回一节「（全文）」。 */
function buildOutline(doc, max) {
  const src = String(doc || '');
  const all = [];
  const re = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(src))) all.push({ level: m[1].length, title: m[2], start: m.index });

  if (!all.length) {
    return src.trim() ? [{ i: 0, level: 0, title: '（全文）', start: 0, end: src.length }] : [];
  }

  let keep = all;
  const limit = max || OUTLINE_MAX;
  if (keep.length > limit) {
    for (const lv of [2, 1]) {
      const f = all.filter((x) => x.level <= lv);
      if (f.length && f.length <= limit) { keep = f; break; }
    }
  }

  const secs = [];
  if (keep[0].start > 0) {
    secs.push({ i: secs.length, level: 0, title: '（开头）', start: 0, end: keep[0].start });
  }
  for (let k = 0; k < keep.length; k++) {
    secs.push({
      i: secs.length, level: keep[k].level, title: keep[k].title,
      start: keep[k].start, end: (k + 1 < keep.length) ? keep[k + 1].start : src.length,
    });
  }
  return secs;
}

/* 目录文本：层级用缩进体现，并附一小段预览，方便模型判断。 */
function outlineText(secs, doc, preview) {
  const src = String(doc || '');
  const pre = preview || 80;
  return (secs || []).map(function (s) {
    const body = src.slice(s.start, s.end).replace(/\s+/g, ' ').trim().slice(0, pre);
    const indent = '  '.repeat(Math.max(0, (s.level || 1) - 1));
    return '#' + s.i + ' ' + indent + (s.level ? ('H' + s.level + ' ') : '') + s.title + (body ? ('\n' + indent + body) : '');
  }).join('\n');
}

/* 把挑中的章节正文拼成一段「节选」（各节之间空行分隔），用于第二段精定位。
   budget 限制总字数，超出就不再拼后面的节（大文档只送最相关的几节）。 */
function focusText(doc, secs, idxs, budget) {
  const src = String(doc || '');
  const cap = budget || 60000;
  const parts = [];
  let total = 0;
  (idxs || []).forEach(function (i) {
    const s = secs[i];
    if (!s) return;
    const t = src.slice(s.start, s.end).replace(/\s+$/, '');
    if (total && total + t.length + 2 > cap) return;   /* 已经够用就不继续堆了 */
    parts.push(t);
    total += t.length + 2;
  });
  return parts.join('\n\n');
}

/* 把模型给的锚点变成文档里的区间；找不到的记进 missed */
function locateMatches(doc, matches) {
  const src = String(doc || '');
  const hits = [];
  const missed = [];

  (matches || []).forEach(function (m) {
    const a = String((m && m.anchor) || '');
    if (!a) { missed.push(m); return; }
    const i = src.indexOf(a);
    if (i < 0 || src.indexOf(a, i + 1) >= 0) { missed.push(m); return; }

    let r;
    if (m.scope === 'line') {
      const s0 = src.lastIndexOf('\n', i) + 1;
      let e0 = src.indexOf('\n', i);
      if (e0 < 0) e0 = src.length;
      r = { start: s0, end: e0 };
    } else {
      r = expandToParagraph(src, i);
    }
    if (r.end <= r.start) { missed.push(m); return; }
    hits.push({ start: r.start, end: r.end, text: src.slice(r.start, r.end) });
  });

  hits.sort(function (x, y) { return x.start - y.start; });
  const out = [];
  let last = -1;
  hits.forEach(function (h) {
    if (h.start < last) return;
    out.push(h);
    last = h.end;
  });
  return { hits: out, missed: missed };
}

/* 重试时旧偏移已因前面的写入而失效，只保留文本，交给 _runSegments 重新定位 */
function relocate(list) {
  return (list || []).map(function (x) { return { start: -1, end: -1, text: x.text }; });
}

/* 去掉首尾的空白行。
   AI 常爱在结果前后各带一个换行；内联「替换」时这个换行会把文字顶到下一行
   （表现为"替换一个字却另起一行"）。只删空行，不动正文的缩进。 */
function trimBlankEdges(s) {
  return String(s == null ? '' : s)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '');
}

/* 归一化模型输出：空=失败；<DELETE>=删除；剥掉代码围栏 */
function normalizeSegmentOut(raw) {
  let t = String(raw || '').trim();
  if (!t) return { ok: false, text: '' };
  if (/^<DELETE>$/i.test(t) || t === '（删除）') {
    return { ok: true, text: '', del: true };
  }
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  return { ok: !!t, text: t };
}

/* 对话历史：只留提问与回答，最多 20 条、每条 10 轮、单条 2000 字。
   不放 system（里面有选中的正文），继续对话时按当前上下文重建。 */
const CHAT_HISTORY_MAX = 20;

/* 只用毫秒时间戳做 id，同一毫秒内写两条会互相覆盖 —— 补一个自增序号 */
let chatSeq = 0;
function nextChatId() {
  chatSeq = (chatSeq + 1) % 1000000;
  return 'h' + Date.now().toString(36) + '-' + chatSeq.toString(36);
}

function pushChatHistory(list, record) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const rec = {
    id: (record && record.id) || nextChatId(),
    ts: (record && record.ts) || Date.now(),
    title: String((record && record.title) || '').slice(0, 40),
    msgs: ((record && record.msgs) || []).slice(-10).map(function (m) {
      return {
        role: m && m.role === 'assistant' ? 'assistant' : 'user',
        content: String((m && m.content) || '').slice(0, 2000),
      };
    }),
  };
  return [rec].concat(arr.filter(function (x) { return x && x.id !== rec.id; }))
    .slice(0, CHAT_HISTORY_MAX);
}

/* ============================================================ 行级差异（自己实现，不引依赖）
   用途：点「替换」之前，先看清到底改了哪几行。
   思路：先掐掉公共前后缀（绝大多数改动只在中间一小段），再对中段做 LCS。
   中段太大（>400 行）就不做 LCS 了，直接"整段删 + 整段加"，避免 O(n*m) 卡死。 */
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: '=', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', text: a[i] }); i++; }
    else { out.push({ t: '+', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ t: '-', text: a[i] }); i++; }
  while (j < m) { out.push({ t: '+', text: b[j] }); j++; }
  return out;
}

function diffLines(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).replace(/\r\n/g, '\n').split('\n');
  const b = String(newText == null ? '' : newText).replace(/\r\n/g, '\n').split('\n');

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: '=', text: a[i] });

  const LIMIT = 400;
  if (midA.length > LIMIT || midB.length > LIMIT) {
    midA.forEach(function (t) { ops.push({ t: '-', text: t }); });
    midB.forEach(function (t) { ops.push({ t: '+', text: t }); });
  } else {
    lcsOps(midA, midB).forEach(function (o) { ops.push(o); });
  }

  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: '=', text: a[i] });
  return ops;
}

/* 未改动的长段折叠成「… N 行未变」，否则原文 200 行会把卡片撑爆 */
function compactDiffOps(ops, keep) {
  const k = Math.max(2, keep || 6);
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t !== '=') { out.push(ops[i]); i++; continue; }
    let j = i;
    while (j < ops.length && ops[j].t === '=') j++;
    const run = j - i;
    if (run <= k) {
      for (let x = i; x < j; x++) out.push(ops[x]);
    } else {
      out.push(ops[i], ops[i + 1]);
      out.push({ t: '…', text: '（' + (run - 4) + ' 行未改动）' });
      out.push(ops[j - 2], ops[j - 1]);
    }
    i = j;
  }
  return out;
}

/* ============================================================ 结果卡片（浮动）
   不是 Modal —— 浮在选区下方的一张小卡片，不挡整屏、不遮笔记。
   状态：加载中 → 结果（渲染后的 Markdown）→ 底部按钮。
   看久了可以直接滚页面，卡片不会跟着关（只在 Esc / 点外面 / 点 × 时关）。 */
class ResultCard {
  constructor(app, plugin, opts) {
    this.app = app;
    this.plugin = plugin;
    this.opts = opts || {};
    this.el = null;
    this.editing = false;
    this.diffing = false;      /* 正在看「对比原文」 */
    this.textEl = null;
    this._reasoning = opts && opts.reasoning ? String(opts.reasoning) : '';
    this._onDown = (e) => {
      if (!this.el || this.el.contains(e.target)) return;
      /* 点的是我们自己的对话框 → 别关卡片 */
      if (e.target && e.target.closest && e.target.closest('.modal-container')) return;
      this.close();
    };
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
  }

  static selectionRect() {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const node = sel.getRangeAt(0).commonAncestorContainer;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!el || !el.closest || !el.closest('.cm-editor')) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return null;
      return r;
    } catch (e) { return null; }
  }

  open() {
    if (this.el) this.close();

    const el = document.createElement('div');
    el.className = 'obai-floatcard';
    this.el = el;

    /* 顶栏（可拖） */
    const head = document.createElement('div');
    head.className = 'obai-rw-head';
    const title = document.createElement('span');
    title.className = 'obai-chat-title';
    title.textContent = 'AI 生成';
    this.titleEl = title;
    head.appendChild(title);

    const tools = document.createElement('div');
    tools.className = 'obai-chat-tools';
    const who = document.createElement('span');
    who.className = 'obai-sug-who';
    who.textContent = this.opts.providerLabel || '';
    this.whoEl = who;
    tools.appendChild(who);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'obai-rw-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => this.close();
    tools.appendChild(closeBtn);
    head.appendChild(tools);
    el.appendChild(head);
    this._drag(head);

    /* 正文 */
    this.body = document.createElement('div');
    this.body.className = 'obai-sug-body';
    el.appendChild(this.body);

    /* 按钮条 */
    this.bar = document.createElement('div');
    this.bar.className = 'obai-btns obai-sug-btns';
    el.appendChild(this.bar);

    document.body.appendChild(el);

    if (this.opts.loading) this.showLoading();
    else this.showResult(this.opts.text || '');

    this._place();
    document.addEventListener('mousedown', this._onDown, true);
    document.addEventListener('touchstart', this._onDown, true);
    document.addEventListener('keydown', this._onKey, true);
    return this;
  }

  _drag(handle) { makeDraggable(this.el, handle); }

  _place() {
    const el = this.el;
    const rect = this.opts.rect || ResultCard.selectionRect();
    const pad = 12;
    const w = el.offsetWidth || 520;   /* 结果卡片没有 compact 概念，别跟着改写框一起变 */
    const h = el.offsetHeight || 300;
    const vw = (typeof window.innerWidth === 'number' && window.innerWidth) ? window.innerWidth : 1200;
    const vh = (typeof window.innerHeight === 'number' && window.innerHeight) ? window.innerHeight : 800;

    if (rect) {
      /* 优先贴选区下方；下面放不开就翻到上方 */
      el.style.left = Math.round(Math.min(Math.max(pad, rect.left), vw - w - pad)) + 'px';
      let top = rect.bottom + 10;
      if (top + h > vh - pad) top = rect.top - h - 10;
      el.style.top = Math.round(Math.max(pad, top)) + 'px';
    } else {
      el.style.left = Math.round((vw - w) / 2) + 'px';
      el.style.top = Math.round(Math.max(pad, (vh - h) / 2)) + 'px';
    }
  }

  setProviderLabel(t) { if (this.whoEl) this.whoEl.textContent = t || ''; }

  showLoading() {
    if (!this.el) return;
    /* 标题本身说明"正在干嘛" —— AI 正在润色 / AI 正在翻译成中文 / AI 正在转成表格…
       取的是 action.doing（读得通的动名词），没写的动作退回 name */
    this.titleEl.textContent = 'AI 正在' + (this.opts.actionName || '生成');
    this.titleEl.classList.add('is-writing');
    this.body.empty();
    this.body.style.display = 'none';
    this.bar.empty();
    this._place();
  }

  /* 流式：边收边画。节流到 ~90ms —— 每来一个字就重排一次会把界面卡死 */
  streamUpdate(snap) {
    if (!this.el) return;
    const now = Date.now();
    if (this._paintAt && now - this._paintAt < 90) return;
    this._paintAt = now;

    this.titleEl.textContent = snap.text ? 'AI 正在写…' : 'AI 正在思考…';
    this.titleEl.classList.add('is-writing');
    this.body.style.display = '';
    this.body.empty();

    if (snap.reasoning) {
      const det = this.body.createEl('details', { cls: 'obai-think' });
      det.setAttribute('open', '');
      det.createEl('summary', { text: '思考中…（' + snap.reasoning.length + ' 字）' });
      det.createEl('div', { cls: 'obai-think-body', text: snap.reasoning });
    }
    if (snap.text) {
      this.body.createEl('div', { cls: 'obai-stream', text: snap.text });
    }
    this._place();
  }

  showResult(text, reasoning) {
    if (!this.el) return;
    this._text = String(text || '');
    if (typeof reasoning === 'string') this._reasoning = reasoning;
    this.editing = false;
    this.diffing = false;
    this.titleEl.textContent = 'AI 生成';
    this.titleEl.classList.remove('is-writing');
    this.body.style.display = '';
    this._renderBody();
    this._renderButtons();
    this._place();
  }

  showError(msg) {
    if (!this.el) return;
    this.titleEl.textContent = '出错了';
    this.titleEl.classList.remove('is-writing');
    this.body.style.display = '';
    this.body.empty();
    const p = this.body.createDiv({ cls: 'obai-err-block' });
    p.setText(msg);
    this.bar.empty();
    /* 出错也给「重试」—— 多半是网络/服务抖了一下，重发一次就好 */
    if (this.opts.onRetry) {
      const r = this.bar.createEl('button', { text: '重试', cls: 'obai-btn' });
      r.onclick = () => { this.showLoading(); this.opts.onRetry(this); };
    }
    const b = this.bar.createEl('button', { text: '关闭', cls: 'obai-btn ghost' });
    b.onclick = () => this.close();
  }

  /* 引用回链：把"这次参考了哪几篇笔记"列出来，点一下直接跳过去。
     数据来自发送时实际塞进 prompt 的那几篇（不是模型自报的），所以不会瞎编。 */
  _renderSources() {
    const srcs = (this.opts && this.opts.sources) || [];
    if (!srcs.length) return;
    const row = this.body.createDiv({ cls: 'obai-src-row' });
    row.createEl('span', { cls: 'obai-src-label', text: '参考了' });
    const self = this;
    srcs.forEach(function (src) {
      const chip = row.createEl('button', { cls: 'obai-src-chip', text: src.name });
      chip.title = src.path;
      chip.onclick = function () {
        try {
          const f = self.app.vault.getAbstractFileByPath(src.path);
          if (f) self.app.workspace.getLeaf(false).openFile(f);
          else self.app.workspace.openLinkText(src.name, '', false);
        } catch (e) {
          new Notice('Hadesr AI：打不开这篇笔记');
        }
      };
    });
  }

  /* 有原文、有新文，才谈得上对比 */
  _canDiff() {
    const b = this.opts && this.opts.before;
    return typeof b === 'string' && b.trim().length > 0 && String(this._text || '').trim().length > 0;
  }

  _renderDiff() {
    const before = String(this.opts.before || '');
    const ops = compactDiffOps(diffLines(before, this._curText()), 6);
    const add = ops.filter(function (o) { return o.t === '+'; }).length;
    const del = ops.filter(function (o) { return o.t === '-'; }).length;

    const head = this.body.createDiv({ cls: 'obai-diff-head' });
    head.createSpan({ text: '对比原文' });
    head.createSpan({ cls: 'obai-diff-stat', text: '＋' + add + ' 行　−' + del + ' 行' });

    const box = this.body.createDiv({ cls: 'obai-diff' });
    ops.forEach(function (op) {
      const cls = op.t === '+' ? 'is-add' : op.t === '-' ? 'is-del' : op.t === '…' ? 'is-skip' : 'is-same';
      const row = box.createDiv({ cls: 'obai-diff-line ' + cls });
      row.createSpan({ cls: 'obai-diff-sign', text: op.t === '=' ? ' ' : op.t });
      row.createSpan({ cls: 'obai-diff-text', text: op.text === '' ? ' ' : op.text });
    });
  }

  _renderBody() {
    this.body.empty();
    this.textEl = null;

    /* 推理模型会返回「思考过程」—— 默认折叠，想看再点开 */
    if (this._reasoning && this._reasoning.trim()) {
      const det = this.body.createEl('details', { cls: 'obai-think' });
      det.createEl('summary', { text: '思考过程（' + this._reasoning.length + ' 字）' });
      det.createEl('div', { cls: 'obai-think-body', text: this._reasoning });
    }

    if (this.diffing) { this._renderDiff(); return; }

    if (this.editing) {
      this.textEl = this.body.createEl('textarea', { cls: 'obai-text' });
      this.textEl.value = this._text;
      return;
    }
    const md = this.body.createDiv({ cls: 'obai-md' });
    try {
      MarkdownRenderer.render(this.app, this._text, md, '', this.plugin);
    } catch (e) {
      md.setText(this._text);
    }

    this._renderSources();
  }

  _curText() {
    if (this.editing && this.textEl) return this.textEl.value;
    return this._text || '';
  }

  _copy() {
    navigator.clipboard.writeText(this._curText()).then(
      function () { new Notice('Hadesr AI：已复制'); },
      function () { new Notice('Hadesr AI：复制失败'); }
    );
  }

  _renderButtons() {
    const bar = this.bar;
    bar.empty();
    const mk = (label, cls, fn) => {
      const b = bar.createEl('button', { text: label, cls: 'obai-btn ' + (cls || '') });
      b.onclick = fn;
      return b;
    };

    /* 文件类产出（Canvas）：创建 / 创建并嵌入 / 复制 / 丢弃 */
    if (this.opts.fileActions && this.opts.fileActions.length) {
      this.opts.fileActions.forEach((a) => {
        mk(a.label, '', () => a.fn(this));
      });
      mk('复制', '', () => this._copy());
      mk('丢弃', 'ghost', () => this.close());
      return;
    }

    /* 纯信息（frontmatter 已经写进文件了）：替换/插入没意义，只留复制与关闭 */
    if (this.opts.mode === 'info') {
      mk('复制', '', () => this._copy());
      mk('关闭', 'ghost', () => this.close());
      return;
    }

    /* 阅读模式不能改文档 —— 只留复制 / 存为笔记；编辑模式保持原样 */
    let readOnly = false;
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      readOnly = !!(view && typeof view.getMode === 'function' && view.getMode() === 'preview');
    } catch (e) { readOnly = false; }

    if (!readOnly) {
      mk('替换', '', () => this._apply(true));
      mk('插入到下方', '', () => this._apply(false));
    }
    mk('复制', '', () => this._copy());
    mk('存为笔记', 'ghost', () => this._saveAsNote());

    /* 对比模式下：只把新增的行复制走（拿去做别的事很方便） */
    if (this.diffing) {
      const ops2 = compactDiffOps(diffLines(String(this.opts.before || ''), this._curText()), 6);
      const adds = ops2.filter(function (o) { return o.t === '+'; }).map(function (o) { return o.text; });
      if (adds.length) {
        mk('复制改动行', '', function () {
          navigator.clipboard.writeText(adds.join('\n')).then(
            function () { new Notice('Hadesr AI：已复制 ' + adds.length + ' 行改动'); },
            function () { new Notice('Hadesr AI：复制失败'); }
          );
        });
      }
    }

    /* 有原文就给出「对比」：点替换之前先看清改了哪几行 */
    if (this._canDiff()) {
      mk(this.diffing ? '看结果' : '对比', '', () => {
        if (this.editing && this.textEl) this._text = this.textEl.value;
        this.editing = false;
        this.diffing = !this.diffing;
        this._renderBody();
        this._renderButtons();
        this._place();
      });
    }

    if (this.opts.onRetry) mk('重试', 'ghost', () => this.opts.onRetry(this));
    if (!this.diffing) {
      this.editBtn = mk('编辑', 'ghost', () => {
        if (this.editing && this.textEl) this._text = this.textEl.value;
        this.editing = !this.editing;
        this._renderBody();
        this.editBtn.setText(this.editing ? '看预览' : '编辑');
        this._place();
      });
    }
    if (this.opts.onContinue) mk('继续对话', 'ghost', () => this.opts.onContinue(this));
  }

  /* 把结果存成一篇新笔记（放在当前笔记同目录，文件名带时间） */
  async _saveAsNote() {
    const text = this._curText();
    if (!text.trim()) { new Notice('Hadesr AI：没有内容可保存'); return; }
    const app = this.plugin.app;
    const active = app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
    const folder = active && active.parent && active.parent.path !== '/' ? active.parent.path + '/' : '';
    const d = new Date();
    const stamp = d.getFullYear()
      + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0') + '-'
      + String(d.getHours()).padStart(2, '0')
      + String(d.getMinutes()).padStart(2, '0');
    const base = 'AI 生成 ' + stamp;
    let path = folder + base + '.md';
    let n = 1;
    while (app.vault.getAbstractFileByPath(path)) {
      n++;
      path = folder + base + ' (' + n + ').md';
    }
    try {
      const f = await app.vault.create(path, text);
      new Notice('Hadesr AI：已存为「' + f.path + '」');
      this.close();
      if (app.workspace.getLeaf) app.workspace.getLeaf(false).openFile(f);
    } catch (e) {
      new Notice('Hadesr AI：保存失败 —— ' + String((e && e.message) || e), 8000);
    }
  }

  _apply(replace) {
    if (this.editing && this.textEl) this._text = this.textEl.value;
    /* 去掉首尾空行：否则内联替换会被 AI 结果携带的换行顶到下一行 */
    const text = trimBlankEdges(this._text);
    const ed = this.plugin._activeEditor();
    if (!ed) { new Notice('Hadesr AI：没找到打开的笔记'); return; }

    if (replace) {
      const sel = ed.getSelection();
      if (!sel || !sel.trim()) {
        new Notice('Hadesr AI：当前没选中文字 —— 先在笔记里选一段，再点「替换」', 6000);
        return;
      }
      try {
        ed.replaceSelection(text);
      } catch (e) {
        dlog('_apply', e);
        new Notice('Hadesr AI：替换失败 —— ' + String((e && e.message) || e), 8000);
        return;
      }
      new Notice('Hadesr AI：已替换选中内容');
      this.close();
      return;
    }
    const cur = ed.getCursor('to');
    try {
      ed.replaceRange('\n\n' + text + '\n', { line: cur.line + 1, ch: 0 });
    } catch (e) {
      dlog('_apply', e);
      new Notice('Hadesr AI：插入失败 —— ' + String((e && e.message) || e), 8000);
      return;
    }
    new Notice('Hadesr AI：已插入到光标下方');
    this.close();
  }

  close() {
    if (this.plugin && this.plugin._rwBox === this) this.plugin._rwBox = null;
    document.removeEventListener('mousedown', this._onDown, true);
    document.removeEventListener('touchstart', this._onDown, true);
    document.removeEventListener('keydown', this._onKey, true);
    if (this.el) { this.el.remove(); this.el = null; }
  }
}

/* 插件主体 */
module.exports = class ObaiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this._modelCache = {};        /* 每接口拉到的模型列表（只在内存，不落盘） */

    /* ✨ 放在**文档右上角**（编辑 / 阅读按钮左边），不占左侧栏。
       用 ItemView.addAction —— 这是官方 API，按钮会插进 .view-actions 里。 */
    this._headerActions = [];
    const attachHeader = (view) => {
      if (!view || typeof view.addAction !== 'function') return;
      if (view._obaiHeaderAction) return;
      const el = view.addAction('sparkles', 'Hadesr AI：AI 对话', () => this.openRewrite());
      view._obaiHeaderAction = el || true;
      this._headerActions.push({ view: view, el: el });
    };
    const attachAll = () => {
      const leaves = this.app.workspace.getLeavesOfType('markdown') || [];
      leaves.forEach((lf) => attachHeader(lf.view));
    };
    this.registerEvent(this.app.workspace.on('active-leaf-change', attachAll));
    this.registerEvent(this.app.workspace.on('layout-change', attachAll));
    this.app.workspace.onLayoutReady(attachAll);

    this.addCommand({
      id: 'open-rewrite',
      name: 'AI 对话（描述你要什么）',
      icon: 'sparkles',
      callback: () => this.openRewrite(),
    });

    this.addCommand({
      id: 'pick-action',
      name: '选择要执行的动作…',
      icon: 'list',
      checkCallback: (checking) => {
        const editor = this._activeEditor();
        if (!editor) return false;
        if (!checking) this.openMenu(null);
        return true;
      },
    });

    allActions(this.settings).forEach((a) => {
      this.addCommand({
        id: 'run-' + a.id,
        name: a.name + '（选中文本 → AI）',
        icon: a.icon || 'sparkles',
        editorCallback: (editor) => this.run(a, editor),
      });
    });

    this.addCommand({
      id: 'run-active-on-note',
      name: '对整篇笔记执行某个动作…',
      editorCallback: (editor, view) => this.runOnWholeNote(editor, view),
    });

    this.addCommand({
      id: 'gen-frontmatter',
      name: '添加笔记属性（标题 / 摘要 / 标签）',
      icon: 'file-json',
      editorCallback: (editor) => this.genFrontmatter(editor),
    });

    this.addCommand({
      id: 'gen-canvas',
      name: '把当前笔记转成 Canvas',
      icon: 'layout-dashboard',
      editorCallback: (editor) => this.genCanvas(editor),
    });

    /* 一键开关（懒得进设置页时用；也可以给它绑快捷键） */
    this.addCommand({
      id: 'toggle-complete',
      name: '行内补全：开 / 关',
      icon: 'toggle-left',
      callback: () => this.toggleComplete(),
    });

    /* 行内补全手动触发：排查"为什么不补"最直接的一招 —— 失败会明确告诉你卡在哪一环 */
    this.addCommand({
      id: 'quick-rewrite',
      name: '快速改写选中的文字',
      icon: 'pen-line',
      editorCallback: (editor) => {
        if (!(editor.getSelection() || '').trim()) {
          new Notice('Hadesr AI：先选中要改的文字');
          return;
        }
        this.openQuickRewrite();
      },
    });

    this.addCommand({
      id: 'mark-selection',
      name: '标记选中内容（可标记多段，最后一起处理）',
      icon: 'bookmark-plus',
      editorCallback: (editor) => this.markSelection(editor),
    });

    this.addCommand({
      id: 'mark-from-ai',
      name: '让 AI 找出相关段落并标记',
      icon: 'scan-search',
      callback: () => this.markFromAI(),
    });

    this.addCommand({
      id: 'clear-marks',
      name: '清除所有标记',
      icon: 'eraser',
      callback: () => this.clearMarks(),
    });

    this.addCommand({
      id: 'complete-now',
      name: '行内补全：现在补一次',
      icon: 'text-cursor-input',
      editorCallback: () => this.completeNow(),
    });

    /* 右键菜单：分类挂在编辑器菜单末尾（Obsidian 官方 API 只能往后加） */
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      const hasSel = !!(editor.getSelection() || '').trim();
      menu.addSeparator();
      this.addHadesrMenu(menu, editor, hasSel);
    }));

    /* 选中浮条 */
    this.bubble = new SelectionBubble(this);
    this.bubble.mount();

    /* 行内补全：CodeMirror 6 的灰字 widget。
       整段包 try/catch —— 用的是 Obsidian 未公开的模块，绝不能让一个附加功能
       把整个插件拖成"加载失败" */
    let cmExt = null;
    try {
      cmExt = installCompleter(this);
    } catch (e) {
      console.error('[obai] 行内补全装配失败（其余功能不受影响）：', e);
      cmExt = null;
    }
    if (cmExt) {
      try {
        this.registerEditorExtension(cmExt);
      } catch (e) {
        console.error('[obai] 注册编辑器扩展失败：', e);
        cmExt = null;
      }
    }
    if (!cmExt) this._cmMissing = true;
    this._cmInstalled = !!cmExt;
    this._lastComplete = null;

    this.addSettingTab(new ObaiSettingTab(this.app, this));
  }

  onunload() {
    try { this.flushSave(); } catch (e) { dlog('L3369', e); }
    try { if (menuSweep) { clearInterval(menuSweep); menuSweep = 0; } } catch (e) { dlog('L3370', e); }
    if (this.bubble) { this.bubble.destroy(); this.bubble = null; }
    (this._headerActions || []).forEach((it) => {
      try { if (it.el && it.el.remove) it.el.remove(); } catch (e) { dlog('L3373', e); }
      try { if (it.view) delete it.view._obaiHeaderAction; } catch (e) { dlog('L3374', e); }
    });
    this._headerActions = [];
  }

  /* 设置页关掉补全时，把已经显示着的灰字擦掉（否则它会一直挂在那儿） */
  clearGhosts() {
    if (!obaiGhostAPI) return;
    const leaves = this.app.workspace.getLeavesOfType('markdown') || [];
    leaves.forEach((lf) => {
      const cmView = lf.view && lf.view.editor && lf.view.editor.cm;
      if (cmView) obaiGhostAPI.clear(cmView);
    });
  }

  /* 一键开关补全（命令 / 右键 / 胶囊下拉都走这里） */
  async toggleComplete() {
    this.settings.complete = !this.settings.complete;
    await this.saveSettings();
    if (!this.settings.complete) this.clearGhosts();
    new Notice('Hadesr AI：行内补全已' + (this.settings.complete ? '开启' : '关闭'));
    return this.settings.complete;
  }

  /* 手动补一次（命令与设置页按钮都走这里）。失败原因会弹 Notice */
  completeNow() {
    if (!obaiGhostAPI) {
      new Notice('Hadesr AI：行内补全没装上 —— 拿不到 CodeMirror 模块（设置页「补全诊断」里有说明）', 8000);
      return;
    }
    if (!this.settings.complete) {
      new Notice('Hadesr AI：行内补全还没启用 —— 设置 → Hadesr AI → 行内补全 → 启用', 8000);
      return;
    }
    const ed = this._activeEditor();
    const cm = ed && ed.cm;
    if (!cm) { new Notice('Hadesr AI：当前没有打开的编辑器'); return; }
    obaiGhostAPI.runNow(cm);
  }

  _activeEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view && view.editor ? view.editor : null;
  }

  /* 按 id 执行动作（浮条 / 菜单用，不需要提前持有 action 对象） */
  runActionById(id) {
    const a = allActions(this.settings).filter((x) => x.id === id)[0];
    if (!a) { new Notice('Hadesr AI：这个动作已经不存在了'); return; }
    const editor = this._activeEditor();
    if (!editor) { new Notice('Hadesr AI：先打开一篇笔记'); return; }
    this.run(a, editor);
  }

  _activeName() {
    const s = this.settings;
    if (s.mode === MODE_AUTO) return '自动(依次尝试)';
    const p = (s.providers || []).filter((x) => x.id === s.activeProvider)[0];
    return p ? (p.name || '未命名') : '（未选接口）';
  }

  /* 悬浮条菜单里也要能触发整篇级操作 */
  runCanvas() {
    const ed = this._activeEditor();
    if (!ed) { new Notice('Hadesr AI：先打开一篇笔记'); return; }
    this.genCanvas(ed);
  }

  runFrontmatter() {
    const ed = this._activeEditor();
    if (!ed) { new Notice('Hadesr AI：先打开一篇笔记'); return; }
    this.genFrontmatter(ed);
  }

  /* 打开对话面板：先关掉已有的，避免连点叠出多个 */
  _openBox(opts) {
    if (this._rwBox) { try { this._rwBox.close(); } catch (e) { dlog('L3450', e); } }
    const box = new RewriteBox(this.app, this, null, opts);
    this._rwBox = box;
    box.open();
    return box;
  }

  openRewrite() {
    this._openBox();
  }

  /* 当前文件里已标记的段（别的笔记的标记不参与） */
  marksHere() {
    const ws = this.app && this.app.workspace;
    const f = ws && ws.getActiveFile ? ws.getActiveFile() : null;
    const path = f ? f.path : '';
    return (this._marks || []).filter(function (m) { return m.path === path; });
  }

  /* 标记当前选区，攒够了再一次执行 */
  markSelection(editor) {
    const ed = editor || this._activeEditor();
    if (!ed) { new Notice('Hadesr AI：先打开一篇笔记'); return; }
    const sel = ed.getSelection();
    if (!sel || !sel.trim()) { new Notice('Hadesr AI：先选中一段文字再标记'); return; }

    const start = ed.posToOffset(ed.getCursor('from'));
    const end = ed.posToOffset(ed.getCursor('to'));
    const f = this.app.workspace.getActiveFile ? this.app.workspace.getActiveFile() : null;
    const path = f ? f.path : '';
    this._marks = this._marks || [];

    if (this._marks.some(function (m) { return m.path === path && m.start === start && m.end === end; })) {
      new Notice('Hadesr AI：这一段已经标记过了');
      return;
    }
    /* 与已有标记重叠时，以新标记为准 —— 两段区间交叉会让写回冲突 */
    this._marks = this._marks.filter(function (m) {
      return !(m.path === path && m.start < end && m.end > start);
    });
    if (this._marks.length >= 10) {
      new Notice('Hadesr AI：最多标记 10 段，先执行或清除一下', 6000);
      return;
    }
    this._marks.push({ path: path, start: start, end: end, text: sel });
    new Notice('Hadesr AI：已标记 ' + this._marks.length + ' 段'
      + '（再选一段继续标记，或直接点动作一起执行）', 5000);
    if (this.bubble) this.bubble._refreshLabel();
  }

  clearMarks(silent) {
    this._marks = [];
    if (!silent) new Notice('Hadesr AI：已清除全部标记');
    if (this.bubble) this.bubble._refreshLabel();
  }

  openQuickRewrite() {
    const ed = this._activeEditor();
    const sel = ed ? (ed.getSelection() || '') : '';
    const marks = (this._marks || []).length;
    if (!sel.trim() && !marks) {
      new Notice('Hadesr AI：先选中要改的文字（或先标记几段再打开）', 6000);
      return;
    }
    this._lastActionId = QUICK_TARGET.id;   /* 记住它：下次胶囊主按钮直接是「快速改写」 */
    this._openBox({ compact: true, selection: sel });
  }

  /* 右键菜单：统一挂在「Hadesr AI」这一个入口下。
     · 有选中 → 全功能（编辑 ▸ / 生成 ▸ / 翻译 + AI 对话）
     · 没选中 → 只给不需要选中的（AI 对话 / 整篇处理 / 添加笔记属性） */
  addHadesrMenu(menu, editor, hasSel) {
    const self = this;
    tagMenu(menu);   /* 这个 menu 是 Obsidian 传进来的，也要打标才会收窄 */

    const fill = (sub) => {
      if (hasSel) {
        buildActionMenu(sub, allActions(self.settings), (a) => self.run(a, editor));
        sub.addSeparator();
        /* 快速改写必须有选中文字，所以只在这个分支出现 */
        sub.addItem((i) => i.setTitle('快速改写…').setIcon('pen-line')
          .onClick(() => self.openQuickRewrite()));
        sub.addItem((i) => i.setTitle('标记此段（攒着一起处理）').setIcon('bookmark-plus')
          .onClick(() => self.markSelection(editor)));
      }
      if ((self._marks || []).length) {
        sub.addItem((i) => i.setTitle('清除 ' + self._marks.length + ' 段标记').setIcon('eraser')
          .onClick(() => self.clearMarks()));
      }
      sub.addItem((i) => i.setTitle('AI 对话…').setIcon('sparkles')
        .onClick(() => self.openRewrite()));
      sub.addItem((i) => i.setTitle('对整篇笔记执行…').setIcon('file-text')
        .onClick(() => self.runOnWholeNote(editor, null)));
      sub.addItem((i) => i.setTitle('添加笔记属性').setIcon('file-json')
        .onClick(() => self.genFrontmatter(editor)));
      sub.addItem((i) => {
        const on = self.settings.complete === true;
        i.setTitle(on ? '关闭行内补全' : '开启行内补全')
          .setIcon(on ? 'toggle-right' : 'toggle-left');
        i.onClick(() => self.toggleComplete());
      });
      sub.addItem((i) => i.setTitle('转成 Canvas').setIcon('layout-dashboard')
        .onClick(() => self.genCanvas(editor)));
    };

    if (menuSupportsSubmenu()) {
      let sub = null;
      menu.addItem((i) => {
        i.setTitle('Hadesr AI').setIcon('sparkles');
        sub = tagMenu(i.setSubmenu());
      });
      if (sub) { fill(sub); return; }
    }

    /* 万一没有子菜单能力 → 平铺，先用一条不可点的标题撑一下 */
    menu.addItem((i) => {
      i.setTitle('Hadesr AI');
      if (typeof i.setDisabled === 'function') i.setDisabled(true);
    });
    fill(menu);
  }

  openMenu(evt) {
    const editor = this._activeEditor();
    if (!editor) { new Notice('Hadesr AI：先打开一篇笔记'); return; }

    const menu = tagMenu(new Menu());
    menu.addItem((i) => {
      i.setTitle('接口：' + this._activeName());
      if (typeof i.setDisabled === 'function') i.setDisabled(true);
    });
    menu.addSeparator();

    buildActionMenu(menu, allActions(this.settings), (a) => this.run(a, editor));

    menu.addSeparator();
    menu.addItem((i) => i.setTitle('对整篇笔记执行…').setIcon('file-text')
      .onClick(() => this.runOnWholeNote(editor, null)));

    if (evt) {
      menu.showAtMouseEvent(evt);
    tagMenu(menu);
    } else {
      /* 从命令面板调起时没有鼠标事件 → 在屏幕上方居中弹 */
      const vw = (typeof window.innerWidth === 'number' && window.innerWidth) ? window.innerWidth : 1200;
      menu.showAtPosition({ x: Math.round(vw / 2) - 120, y: 160 });
    tagMenu(menu);
    }
  }

  /* 多光标产生的多个非空选区（按文档顺序，最多 10 个） */
  _multiSelections(editor) {
    let list = [];
    try {
      const sels = (typeof editor.listSelections === 'function') ? (editor.listSelections() || []) : [];
      list = sels.map(function (r) {
        const a = r.anchor, b = r.head;
        const aOff = editor.posToOffset(a), bOff = editor.posToOffset(b);
        if (aOff <= bOff) return { from: a, to: b, aOff: aOff, bOff: bOff };
        return { from: b, to: a, aOff: bOff, bOff: aOff };
      }).filter(function (r) { return r.bOff > r.aOff; });
    } catch (e) { list = []; }
    list.sort(function (x, y) { return x.aOff - y.aOff; });
    return list;
  }

  run(action, editor) {
    /* 有标记 → 标记的各段一起处理（当前选区也算一段） */
    if ((this._marks || []).length) { this.runMarked(action, editor); return; }

    /* 多个选区 → 批量处理（每段独立请求，结果一次性写回） */
    const multi = this._multiSelections(editor);
    if (multi.length > 1) { this.runMulti(action, editor, multi); return; }

    const sel = editor.getSelection();
    if (!sel || !sel.trim()) {
      new Notice('Hadesr AI：请先选中要处理的文本\n（想整篇处理，用命令「对整篇笔记执行当前动作」）', 6000);
      return;
    }
    this._dispatch(action, sel, editor, true);
  }

  /* 多选区批量：转成统一段落结构，交给 _runSegments */
  async runMulti(action, editor, sels) {
    const list = (sels || []).slice(0, 10).map(function (x) {
      return {
        start: editor.posToOffset(x.from),
        end: editor.posToOffset(x.to),
        text: editor.getRange(x.from, x.to),
      };
    }).filter(function (x) { return String(x.text || '').trim(); });

    if (!list.length) return;
    await this._runSegments(action, editor, list, '多选区');
  }

  /* 让 AI 找出相关段落 → 只标记，不改正文。
     两段式：先发「章节目录」让模型挑相关章节，再只发这几节正文做精定位。
     全文很长时 token 量骤降，首字更快、锚点更准；小文档则一次搞定（目录比正文还长，分段反而慢）。 */
  async markFromAI() {
    const ed = this._activeEditor();
    if (!ed) { new Notice('Hadesr AI：先打开一篇笔记'); return; }
    const doc = ed.getValue();
    if (!doc.trim()) { new Notice('Hadesr AI：这篇笔记是空的'); return; }
    if (doc.length > 200000) { new Notice('Hadesr AI：文档太长，先精简再用这个功能', 8000); return; }

    const q = await askText(this.app, '要标记哪些段落？', '');
    if (!q) return;

    const card = new ResultCard(this.app, this, {
      loading: true,
      providerLabel: this._activeName(),
      actionName: '查找段落',
      rect: ResultCard.selectionRect(),
    }).open();

    const chatPv = (this.settings.actionProviders || {})['chat'] || '';

    /* 小文档（或根本没有分节）直接走原流程；有分节且够长才值得先挑章节。 */
    let target = doc, pickedN = 0, totalN = 0;
    try {
      const secs = buildOutline(doc, OUTLINE_MAX);
      totalN = secs.length;
      if (secs.length > 1 && doc.length > 6000) {
        const pick = await chatMessages(this, [
          { role: 'system', content: PICK_SYSTEM },
          { role: 'user', content: '【目录】\n' + outlineText(secs, doc) + '\n\n【要找】\n' + q },
        ], chatPv, null);

        const pd = parseJsonLoose(pick.text);
        const idxs = Array.from(new Set(((pd && pd.sections) || [])
          .map((n) => parseInt(n, 10))
          .filter((n) => isFinite(n) && n >= 0 && n < secs.length)))
          .sort((a, b) => a - b).slice(0, 8);

        if (idxs.length && idxs.length < secs.length) {
          const ft = focusText(doc, secs, idxs, 60000);
          if (ft.length < doc.length) { target = ft; pickedN = idxs.length; }
        }
        dlog('markFromAI.pick', null, '目录 ' + secs.length + ' 节 → 挑中 ' + idxs.length + ' 节，送 ' + target.length + ' 字');
      }

      const res = await chatMessages(this, [
        { role: 'system', content: LOCATE_SYSTEM },
        { role: 'user', content: (target === doc ? '【文档】\n' : '【文档节选（相关章节）】\n') + target + '\n\n【要找】\n' + q },
      ], chatPv, null);

      const data = parseJsonLoose(res.text);
      const matches = (data && data.matches) || [];
      if (!matches.length) {
        card.showError('AI 没返回可用的段落。换个说法再试，比如「所有包含 - 开头命令行的段落」。');
        return;
      }

      /* 命中区间是相对 target（节选）的；段落文本本身是原文的逐字切片，
         用 doc.indexOf 映射回原文偏移即可（节选拼接不会改动字符）。 */
      const secHits = locateMatches(target, matches);
      const f = this.app.workspace.getActiveFile ? this.app.workspace.getActiveFile() : null;
      const path = f ? f.path : '';
      const seen = new Set();
      const hits = [];
      const missed = secHits.missed.slice();
      secHits.hits.forEach((h) => {
        const si = doc.indexOf(h.text);
        if (si < 0) { missed.push({ anchor: h.text.slice(0, 20) }); return; }
        if (seen.has(si)) return;
        seen.add(si);
        hits.push({ start: si, end: si + h.text.length, text: h.text });
      });

      if (!hits.length) {
        card.showError('AI 给的片段在原文里定位不到（通常是把原文抄错了一两个字）。可以换个说法再试。');
        return;
      }

      this._marks = this._marks || [];
      let added = 0;
      hits.forEach((h) => {
        if (this._marks.length >= 10) return;
        const dup = this._marks.some(function (m) {
          return m.path === path && m.start === h.start && m.end === h.end;
        });
        if (dup) return;
        this._marks.push({ path: path, start: h.start, end: h.end, text: h.text });
        added++;
      });

      card.close();
      if (this.bubble) this.bubble._refreshLabel();
      let tail = '';
      if (pickedN) tail += '（先看目录锁定 ' + pickedN + '/' + totalN + ' 节）';
      if (missed.length) tail += (tail ? '　' : '') + missed.length + ' 处没定位到';
      new Notice('Hadesr AI：已标记 ' + added + ' 段' + tail + '，接着说指令就行。', 6000);
      if (added) this.openRewrite();
    } catch (e) {
      dlog('markFromAI', e);
      card.showError(String((e && e.message) || e));
    }
  }

  /* 统一批量执行：2 路并发，失败可重试 */
  async _runSegments(action, editor, segs, label) {
    const MAX = 10;

    /* start < 0 表示"位置已失效"（比如重试）：按原文重新找一次，找不到就丢弃 */
    const docNow = editor.getValue();
    let list = segs.map(function (x) {
      if (x.start >= 0) return x;
      const i = docNow.indexOf(x.text);
      if (i < 0 || docNow.indexOf(x.text, i + 1) >= 0) return null;
      return { start: i, end: i + x.text.length, text: x.text };
    }).filter(Boolean).slice(0, MAX);

    /* 安全网：区间不能交叉 —— CodeMirror 的 transaction 要求 changes 有序且不重叠。
       标记可能来自不同途径（手动标记 + AI 划范围），重叠时保留靠前的一段。 */
    list.sort(function (a, b) { return a.start - b.start; });
    const noOverlap = [];
    let lastEnd = -1;
    list.forEach(function (x) {
      if (x.start < lastEnd) return;
      noOverlap.push(x);
      lastEnd = x.end;
    });
    const overlapDrop = list.length - noOverlap.length;
    list = noOverlap;
    const overflow = segs.length - list.length;
    const forced = (this.settings.actionProviders || {})[action.id] || '';
    const docLen = editor.getValue().length;

    const panel = new BatchPanel(
      this,
      (action.pill || action.name || '处理') + ' · 批量' + (label ? '（' + label + '）' : ''),
      list
    ).open();

    const changes = [];
    const failed = [];
    let ok = 0, done = 0, cursor = 0;

    const runOne = async (i) => {
      if (panel.cancelled) return;
      if (panel.isSkipped(i)) { done++; panel.setFoot('已完成 ' + done + ' / ' + list.length + '…'); return; }
      panel.setStatus(i, 'run');
      try {
        if (!String(list[i].text || '').trim()) throw new Error('空段');
        const res = await chat(this, action, list[i].text, forced);
        if (panel.isSkipped(i)) return;          /* 请求期间点了跳过：结果丢弃 */
        const n = normalizeSegmentOut(res && res.text);
        if (!n.ok) throw new Error('空返回');
        changes.push({ start: list[i].start, end: list[i].end, text: n.text });
        ok++;
        panel.setStatus(i, 'ok', n.del ? '删除' : '完成');
      } catch (e) {
        dlog('_runSegments', e);
        failed.push(list[i]);
        panel.setStatus(i, 'fail');
      } finally {
        done++;
        panel.setFoot('已完成 ' + done + ' / ' + list.length + '…');
      }
    };

    /* 两路并发：既比串行快一倍，又不会一次打满接口 */
    const workers = [];
    const CONC = Math.min(2, list.length);
    for (let w = 0; w < CONC; w++) {
      workers.push((async () => {
        while (!panel.cancelled) {
          const i = cursor++;
          if (i >= list.length) return;
          await runOne(i);
        }
      })());
    }
    await Promise.all(workers);

    if (panel.cancelled) {
      new Notice('Hadesr AI：已取消，文档未改动', 5000);
      return false;
    }
    if (!ok) {
      panel.markDone('全部失败，文档未改动',
        failed.length ? () => this._runSegments(action, editor, relocate(failed), '重试') : null);
      return false;
    }
    if (editor.getValue().length !== docLen) {
      panel.markDone('处理期间文档被改动了，未写入');
      new Notice('Hadesr AI：处理期间文档被改动了，为安全起见没有写入', 9000);
      return false;
    }

    try {
      changes.sort(function (a, b) { return a.start - b.start; });
      const tx = changes.map(function (c) {
        return { from: editor.offsetToPos(c.start), to: editor.offsetToPos(c.end), text: c.text };
      });
      if (typeof editor.transaction === 'function') {
        editor.transaction({ changes: tx });
      } else {
        tx.slice().reverse().forEach(function (c) { editor.replaceRange(c.text, c.from, c.to); });
      }
      const msg = '已处理 ' + ok + ' 段'
        + (failed.length ? '，' + failed.length + ' 段失败' : '')
        + (overflow
          ? '（另有 ' + overflow + ' 段未处理'
            + (overlapDrop ? '，其中 ' + overlapDrop + ' 段与前一段重叠' : '')
            + '）'
          : '')
        + '（Cmd/Ctrl+Z 可整体撤销）';
      panel.markDone(msg, failed.length
        ? () => this._runSegments(action, editor, relocate(failed), '重试')
        : null);
      new Notice('Hadesr AI：' + msg, 7000);
      return true;
    } catch (e) {
      panel.markDone('写入失败');
      new Notice('Hadesr AI：写入失败 —— ' + String((e && e.message) || e), 8000);
      return false;
    }
  }

  /* 执行所有标记（外加当前选区） */
  async runMarked(action, editor, opts) {
    const f = this.app.workspace.getActiveFile ? this.app.workspace.getActiveFile() : null;
    const path = f ? f.path : '';
    const doc = editor.getValue();
    const marks = (this._marks || []).filter(function (m) { return m.path === path; });
    const segs = [];
    let dropped = 0;

    marks.forEach(function (m) {
      const cur = doc.slice(m.start, m.end);
      if (cur === m.text) { segs.push({ start: m.start, end: m.end, text: m.text }); return; }
      const i = doc.indexOf(m.text);
      if (i >= 0 && doc.indexOf(m.text, i + 1) < 0) {
        segs.push({ start: i, end: i + m.text.length, text: m.text });
      } else {
        dropped++;
      }
    });

    const sel = (opts && opts.includeSelection === false) ? '' : editor.getSelection();
    if (sel && sel.trim()) {
      const st = editor.posToOffset(editor.getCursor('from'));
      const en = editor.posToOffset(editor.getCursor('to'));
      const dup = segs.some(function (x) { return x.start === st && x.end === en; });
      if (!dup) segs.push({ start: st, end: en, text: sel });
    }

    segs.sort(function (a, b) { return a.start - b.start; });
    this.clearMarks(true);

    if (!segs.length) { new Notice('Hadesr AI：标记的内容已失效（文档改过了），请重新标记', 7000); return; }
    if (dropped) new Notice('Hadesr AI：有 ' + dropped + ' 段标记已失效，已跳过', 5000);
    await this._runSegments(action, editor, segs, '批量');
  }

  async runOnWholeNote(editor, view) {
    const text = editor.getValue();
    if (!text || !text.trim()) { new Notice('Hadesr AI：这篇笔记是空的'); return; }
    const pick = await pickAction(this.app, allActions(this.settings));
    if (!pick) return;
    this._dispatch(pick, text, editor, false);
  }

  /* 生成 frontmatter：AI 给 JSON → 只补缺失字段合并进 YAML */
  async genFrontmatter(editor) {
    const note = editor.getValue();
    if (!note || !note.trim()) { new Notice('Hadesr AI：这篇笔记是空的'); return; }

    const action = {
      id: 'frontmatter',
      name: '添加笔记属性',
      system: '你是笔记助手。阅读用户给的笔记，输出**严格的 JSON**（不要代码块包裹、不要任何解释），字段：' +
        'title（不超过 20 字的中文标题）、summary（不超过 60 字的一句话摘要）、tags（3～6 个中文短标签，不要带 #）。' +
        '只输出这一行 JSON：{"title":"…","summary":"…","tags":["…"]}',
    };

    const card = new ResultCard(this.app, this, {
      loading: true,
      providerLabel: this._activeName(),
      actionName: '生成',
      rect: ResultCard.selectionRect(),
    }).open();

    let res;
    try {
      res = await chat(this, action, note.slice(0, 12000), (this.settings.actionProviders || {})[action.id] || '');
    } catch (e) {
      card.showError(String(e && e.message ? e.message : e));
      return;
    }

    const data = parseJsonLoose(res.text);

    if (!data || (!data.title && !data.summary && !(data.tags || []).length)) {
      /* 模型没按格式给 → 把原文摆出来让他自己复制，不要瞎写文件头 */
      card.setProviderLabel(res.provider.name + ' / ' + res.provider.model);
      card.showResult(String(res.text));
      new Notice('Hadesr AI：AI 没返回规范 JSON，已把原文给你，请自行处理', 8000);
      return;
    }

    const merged = mergeFrontmatter(note, data, this.settings.fmZh !== false);
    if (merged === note) {
      card.opts.mode = 'info';
      card.showResult('（这三个属性都已经有了，没有改动）');
      return;
    }

    const keepCursor = editor.getCursor();
    editor.setValue(merged);
    try { editor.setCursor(keepCursor); } catch (e) { dlog('L3897', e); }

    card.setProviderLabel(res.provider.name + ' / ' + res.provider.model);
    card.opts.mode = 'info';          /* 已经写进文件了，不需要你再"替换/插入" */
    card.showResult('✅ 笔记属性已写入。\n\n```yaml\n' + merged.slice(0, 400) + (merged.length > 400 ? '\n…' : '') + '\n```');
    new Notice('Hadesr AI：笔记属性已更新');
  }

  /* 把 Canvas 落盘；embed=true 时顺带把 ![[xxx.canvas]] 插到光标下方 */
  async _writeCanvas(editor, base, norm, card, embed) {
    let path = base + '.canvas';
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path) && n < 50) {
      path = base + '-' + n + '.canvas';
      n++;
    }

    try {
      await this.app.vault.create(path, JSON.stringify(norm, null, 2));
    } catch (e) {
      card.showError('写文件失败：' + String((e && e.message) || e));
      return;
    }

    if (embed) {
      try {
        const cur = editor.getCursor('to');
        editor.replaceRange('\n\n![[' + path + ']]\n', { line: cur.line + 1, ch: 0 });
      } catch (e) { dlog('L3925', e); }
    }

    card.opts.fileActions = null;
    card.showResult('已生成 `' + path + '`\n\n'
      + '**' + norm.nodes.length + '** 个节点、' + norm.edges.length + ' 条连线。\n\n'
      + (embed ? '已经把它嵌入到光标下方了。' : '在左边文件列表里点开它就能看到。'));
    card._renderButtons();
    new Notice('Hadesr AI：已生成 ' + path, 6000);
  }

  /* 把当前笔记转成一张 .canvas 文件（放在同目录、同名） */
  async genCanvas(editor) {
    const note = editor.getValue();
    if (!note || !note.trim()) { new Notice('Hadesr AI：这篇笔记是空的'); return; }

    const action = {
      id: 'to-canvas',
      name: '转 Canvas',
      instruction: [
        '你是 Obsidian Canvas 生成器。把下面这篇笔记整理成一张可以直接打开的 .canvas（JSON Canvas 1.0）文件。',
        '',
        '硬性要求：',
        '- 只输出**一个 JSON 对象**：不要解释、不要 markdown 代码块围栏、不要输出到一半就断。',
        '- 顶层只有 nodes 和 edges 两个数组。',
        '- 每个 node 必须有 id / type / x / y / width / height。',
        '- 每条 edge 用 fromNode / toNode 指向**已经存在**的节点 id，需要说明关系时加 label。',
        '- type 只能是 text / file / link / group；除非原文明显指向某个具体笔记，否则一律用 text。',
        '- 文字节点写 Markdown 友好的短句（标题用 #，要点用 -），换行写成 \\n。',
        '',
        '结构要求（这条最重要）：',
        '- **必须有一个明确的中心节点**（整篇笔记的主题），其余都是它连出去的支撑节点，不要散成一堆碎片。',
        '- 明显有成组关系时，用一个 group 节点把那一组框起来（最多一个 group，别滥用）。',
        '- 源文不长也要做出结构：至少 5 个节点、至少 4 条连线。',
        '- x / y 按"从左到右分层"给个大概就行，程序会统一重排，你只要保证**连线关系正确**。',
      ].join('\n'),
    };

    const card = new ResultCard(this.app, this, {
      loading: true,
      providerLabel: this._activeName(),
      actionName: '转 Canvas',
      rect: ResultCard.selectionRect(),
    }).open();

    let res;
    try {
      res = await chat(this, action, note.slice(0, 12000), (this.settings.actionProviders || {})[action.id] || '');
    } catch (e) {
      card.showError(String((e && e.message) || e));
      return;
    }

    const data = parseJsonLoose(res.text);

    if (!data || !Array.isArray(data.nodes) || !data.nodes.length) {
      card.setProviderLabel((res.provider.name || '') + ' / ' + (res.provider.model || ''));
      card.showResult(String(res.text));
      new Notice('Hadesr AI：AI 没返回规范的 JSON Canvas，已把原文给你，可手动处理', 8000);
      return;
    }

    const file = this.app.workspace.getActiveFile();
    const noteTitle = file ? file.basename : '';

    /* 清洗 → 重新排布（模型给的坐标一律不信任） */
    let norm = null;
    try {
      norm = layoutCanvas(normalizeCanvas(data), noteTitle);
    } catch (e) { norm = null; }

    if (!norm || !norm.nodes.length) {
      card.setProviderLabel((res.provider.name || '') + ' / ' + (res.provider.model || ''));
      card.showResult(String(res.text));
      new Notice('Hadesr AI：这个 JSON Canvas 清洗后没有可用节点，已把原文给你', 8000);
      return;
    }

    const base = file ? file.path.replace(/\.md$/i, '') : '未命名';
    const self = this;

    card.setProviderLabel((res.provider.name || '') + ' / ' + (res.provider.model || ''));
    card.showResult('这张 Canvas 有 **' + norm.nodes.length + '** 个节点、'
      + norm.edges.length + ' 条连线。\n\n'
      + '选「创建」只生成文件；选「创建并嵌入」会同时把 `![[]]` 插到光标下方。');

    /* 两个落盘方式，等你选 —— 跟同类插件一致 */
    card.opts.fileActions = [
      { label: '创建', fn: function (c) { self._writeCanvas(editor, base, norm, c, false); } },
      { label: '创建并嵌入', fn: function (c) { self._writeCanvas(editor, base, norm, c, true); } },
    ];
    card._renderButtons();
  }

  _dispatch(action, text, editor, hasSelection) {
    const s = this.settings;

    /* 记住这次用的动作（只存内存，不落盘 —— 重启后胶囊回到只显示「AI」） */
    this._lastActionId = action.id;
    const forced = (s.actionProviders || {})[action.id] || '';   /* 动作级指定接口 */
    const isAuto = s.mode === MODE_AUTO;
    const cur = isAuto ? null : (s.providers || []).filter((x) => x.id === s.activeProvider)[0];

    let head0;
    if (forced) {
      const fp = (s.providers || []).filter((x) => x.id === forced)[0];
      head0 = fp ? (fp.name || '未命名') + ' / ' + (fp.model || '（未填模型）') + '　（本动作指定）' : '（指定的接口已删除）';
    } else if (isAuto) {
      head0 = '自动(依次尝试)';
    } else {
      head0 = cur ? (cur.name || '未命名') + ' / ' + (cur.model || '（未填模型）') : '（未选接口）';
    }

    /* 结果用浮动卡片贴在选区下方 —— 不弹全屏 Modal */
    if (this._lastCard) { try { this._lastCard.close(); } catch (e) { dlog('L4039', e); } }
    const card = new ResultCard(this.app, this, {
      loading: true,
      providerLabel: head0,
      actionName: action.doing || action.name,   /* → 标题显示「AI 正在翻译成中文」这类 */
      before: hasSelection ? text : '',          /* → 结果卡片的「对比」按钮靠它 */
      rect: ResultCard.selectionRect(),
    }).open();
    this._lastCard = card;

    return chat(this, action, text, forced, function (snap) { card.streamUpdate(snap); })
      .then((res) => {
        card.setProviderLabel((res.provider.name || '未命名') + ' / ' + (res.provider.model || '')
          + (isAuto && res.tried > 1 ? '（前 ' + (res.tried - 1) + ' 个没通）' : ''));
        card.showResult(res.text, res.reasoning);
      })
      .catch((e) => card.showError(String(e && e.message ? e.message : e)));
  }

  async loadSettings() {
    const saved = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    /* 老版本（3 套固定槽）→ 迁成 providers 列表。
       ⚠ 必须看 saved，不能看合并后的 this.settings —— 因为 DEFAULT_SETTINGS 里已经有
       providers 数组（预置 3 个），Object.assign 之后它一定存在，迁移分支就永远进不来。 */
    if (!Array.isArray(saved.providers)) {
      const old = saved.slots || {};
      this.settings.providers = SEED_PROVIDERS.map(function (f) {
        const o = old[f.id] || {};
        return {
          id: f.id, name: f.name, format: 'openai',
          baseUrl: o.baseUrl || f.baseUrl || '',
          apiKey: o.apiKey || '',
          model: o.model || f.model || '',
        };
      });
      if (saved.active) this.settings.activeProvider = saved.active;
      this.settings.mode = 'manual';
    }

    if (!this.settings.providers.length) {
      this.settings.providers = SEED_PROVIDERS.map(function (f) {
        return { id: f.id, name: f.name, format: f.format, baseUrl: f.baseUrl, apiKey: '', model: f.model };
      });
    }

    delete this.settings.slots;
    delete this.settings.active;

    if (this.settings.mode !== MODE_AUTO) this.settings.mode = 'manual';
    if (!this.settings.activeProvider ||
      !this.settings.providers.some((p) => p.id === this.settings.activeProvider)) {
      this.settings.activeProvider = this.settings.providers[0].id;
    }

    /* 悬浮条上显示的动作只在内存里 —— 关掉软件就忘，下次打开只显示「AI」
       （所以故意不写进 settings，也不 saveSettings） */
    if (typeof this._lastActionId !== 'string') this._lastActionId = '';
    this._marks = this._marks || [];          /* 待处理片段：{path,start,end,text} */
    if (['below', 'above'].indexOf(this.settings.bubblePosition) < 0) {
      this.settings.bubblePosition = 'below';
    }
    if (!Array.isArray(this.settings.customActions)) this.settings.customActions = [];
    if (!Array.isArray(this.settings.promptTemplates)) {
      this.settings.promptTemplates = DEFAULT_TEMPLATES.map(function (t) {
        return { id: t.id, name: t.name, text: t.text };
      });
    }
    if (!Array.isArray(this.settings.promptHistory)) this.settings.promptHistory = [];
    if (typeof this.settings.fmZh !== 'boolean') this.settings.fmZh = false;
    if (typeof this.settings.stream !== 'boolean') this.settings.stream = true;
    if (!this.settings.actionProviders || typeof this.settings.actionProviders !== 'object') {
      this.settings.actionProviders = {};
    }

    /* 行内补全：老配置里没有这些字段 → 用默认值补齐；坏值也要拉回合法区间 */
    if (typeof this.settings.complete !== 'boolean') this.settings.complete = false;
    if (typeof this.settings.completeCode !== 'boolean') this.settings.completeCode = false;
    const cd = Number(this.settings.completeDelay);
    this.settings.completeDelay = (isFinite(cd) && cd >= 200 && cd <= 3000) ? Math.round(cd) : 400;
    const cmx = Number(this.settings.completeMax);
    this.settings.completeMax = (isFinite(cmx) && cmx >= 40 && cmx <= 240) ? Math.round(cmx) : 120;
    if (typeof this.settings.completeProvider !== 'string') this.settings.completeProvider = '';
    if (['auto', 'manual'].indexOf(this.settings.completeTrigger) < 0) this.settings.completeTrigger = 'auto';
    if (typeof this.settings.completeHintShown !== 'boolean') this.settings.completeHintShown = false;
    if (typeof this.settings.completeNoteContext !== 'boolean') this.settings.completeNoteContext = false;
    if (typeof this.settings.completeChain !== 'boolean') this.settings.completeChain = true;
    if (typeof this.settings.completeCodeOneLine !== 'boolean') this.settings.completeCodeOneLine = true;
    if (!this.settings.actionPrompts || typeof this.settings.actionPrompts !== 'object') {
      this.settings.actionPrompts = {};
    }
    if (!Array.isArray(this.settings.chatHistory)) this.settings.chatHistory = [];
    if (typeof this.settings.rememberChat !== 'boolean') this.settings.rememberChat = true;
    if (typeof this.settings.selectionBubble !== 'boolean') this.settings.selectionBubble = true;
    if (typeof this.settings.debug !== 'boolean') this.settings.debug = false;
    setDebug(this.settings.debug);     /* 同步到模块级开关 */
    /* 旧版本曾把标记存进配置，现已改回内存 —— 清掉残留字段 */
    if (this.settings.marks !== undefined) delete this.settings.marks;
    /* 更早版本把胶囊动作列表存进配置，现在只在内存里 —— 清掉残留字段 */
    if (this.settings.bubbleActions !== undefined) delete this.settings.bubbleActions;
    if (this.settings.completeProvider &&
      !this.settings.providers.some((p) => p.id === this.settings.completeProvider)) {
      this.settings.completeProvider = '';
    }
  }

  /* 防抖 300ms：输入框每敲一下都会调它，没必要每次都整份写盘 */
  saveSettings() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    return new Promise((resolve) => {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        Promise.resolve(this.saveData(this.settings)).then(resolve, function (e) {
          dlog('saveSettings', e);       /* 写盘失败以前是静默的，开调试才看得到 */
          resolve();
        });
      }, 300);
    });
  }

  /* 立即落盘（卸载前用） */
  async flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try { await this.saveData(this.settings); } catch (e) { dlog('L4158', e); }
  }
};

/* 让用户挑动作（整篇处理时用）。返回 action 或 null。 */
function pickAction(app, actions) {
  const list = actions || ACTIONS;
  return new Promise((resolve) => {
    const m = new Modal(app);
    let picked = null;
    m.onOpen = function () {
      this.contentEl.createEl('h3', { text: '对整篇笔记执行哪个动作？' });
      const wrap = this.contentEl.createDiv({ cls: 'obai-pickaction' });
      list.forEach((a) => {
        const b = wrap.createEl('button', { text: a.name, cls: 'obai-btn' });
        b.onclick = () => { picked = a; m.close(); };
      });
    };
    m.onClose = function () { this.contentEl.empty(); resolve(picked); };
    m.open();
  });
}

/* 行内补全：光标处灰字续写，Tab 采纳、Esc 忽略。
   触发条件：文档变长 + 行尾 + 停顿；失败静默，原因写入设置页诊断。 */
const COMPLETE_SYSTEM = 'You are an inline writing assistant inside Obsidian. '
  + 'Continue the text exactly at the cursor using only the local context around the cursor. '
  + 'Return only the continuation text, with no explanations, no markdown fences, and no quotes. '
  + 'Produce one complete semantic unit that fits the local structure, such as one full sentence, '
  + 'one complete bullet item, one heading continuation, or one short paragraph. '
  + 'Never stop mid-word, mid-sentence, or mid-list-item. '
  + 'If the cursor is inside a fenced code block, return exactly ONE command line — '
  + 'never append the next command, and never explain it.';

/* 光标前的内容末尾是不是还在一个没闭合的代码围栏里 */
function inFenceText(text) {
  let open = false, ch = '';
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (!m) continue;
    const c = m[1][0];
    if (!open) { open = true; ch = c; }
    else if (c === ch) { open = false; ch = ''; }
  }
  return open;
}

/* 光标是不是还在开头的 YAML 属性块里（那里补出正文会把文件写坏） */
function inFrontmatterText(text, pos) {
  if (!text || pos < 4) return false;
  const head = text.slice(0, pos);
  if (!/^---\r?\n/.test(head)) return false;
  return head.indexOf('\n---') < 0;
}

/* 模型挺爱把光标前的最后几个字再抄一遍 —— 专门咬掉这段重叠 */
function trimOverlap(before, ghost) {
  if (!before || !ghost) return ghost || '';
  const max = Math.min(ghost.length, before.length, 80);
  for (let k = max; k >= 4; k--) {
    if (before.slice(-k) === ghost.slice(0, k)) {
      return ghost.slice(k).replace(/^[ \t]+/, ' ');
    }
  }
  return ghost;
}

/* 把模型吐出来的东西收拾成"能直接贴在光标后"的一段 */
function cleanCompletion(before, raw, maxChars, quick) {
  let t = String(raw == null ? '' : raw);
  if (!t) return '';

  /* 整段被 ``` 包起来 → 取里面那段 */
  const fenced = t.match(/^\s*```[A-Za-z0-9+#.-]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) t = fenced[1];
  /* 只吐了个围栏开头 / 结尾的（模型常干这事），扔掉 */
  t = t.replace(/^\s*```[A-Za-z0-9+#.-]*\n?/, '');
  t = t.replace(/\n?```\s*$/, '');

  /* "补全：/ 续写：/ Completion:" 这类前缀 */
  t = t.replace(/^(?:补全|续写|接续|接下去|Completion|Completed|Result)\s*[:：]\s*/i, '');

  t = t.replace(/\r/g, '');
  /* 上文没换行，就别让补全以一个空行开头 */
  if (!/\n$/.test(before || '')) t = t.replace(/^[ \t]*\n+/, '');
  t = trimOverlap(before || '', t);
  if (!quick) {
    t = t.replace(/[ \t]+$/gm, '');     /* 每行行尾空白 */
    t = t.replace(/\n{3,}/g, '\n\n');   /* 最多留一个空行 */
  }

  const cap = Math.max(20, Number(maxChars) || 60);
  if (t.length > cap) {
    if (quick) return t.slice(0, cap);   /* 流式期间不折腾截断，结尾会再洗一遍 */
    /* 尽量切在句子 / 换行边界上，切不动就硬切 */
    const cut = t.slice(0, cap);
    const m = cut.match(/^[\s\S]*[。！？；.!?;\n]/);
    t = (m ? m[0] : cut).replace(/[ \t]+$/, '');
  }
  return t.trim() ? t : '';
}

/* 从光标往上/往下找最近的"非空段落"，最多 6 行（帮模型判断"这段在讲什么"） */
function nearestBlockText(lines, from, dir) {
  const out = [];
  let i = from;
  while (i >= 0 && i < lines.length) {
    const t = String(lines[i] || '').trim();
    if (t) out.push(t);
    else if (out.length) break;
    if (out.length >= 6) break;
    i += dir;
  }
  if (dir < 0) out.reverse();
  return out.join('\n').slice(0, 300);
}

/* 上下文：光给"光标前 4000 字"是不够的 —— 列表要接着写列表、标题下面要顺着主题写。
   所以额外算四个结构信息：标题路径、行首前缀（- / 1. / > ）、上一段、下一段。 */
function buildCompletionContext(lines, idx, col) {
  const cur = String(lines[idx] || '');
  const curBefore = cur.slice(0, col);
  const curAfter = cur.slice(col);

  /* 标题路径：从当前行往上找 # 标题，只保留层级递增的（h1 > h2 > h3 就是一条路径） */
  const path = [];
  for (let i = idx; i >= 0 && path.length < 8; i--) {
    const m = String(lines[i] || '').match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const lvl = m[1].length;
    if (!path.length || lvl < path[path.length - 1].lvl) path.push({ lvl: lvl, text: m[2] });
    if (lvl === 1) break;
  }
  path.reverse();

  /* 行首前缀：缩进 + 引用 + 列表标记，决定"下一项该怎么接" */
  const pm = curBefore.match(/^(\s*(?:>\s*)*(?:[-*+] |\d+\. |\[[ xX]\] )*)/);

  return {
    lineNo: idx + 1,
    /* 上下文别贪多：首字延迟主要是 prompt 长度决定的。
       1200 字 ≈ 30 行，足够让模型接上语气与格式，再长只是变慢。 */
    prefix: lines.slice(Math.max(0, idx - 60), idx).join('\n').slice(-1200),
    suffix: lines.slice(idx + 1, idx + 20).join('\n'),
    curBefore: curBefore,
    curAfter: curAfter,
    headingPath: path.map(function (x) { return x.text; }).join(' > ') || '(root)',
    prefixPattern: pm ? pm[1] : '',
    prevBlock: nearestBlockText(lines, idx - 1, -1),
    nextBlock: nearestBlockText(lines, idx + 1, 1),
  };
}

/* 代码块里只要一行命令。
   模型（尤其是网络设备配置这种）经常把"下一条命令"也补出来：
   要 `interface Vlan-interface 62`，它给你两条。补全的语义是"把这一行写完"，
   所以硬截到第一行。例外：这一行明显没写完（以 \ | , && ( 结尾）才保留续行。 */
function clipCodeFirstLine(text) {
  const t = String(text || '').replace(/^[ \t]*\n+/, '');
  if (!t) return '';
  const lines = t.split('\n');
  if (lines.length <= 1) return t;
  const first = lines[0];
  if (/[\\|,]\s*$|&&\s*$|\|\|\s*$|\(\s*$/.test(first)) {
    return first + '\n' + lines[1];
  }
  return first;
}

/* 光标处的结构元信息：行号、标题路径、行首前缀、前后段落 */
function buildCompleteMeta(ctx) {
  return [
    'cursor_line: ' + ctx.lineNo,
    'heading_path: ' + ctx.headingPath,
    'line_prefix_pattern: ' + JSON.stringify(ctx.prefixPattern),
    'current_line_before_cursor: ' + ctx.curBefore,
    'current_line_after_cursor: ' + ctx.curAfter,
    ctx.prevBlock ? 'previous_block:\n' + ctx.prevBlock : '',
    ctx.nextBlock ? 'next_block:\n' + ctx.nextBlock : '',
  ].filter(Boolean).join('\n');
}

/* 组装发给模型的对话；draft 非空表示上一轮被截断，需要接着草稿写 */
function buildCompleteMessages(prefix, suffix, meta, draft, docBlock, inCode) {
  const hint = draft
    ? '\n\nA draft continuation has already been generated. Continue exactly from where that draft ends. '
      + 'Do not repeat or paraphrase any previously generated text.'
    : '';
  return [
    { role: 'system', content: COMPLETE_SYSTEM },
    {
      role: 'user',
      content: 'Continue the text at <CURSOR>. Use the local cursor context below, not the whole document.' + hint
        + '\n\nText before cursor:\n' + prefix + (draft || '')
        + '\n\n<CURSOR>\n\nText after cursor:\n' + suffix
        + (meta ? '\n\nLocal cursor metadata:\n' + meta : '')
        + (docBlock ? '\n\nWhole-document background (keep terminology and tone consistent with it):\n' + docBlock : '')
        + (inCode ? '\n\nThis position is inside a fenced code block: return exactly ONE command line. Do not add the next command.' : ''),
    },
  ];
}

/* 每轮请求的 token 预算。
   推理模型会把额度烧在思考上，给太少会拿到空正文；续写轮不需要那么宽。 */
const COMPLETE_TOKEN_CAP = 240;   /* 单轮预算上限 */

function completionBudget(prefix, suffix, draft, attempt) {
  if (attempt > 0) return 140;   /* 续写轮不用那么多，够接上就行 */
  const p = String(prefix || '').trimEnd();
  const lastLine = p.split('\n').pop() || '';
  if (/^\s*#{1,6}\s*$/.test(lastLine)) return 100;   /* 只打了个标题标记，给多了浪费 */
  if (/^\s*(?:[-*+] |\d+\. |> )?$/.test(lastLine)) return 160;
  return COMPLETE_TOKEN_CAP;      /* 其它情况一律 200 */
}

/* 续写时模型会把已生成内容再抄一遍 —— 咬掉重叠，上限 120 */
function removeRepeatedPrefix(prev, next) {
  const o = String(next || '');
  if (!prev) return o;
  if (!o.trim()) return '';
  for (let t = Math.min(prev.length, o.length, 120); t > 0; t--) {
    if (prev.slice(-t) === o.slice(0, t)) return o.slice(t);
  }
  return o;
}

/* 判断这一句是否已经说完 */
function looksSemanticallyComplete(text) {
  const t = String(text || '').trimEnd();
  if (!t) return false;
  if (/[。！？.!?…'"）】》]$/.test(t)) return true;
  const last = t.split('\n').pop() || '';
  return /^\s*(?:[-*+] |\d+\. |> )/.test(last) && last.trim().length >= 8;
}

/* 截到最后一个句读：宁可短一句，也不要把半句塞给用户 */
function trimCompletionToBoundary(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  const cuts = Array.from(t.matchAll(/[。！？.!?；;：:\n]/g));
  if (cuts.length > 0) {
    const lastCut = cuts[cuts.length - 1];
    const end = (lastCut.index >= 0 ? lastCut.index : -1) + lastCut[0].length;
    if (end >= Math.max(12, Math.floor(0.45 * t.length))) return t.slice(0, end).trimEnd();
  }
  const sp = t.lastIndexOf(' ');
  return sp >= Math.max(12, Math.floor(0.6 * t.length)) ? t.slice(0, sp).trimEnd() : t;
}

/* 本地打字机：一次请求拿全文，再按块吐给 UI。
   不依赖网络流，既不会卡，也不受 CORS 影响。 */
function waitMs(ms, signal) {
  return new Promise(function (resolve, reject) {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', function () {
        clearTimeout(t);
        reject(new Error('aborted'));
      }, { once: true });
    }
  });
}

async function typewriter(text, signal, onChunk) {
  let parts = String(text || '').split(/(\s+)/).filter(function (x) { return x.length > 0; });
  /* 中文没有空格，整句会一次蹦出来 —— 平均每块太长就按 2 字切，保留逐字手感。
     （用"平均块长"判断，而不是"块数<=2"：一句话里只要有个空格就会是 3 块，
      按块数判断会漏掉这种情况，中文还是一下子全出来。） */
  const avgLen = String(text || '').length / Math.max(1, parts.length);
  if (avgLen > 6 && String(text).length > 10) {
    parts = [];
    for (let i = 0; i < text.length; i += 2) parts.push(text.slice(i, i + 2));
  }
  /* 总时长控制在 ~380ms 以内：
     短句该有逐字感（18ms/块），长句不能拖成 1 秒多（按块数反算步长，最低 4ms）。 */
  const step = parts.length > 1
    ? Math.max(4, Math.min(18, Math.round(380 / parts.length)))
    : 0;

  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    if (signal && signal.aborted) throw new Error('aborted');
    acc += parts[i];
    onChunk(acc);
    if (i < parts.length - 1 && step > 0) await waitMs(step, signal);
  }
  return acc;
}

/* 补全的非流式兜底：requestUrl 发 stream:true，本地拼回正文。 */
async function requestCompletionSSE(cfg, messages, maxTokens) {
  const fmt = cfg.format || 'openai';
  const req = buildRequestMessages(fmt, cfg, messages, 0.2, maxTokens);
  const body = JSON.parse(req.body);
  body.stream = true;

  const res = await requestUrl({
    url: req.url, method: 'POST', headers: req.headers,
    body: JSON.stringify(body), throw: false,
  });
  if (res.status < 200 || res.status >= 300) {
    const detail = String(res.text || '').replace(/\s+/g, ' ').slice(0, 200);
    throw new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
  }

  const raw = String(res.text || '');

  /* 服务端无视 stream、直接回整段 JSON */
  if (raw.trim().charAt(0) === '{') {
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { dlog('L4470', e); }
    if (!j) throw new Error('返回既不是 SSE 也不是 JSON');
    return {
      text: parseReply(fmt, j),
      reasoning: parseReasoning(fmt, j),
      finishReason: finishReasonOf(fmt, j),
    };
  }

  let text = '', reasoning = '', finish = '';
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.indexOf('data:') !== 0) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let j = null;
    try { j = JSON.parse(data); } catch (e) { continue; }

    const d = extractDelta(fmt, j);
    if (d.text) text += d.text;
    if (d.reasoning) reasoning += d.reasoning;

    /* 最后一个分片带 finish_reason —— 续写循环要靠它 */
    let fr = '';
    if (fmt === 'anthropic') fr = j.delta && j.delta.stop_reason;
    else fr = j.choices && j.choices[0] && j.choices[0].finish_reason;
    if (fr) finish = String(fr).toLowerCase() === 'max_tokens' ? 'length' : String(fr).toLowerCase();
  }
  return { text: text, reasoning: reasoning, finishReason: finish };
}

/* 整篇笔记画像：标题大纲 + 双链 + 术语 + 正文节选（按 mtime 缓存）。
   不放全文，避免 prompt 过长拖慢首字。 */
function buildNoteProfile(raw) {
  const lines = String(raw || '').split('\n');
  const heads = [], links = [], terms = [];

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const h = ln.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) heads.push(h[1] + ' ' + h[2]);

    const lm = ln.match(/\[\[([^\]|#]+)/g);
    if (lm) lm.forEach(function (x) { links.push(x.slice(2).trim()); });

    const cm = ln.match(/`([^`]{2,24})`/g);
    if (cm) cm.forEach(function (x) { terms.push(x.slice(1, -1)); });
  }

  const uniq = function (arr) { return Array.from(new Set(arr.filter(Boolean))).slice(0, 24); };
  const body = lines
    .filter(function (l) { return !/^#{1,6}\s/.test(l) && !/^---\s*$/.test(l); })
    .join('\n').replace(/\n{2,}/g, '\n').trim();

  const parts = [];
  if (heads.length) parts.push('Document outline:\n' + heads.slice(0, 20).join('\n'));
  const lk = uniq(links);
  if (lk.length) parts.push('Notes linked from this document: ' + lk.join(', '));
  const tm = uniq(terms);
  if (tm.length) parts.push('Terms used in this document: ' + tm.join(', '));
  if (body) parts.push('Document excerpt (for tone and terminology only, do NOT continue it):\n' + body.slice(0, 900));
  return parts.join('\n\n');
}

/* 读当前笔记做画像（按 mtime 缓存，别每次补全都读一遍文件） */
async function noteProfileFor(plugin) {
  const app = plugin.app;
  if (!app || !app.workspace || !app.vault) return '';
  const file = app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
  if (!file) return '';
  const stat = file.stat || {};
  const key = file.path + '|' + (stat.mtime || 0) + '|' + (stat.size || 0);
  const cache = plugin._noteCache;
  if (cache && cache.key === key) return cache.text;

  let raw = '';
  try { raw = await app.vault.read(file); } catch (e) { return ''; }
  const text = buildNoteProfile(raw);
  plugin._noteCache = { key: key, text: text };
  return text;
}

/* 补全用哪个接口：单独指定优先（建议指到本地小模型），否则跟随顶部设置 */
function completeProviders(plugin) {
  const s = plugin.settings;
  if (s.completeProvider) {
    const one = (s.providers || []).filter(function (p) { return p.id === s.completeProvider; })[0];
    if (one && trimBase(one.baseUrl) && one.model) return [one];
  }
  return candidateProviders(s);
}

/* 非流式兜底：一个都不流（或者流被 CORS 挡了）时走这里，requestUrl 绕 CORS */
/* 关闭思考的三种写法，依次尝试（部分服务不认某些字段）。 */
const NO_THINK_MODES = [
  { reasoning_effort: 'none' },
  { thinking: { type: 'disabled' } },
  {},
];

/* 一次请求：拿不到正文就换下一种"关思考"写法再试 */
async function callCompletionOnce(cfg, msgs, budget) {
  let last = null;
  for (let i = 0; i < NO_THINK_MODES.length; i++) {
    let r = null;
    try {
      r = await sendMessages(cfg, msgs, 0.2, budget, NO_THINK_MODES[i]);
    } catch (e) {
      last = e;                       /* 400（不认这个字段）→ 换下一种 */
      continue;
    }
    if (r.text && String(r.text).trim()) return r;
    if (r.finishReason !== 'length') return r;   /* 模型主动不说话，尊重它 */
    last = r;                         /* 空 + length = 又被思考吃光了，换写法 */
  }
  /* 三种都空 → 最后赌一把流式（有些服务只有流式才回正文） */
  if (cfg.format !== 'google') {
    try {
      const got = await requestCompletionSSE(cfg, msgs, budget);
      if (got && got.text && String(got.text).trim()) return got;
    } catch (e) { dlog('L4591', e); }
  }
  if (last && last.text !== undefined) return last;
  throw (last instanceof Error ? last : new Error('模型没给出正文（返回空）'));
}

/* 一次补全最多 3 轮请求。
   关键设计：**finish_reason 是 length 就接着往下写**，把已生成内容当草稿带上，
   直到「不像被截断」或者「这一句已经说完了」。
   这也是为什么它敢用 160 tokens 的预算还能给出完整句子。 */
async function completeWithRetry(plugin, prefix, suffix, meta, signal, docBlock, inCode) {
  const list = completeProviders(plugin);
  if (!list.length) throw new Error('没有可用接口（设置 → 模型接口）');
  let lastErr = null;

  for (let p = 0; p < list.length; p++) {
    const cfg = list[p];
    let acc = '';
    let attempts = 0;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal && signal.aborted) throw new Error('aborted');
        attempts = attempt + 1;
        const budget = completionBudget(prefix, suffix, acc, attempt);
        const msgs = buildCompleteMessages(prefix, suffix, meta, acc, docBlock, inCode);
        const r = await callCompletionOnce(cfg, msgs, budget);

        const add = removeRepeatedPrefix(acc, r.text);
        if (!add) break;                       /* 模型没话了 */
        acc += add;
        if (r.finishReason !== 'length') return { text: acc.trimEnd(), cfg: cfg, attempts: attempts };
        if (looksSemanticallyComplete(acc)) {
          return { text: trimCompletionToBoundary(acc), cfg: cfg, attempts: attempts };
        }
      }
      const fin = trimCompletionToBoundary(acc) || acc.trimEnd();
      if (fin) return { text: fin, cfg: cfg, attempts: attempts };
      lastErr = new Error('模型没给出正文（返回空）');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('没有可用接口');
}

/* CodeMirror 的模块是 Obsidian 内置的、但没写在公开 API 里。
   探针已验证可用；万一哪天拿不到，就静默不装 —— 插件其余功能照常。 */
const CM = (function () {
  try {
    const view = require('@codemirror/view');
    const state = require('@codemirror/state');
    if (!view || !state) return null;
    if (!view.Decoration || !view.WidgetType || !view.EditorView) return null;
    if (!view.ViewPlugin || !view.keymap) return null;
    if (!state.StateField || !state.StateEffect || !state.Prec) return null;
    return { view: view, state: state };
  } catch (e) {
    return null;
  }
})();

/* 安装后这里会填上 API，设置页关掉补全时要用它把已显示的灰字擦掉 */
let obaiGhostAPI = null;

/* 最近一次采纳补全的时间 —— 用来跳过"这次文档变化是我们自己写进去的" */
let lastAcceptAt = 0;

/* 按 Esc 之后静默一段时间：不然它会立刻又弹一个，很烦 */
let muteUntil = 0;

/* 即时药丸的节流时间戳：快速连打时没必要每个键都插一次 widget */
let lastPillAt = 0;

/* 补全的每次尝试都记一笔：成功/失败 + 原因。
   自动触发时不打扰用户（只进 console 与设置页诊断）；
   手动触发（命令「现在补一次」）时失败会弹 Notice，方便一眼看出卡在哪一环。 */
function noteComplete(plugin, ok, msg, manual, level) {
  /* 自动补全连挂 3 次 → 安静 60 秒，别一直打接口 */
  if (!manual) {
    if (ok) { plugin._cFail = 0; plugin._cBackoffUntil = 0; }
    else {
      plugin._cFail = (plugin._cFail || 0) + 1;
      if (plugin._cFail >= 3) {
        plugin._cFail = 0;
        plugin._cBackoffUntil = Date.now() + 60000;
      }
    }
  }
  const lv = ok ? 'ok' : (level || 'fail');
  plugin._lastComplete = { at: Date.now(), ok: !!ok, level: lv, msg: String(msg || '') };
  /* ❗ "跳过"（光标不在行尾 / 输入法组合中 / 又敲字导致中止…）是**正常情况**，
     不该 console.warn，否则用户开控制台会看到满屏红色，以为是报错。 */
  if (lv === 'ok') { if (DEBUG) console.debug('[obai] 补全：' + msg); return; }
  if (lv === 'skip') { if (DEBUG) console.debug('[obai] 补全跳过：' + msg); return; }
  console.warn('[obai] 补全未出灰字：' + msg);
  if (manual) new Notice('Hadesr AI 补全：' + msg, 6000);
}

/* 装配 CM 扩展。拿不到模块 → 返回 null */
function installCompleter(plugin) {
  if (!CM) return null;
  const { Decoration, WidgetType, EditorView, ViewPlugin, keymap } = CM.view;
  const { StateField, StateEffect, Prec } = CM.state;

  const setGhost = StateEffect.define();     /* {pos, text, status} | null */
  const clearGhost = StateEffect.define();

  /* 灰字本体。insertHint=true 时后面跟一句「按 Tab 采纳」（只在第一次出现时给） */
  class GhostWidget extends WidgetType {
    constructor(text, showHint) { super(); this.text = text; this.showHint = !!showHint; }
    eq(other) { return other.text === this.text && other.showHint === this.showHint; }
    toDOM() {
      const wrap = document.createElement('span');
      wrap.className = 'obai-ghost';
      wrap.setAttribute('aria-hidden', 'true');
      const body = document.createElement('span');
      body.textContent = this.text;
      wrap.appendChild(body);
      if (this.showHint) {
        const hint = document.createElement('span');
        hint.className = 'obai-ghost-hint';
        const key = document.createElement('span');
        key.className = 'obai-ghost-key';
        key.textContent = 'Tab';
        hint.appendChild(key);
        const txt = document.createElement('span');
        txt.textContent = '采纳';
        hint.appendChild(txt);
        wrap.appendChild(hint);
      }
      return wrap;
    }
    ignoreEvent() { return true; }
  }

  /* 等待中的小药丸 —— 请求要一两秒，有这个才知道"它在干活" */
  class LoadingGhost extends WidgetType {
    eq() { return true; }
    toDOM() {
      const wrap = document.createElement('span');
      wrap.className = 'obai-ghost obai-ghost-wait';
      wrap.setAttribute('aria-hidden', 'true');
      const dot = document.createElement('span');
      dot.className = 'obai-ghost-dot';
      wrap.appendChild(dot);
      const label = document.createElement('span');
      label.className = 'obai-ghost-label';
      label.textContent = 'AI 思考中';
      wrap.appendChild(label);
      return wrap;
    }
    ignoreEvent() { return true; }
  }

  /* 灰字状态字段（文本/位置/状态）。
     ⚠ 装饰用 provide + decorations.from，不要用
       EditorView.decorations.compute([field, EditorState.selection])，
       CM6 里没有 EditorState.selection 这个 facet，会导致插件加载失败。 */
  const ghostField = StateField.define({
    create: function () { return null; },
    update: function (val, tr) {
      for (let i = 0; i < tr.effects.length; i++) {
        const e = tr.effects[i];
        if (e.is(setGhost)) return e.value;
        if (e.is(clearGhost)) return null;
      }
      /* 打字 → 立刻消失；光标挪走 → 也消失（位置对不上就别显示了） */
      if (tr.docChanged) return null;
      if (tr.selection) {
        if (!val) return val;
        if (tr.state.selection.main.head !== val.pos) return null;
      }
      return val;
    },
    provide: function (f) {
      return EditorView.decorations.from(f, function (g) {
        if (!g) return Decoration.none;
        if (g.status === 'loading') {
          return Decoration.set([Decoration.widget({ widget: new LoadingGhost(), side: 1 }).range(g.pos)]);
        }
        if (!g.text) return Decoration.none;
        const hint = plugin.settings.completeHintShown !== true;
        return Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text, hint), side: 1 }).range(g.pos)]);
      });
    },
  });

  const completer = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.timer = 0;
      this.seq = 0;
      this.runId = 0;
      this.lastHead = view.state.selection.main.head;
      this.abortController = null;

      /* 中文输入法：组合结束即补。
         没有这一条时会出"只有打空格/标点才补"的怪现象 ——
         因为逐字 commit 的那一刻 composing 还是 true，run() 会跳过，
         要等下一次 composition 结束（多半是空格或标点）才有机会跑。 */
      this._onCompEnd = () => { this.schedule(); };
      view.dom.addEventListener('compositionend', this._onCompEnd);
    }

    /* 中止在飞的请求（切视图、重新触发、光标乱动时都要） */
    abort() {
      if (!this.abortController) return;
      try { this.abortController.abort(); } catch (e) { dlog('L4798', e); }
      this.abortController = null;
    }

    update(u) {
      if (!u.docChanged && !u.selectionSet) return;
      const headNow = u.state.selection.main.head;
      if (!u.docChanged) {
        /* Obsidian 打字后经常补发"位置其实没变"的 selection 事务，
           这时别 cancel/abort —— 否则一次正常的补全会被判成过期，药丸转完什么都不出。 */
        if (headNow === this.lastHead) return;
        this.lastHead = headNow;
        this.cancel();
        this.abort();
        return;
      }
      this.lastHead = headNow;
      this.abort();
      /* 刚采纳过一次补全 —— 那次改动是我们自己写进去的，别立刻又请求一遍 */
      if (Date.now() - lastAcceptAt < 250) { this.cancel(); return; }
      const s = plugin.settings;
      if (!s.complete) { this.cancel(); return; }
      if (s.completeTrigger === 'manual') { this.cancel(); return; }

      /* 只在"文档变长"时补（删字不该触发）；当前行光标前至少 2 个字 */
      if (u.state.doc.length < u.startState.doc.length) { this.cancel(); return; }
      const line = u.state.doc.lineAt(u.state.selection.main.head);
      if (line.text.trim().length < 2) { this.cancel(); return; }

      this.schedule();

      /* ⚡ 按键当下就把「AI 思考中」药丸挂上去，不等 500ms 的防抖。
         参考插件给人的"没打完就在识别了"就是靠这个。
         注意：不能在 update 里 dispatch（CM 会报 update in progress），推到下一个事件循环。 */
      const self = this;
      const mySeq = this.seq;
      setTimeout(function () {
        if (self.seq !== mySeq) return;                       /* 期间又敲字了，交给下一轮 */
        let head = 0, empty = true, st2 = null;
        try {
          st2 = self.view.state;
          const sel = st2.selection.main;
          head = sel.head; empty = sel.empty;
        } catch (e) { return; }
        if (!empty) return;

        /* 已经在药丸状态就别重复挂（省一次事务） */
        const cur = st2.field(ghostField, false);
        if (cur && cur.status === 'loading' && cur.pos === head) return;

        /* 120ms 内出过就不再插 —— 连打 10 个字只留一次事务，手感一样 */
        if (Date.now() - lastPillAt < 120) return;
        lastPillAt = Date.now();

        /* 只在"真的会补"的位置出药丸：代码块没开、属性块里都不出，免得空转误导 */
        const pre = st2.doc.sliceString(Math.max(0, head - 2000), head);
        if (inFenceText(pre) && !plugin.settings.completeCode) return;
        if (inFrontmatterText(pre, pre.length)) return;

        try {
          self.view.dispatch({ effects: setGhost.of({ pos: head, text: '', status: 'loading' }) });
        } catch (e) { dlog('L4859', e); }
      }, 0);
    }

    cancel() {
      if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
      this.seq++;
    }

    schedule() {
      const s = plugin.settings;
      this.cancel();
      if (!s.complete) return;
      /* 连续失败后的安静期，别一直打接口 */
      if (plugin._cBackoffUntil && Date.now() < plugin._cBackoffUntil) return;
      const self = this;
      const delay = Math.max(200, Number(s.completeDelay) || 400);
      this.timer = setTimeout(function () {
        self.timer = 0;
        /* run 自己已经兜住了，这里再挂一层纯属保险 */
        Promise.resolve(self.run(false)).catch(function () { });
      }, delay);
    }

    /* 每个"不出灰字"的出口都留一句原因 —— 设置页诊断面板显示最近一条，
       手动触发时还会弹 Notice。 */
    fail(msg, manual) { noteComplete(plugin, false, msg, manual, 'fail'); }
    skip(msg, manual) { noteComplete(plugin, false, msg, manual, 'skip'); }
    done(msg, manual) { noteComplete(plugin, true, msg, manual, 'ok'); }

    /* 外面永远只调 run —— 它保证不把异常抛出去。
       async 方法抛出的异常如果没人接，会变成 unhandled rejection，
       Obsidian 直接弹一个红框 —— 用户嘴里的"经常报错"多半就是它。 */
    async run(manual) {
      try {
        return await this._run(manual);
      } catch (e) {
        console.error('[obai] 补全内部错误：', e);
        noteComplete(plugin, false, '内部错误：' + String((e && e.message) || e), manual, 'fail');
        this.clear(this.view);
      }
    }

    async _run(manual) {
      const view = this.view;
      const s = plugin.settings;

      if (!s.complete) return this.skip('总开关是关的 —— 设置 → Hadesr AI → 行内补全', manual);
      if (view.composing && !manual) return this.skip('输入法正在组合中，先让你打完', manual);
      if (!manual && !view.hasFocus) return this.skip('编辑器没有焦点', manual);

      const st = view.state;
      const sel = st.selection.main;
      if (!sel.empty) return this.skip('当前有选中文字，先取消选区', manual);
      const pos = sel.head;
      const doc = st.doc;
      const line = doc.lineAt(pos);
      if (pos !== line.to) return this.skip('光标不在行尾（只在行尾补，行中补基本都错）', manual);

      const curBeforeLine = line.text;
      if (curBeforeLine.trim().length < 2) return this.skip('这一行还太短（不到 2 个字）', manual);

      /* 取光标前后若干行做上下文（结构信息都从这里算） */
      const from = Math.max(1, line.number - 60);
      const to = Math.min(doc.lines, line.number + 40);
      const lines = [];
      for (let n = from; n <= to; n++) lines.push(doc.line(n).text);
      const ctx = buildCompletionContext(lines, line.number - from, pos - line.from);

      const full = (ctx.prefix ? ctx.prefix + '\n' : '') + ctx.curBefore;
      if (inFrontmatterText(full, full.length)) return this.skip('光标在笔记属性（frontmatter）里', manual);
      const inCode = inFenceText(full);
      if (inCode && !s.completeCode) {
        return this.skip('光标在代码块里，而「代码块里也补全」没开', manual);
      }

      /* 补全长度上限：只作为最后一道"别太长"的保险，不是主控 */
      const maxChars = Math.max(40, Math.min(240, Number(s.completeMax) || 120));
      const prefix = (ctx.prefix ? ctx.prefix + '\n' : '') + ctx.curBefore;
      const suffix = ctx.curAfter + (ctx.suffix ? '\n' + ctx.suffix : '');
      const meta = buildCompleteMeta(ctx);

      /* 可选：把整篇笔记的大纲/术语/节选也喂进去（默认关，开了首字会慢一点） */
      let docBlock = '';
      if (s.completeNoteContext) {
        try { docBlock = await noteProfileFor(plugin); } catch (e) { docBlock = ''; }
      }

      this.cancel();
      const myRun = ++this.runId;
      this.abort();
      const ac = new AbortController();
      this.abortController = ac;
      const signal = ac.signal;

      /* ① 立刻放「AI 思考中」药丸 */
      try {
        view.dispatch({ effects: setGhost.of({ pos: pos, text: '', status: 'loading' }) });
      } catch (e) {
        return this.fail('没法写进编辑器：' + String((e && e.message) || e), manual);
      }

      const t0 = Date.now();
      const stale = () => {
        if (signal.aborted) return true;
        if (myRun !== this.runId) return true;
        try {
          const cur = view.state.selection.main;
          return cur.head !== pos || !cur.empty;
        } catch (e) { return true; }
      };

      /* ② 一次请求（内部最多续写 3 轮）—— requestUrl，绕 CORS，非网络流 */
      let fullText = '';
      let attempts = 1;
      try {
        const got = await completeWithRetry(plugin, prefix, suffix, meta, signal, docBlock, inCode);
        fullText = String(got.text || '');
        attempts = got.attempts || 1;
      } catch (e) {
        this.clear(view);
        if (signal.aborted || String((e && e.message) || '') === 'aborted') {
          return this.skip('已中止（又敲字或移了光标）', manual);
        }
        return this.fail('请求失败：' + String((e && e.message) || e), manual);
      }

      if (this.abortController === ac) this.abortController = null;
      if (stale()) { this.clear(view); return this.skip('期间又敲了字或移了光标，这次结果作废', manual); }
      if (!fullText) { this.clear(view); return this.skip('模型没给出建议（返回空）', manual); }

      /* 代码块里硬截到一行 —— 不能只指望模型听话 */
      if (inCode && s.completeCodeOneLine !== false) {
        fullText = clipCodeFirstLine(fullText);
      }

      /* ③ 本地打字机：一次请求拿全文，再一块块吐成灰字（不依赖网络流） */
      try {
        await typewriter(fullText, signal, function (partial) {
          if (stale()) return;
          const shown = cleanCompletion(prefix, partial, maxChars, true);
          if (!shown) return;
          try {
            view.dispatch({ effects: setGhost.of({ pos: pos, text: shown, status: 'ready' }) });
          } catch (e) { dlog('L5003', e); }
        });
      } catch (e) {
        if (stale()) { this.clear(view); return this.skip('已中止（又敲字或移了光标）', manual); }
      }

      if (stale()) { this.clear(view); return this.skip('期间又敲了字或移了光标，这次结果作废', manual); }

      const ghost = cleanCompletion(prefix, fullText, maxChars);
      if (!ghost) { this.clear(view); return this.skip('模型没给出建议（返回空）', manual); }

      try {
        view.dispatch({ effects: setGhost.of({ pos: pos, text: ghost, status: 'ready' }) });
      } catch (e) {
        return this.fail('没法写进编辑器：' + String((e && e.message) || e), manual);
      }

      /* 第一次成功 → 记下来，以后不再显示「按 Tab 采纳」 */
      if (s.completeHintShown !== true) {
        s.completeHintShown = true;
        try { plugin.saveSettings(); } catch (e) { dlog('L5023', e); }
      }
      this.done('已补 ' + ghost.length + ' 字，用时 ' + (Date.now() - t0) + 'ms'
        + (attempts > 1 ? '（续写了 ' + attempts + ' 轮）' : ''), manual);
    }

    clear(view) {
      try { view.dispatch({ effects: clearGhost.of(null) }); } catch (e) { dlog('L5030', e); }
    }

    destroy() {
      this.cancel();
      this.abort();
      try { this.view.dom.removeEventListener('compositionend', this._onCompEnd); } catch (e) { dlog('L5036', e); }
    }
  });

  /* Tab 采纳（只在有完整灰字时拦；loading 状态不拦）/ Esc 忽略 */
  const acceptKeys = Prec.highest(keymap.of([
    {
      key: 'Tab',
      run: function (view) {
        const g = view.state.field(ghostField, false);
        if (!g || !g.text || g.status !== 'ready') return false;
        const pos = view.state.selection.main.head;
        if (pos !== g.pos) return false;
        lastAcceptAt = Date.now();          /* 告诉 update：这次改动是我写的，别再排期 */
        view.dispatch({
          changes: { from: pos, insert: g.text },
          selection: { anchor: pos + g.text.length },
          scrollIntoView: true,
        });
        /* 连续写作：采纳完接着猜下一句 */
        if (plugin.settings.completeChain !== false) {
          setTimeout(function () {
            try {
              const inst = view.plugin(completer);
              if (inst) inst.schedule();
            } catch (e) { dlog('L5061', e); }
          }, 260);
        }
        return true;
      },
    },
  ]));

  const clearKeys = keymap.of([
    {
      key: 'Escape',
      run: function (view) {
        const g = view.state.field(ghostField, false);
        if (!g) return false;
        muteUntil = Date.now() + 12000;   /* 12 秒内别再来烦我 */
        view.dispatch({ effects: clearGhost.of(null) });
        return true;
      },
    },
  ]);

  obaiGhostAPI = {
    field: ghostField,
    setGhost: setGhost,
    clearGhost: clearGhost,
    viewPlugin: completer,
    clear: function (view) {
      try {
        if (view && view.state && view.state.field(ghostField, false)) {
          view.dispatch({ effects: clearGhost.of(null) });
        }
      } catch (e) { dlog('L5092', e); }
    },
    /* 手动补一次：拿到某个编辑器上的 completer 实例，直接跑一遍 */
    runNow: function (view) {
      if (!view || typeof view.plugin !== 'function') {
        noteComplete(plugin, false, '拿不到编辑器视图', true);
        return false;
      }
      const inst = view.plugin(completer);
      if (!inst) {
        noteComplete(plugin, false,
          '这个编辑器上没有补全实例 —— 扩展没被应用（可能是 Obsidian 版本改了内部模块）', true);
        return false;
      }
      Promise.resolve(inst.run(true)).catch(function () { });
      return true;
    },
  };

  return [ghostField, completer, acceptKeys, clearKeys];
}

/* 设置页 */
class ObaiSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; this._open = {}; this._page = ''; }

  _state(p) {
    if (!trimBase(p.baseUrl)) return '未填地址';
    if (!p.model) return '缺模型';
    return '已配置 · ' + p.model;
  }

  display() {
    const c = this.containerEl;
    c.empty();
    c.classList.add('obai-settings');   /* 样式作用域：只收紧本插件设置页的行高 */
    this._renderHead(c);

    const page = this._page || '';
    if (!page) { this._renderHome(c); return; }
    this._renderBack(c, page);

    if (page === 'providers') this._pageProviders(c);
    else if (page === 'actions') this._pageActions(c);
    else if (page === 'complete') this._pageComplete(c);
    else if (page === 'prompts') this._pagePrompts(c);
    else if (page === 'custom') this._pageCustom(c);
    else if (page === 'templates') this._pageTemplates(c);
    else if (page === 'more') this._pageMore(c);
    else if (page === 'diag') this._pageDiag(c);
    else if (page === 'help') this._pageHelp(c);
    else { this._page = ''; this._renderHome(c); }
  }

  _go(page) {
    this._page = page || '';
    this.display();
    try { this.containerEl.scrollTop = 0; } catch (e) { dlog('L5149', e); }
  }

  _pageTitle(page) {
    const m = {
      providers: '接口与模型', actions: '动作与入口', complete: '行内补全',
      prompts: '内置动作提示词', custom: '自定义动作', templates: '提示词模板', more: '诊断与关于',
      diag: '故障检测', help: '关于与用法',
    };
    return m[page] || '设置';
  }

  /* 顶部：名字 + 版本 + 作者 + 一把小扳手（点它去"关于 / 用法"） */
  _renderHead(c) {
    const plug = this.plugin;
    const ver = (plug.manifest && plug.manifest.version) ? plug.manifest.version : '';
    const head = c.createDiv({ cls: 'obai-head' });
    const left = head.createDiv({ cls: 'obai-head-left' });

    /* 标题本身就是入口：点一下进「诊断与关于」；hover 出一个小扳手 */
    const nameRow = left.createDiv({ cls: 'obai-head-name-row' });
    nameRow.createEl('div', { cls: 'obai-head-name', text: 'Hadesr AI' });
    const wrench = nameRow.createSpan({ cls: 'obai-head-wrench' });
    setIcon(wrench, 'wrench');
    nameRow.title = '诊断与关于';
    nameRow.setAttribute('aria-label', '诊断与关于');
    nameRow.onclick = () => this._go('more');

    left.createEl('div', { cls: 'obai-head-meta', text: 'v' + ver + '　·　作者 Hadesr' });
  }

  /* 二级页顶部：← 返回 */
  _renderBack(c, page) {
    const back = c.createDiv({ cls: 'obai-back' });
    const ic = back.createSpan({ cls: 'obai-back-icon' });
    setIcon(ic, 'chevron-left');
    back.createSpan({ cls: 'obai-back-title', text: this._pageTitle(page) });
    back.onclick = () => this._go('');
  }

  /* 首页目录 */
  _homeRows() {
    const s = this.plugin.settings;
    const prov = s.providers || [];
    const cur = prov.filter(function (p) { return p.id === s.activeProvider; })[0];
    const lc = this.plugin._lastComplete;
    return [
      {
        id: 'providers', icon: 'server', name: '接口与模型',
        desc: s.mode === MODE_AUTO
          ? ('自动 · 共 ' + prov.length + ' 个接口')
          : ('手动 · ' + (cur ? (cur.name || '未命名') : '未选')),
      },
      { id: 'actions', icon: 'wand-2', name: '动作与入口', desc: '浮条 / 位置 / 流式 / 每动作指定接口' },
      {
        id: 'complete', icon: 'text-cursor-input', name: '行内补全',
        desc: (s.complete ? '已开启' : '已关闭')
          + ' · 停手 ' + s.completeDelay + 'ms'
          + (lc ? (' · ' + (lc.ok ? '上次成功' : '上次未出')) : ''),
      },
      {
        id: 'prompts', icon: 'pencil-line', name: '内置动作提示词',
        desc: Object.keys(s.actionPrompts || {}).length
          ? (Object.keys(s.actionPrompts || {}).length + ' 个已改') : '默认',
      },
      { id: 'custom', icon: 'sparkles', name: '自定义动作', desc: (s.customActions || []).length + ' 个' },
      { id: 'templates', icon: 'file-text', name: '提示词模板', desc: (s.promptTemplates || []).length + ' 个' },
    ];
  }

  _renderHome(c) {
    const rows = this._homeRows();
    const self = this;
    rows.forEach(function (r) {
      const row = c.createDiv({ cls: 'obai-nav-row' });
      const ic = row.createDiv({ cls: 'obai-nav-icon' });
      setIcon(ic, r.icon);
      const tx = row.createDiv({ cls: 'obai-nav-text' });
      tx.createEl('div', { cls: 'obai-nav-name', text: r.name });
      tx.createEl('div', { cls: 'obai-nav-desc', text: r.desc });
      const ar = row.createDiv({ cls: 'obai-nav-arrow' });
      setIcon(ar, 'chevron-right');
      row.onclick = function () { self._go(r.id); };
    });
  }

  _pageProviders(c) {
    const plug = this.plugin, s = plug.settings;
    /* ── 顶部：接口选择 + 温度 ── */
    /* 切换模式：只切「自动 / 手动」，具体用哪个接口在下面单独选 */
    new Setting(c)
      .setName('切换模式')
      .setDesc('自动 = 按下面「模型接口」列表的顺序挨个试，前一个不通就换下一个；手动 = 只用你指定的那一个')
      .addDropdown((d) => {
      d.addOption('manual', '手动(指定接口)');
      d.addOption(MODE_AUTO, '自动(依次尝试)');
        d.setValue(s.mode === MODE_AUTO ? MODE_AUTO : 'manual');
        d.onChange(async (v) => {
          s.mode = (v === MODE_AUTO) ? MODE_AUTO : 'manual';
          await plug.saveSettings();
          this.display();
        });
      });

    /* 手动模式才需要指定「用哪个」 */
    if (s.mode !== MODE_AUTO) {
      new Setting(c)
        .setName('当前接口')
        .setDesc('手动模式下用哪一个')
        .addDropdown((d) => {
          (s.providers || []).forEach((p) => d.addOption(p.id, p.name || '未命名'));
          d.setValue(s.activeProvider);
          d.onChange(async (v) => { s.activeProvider = v; await plug.saveSettings(); this.display(); });
        });
    }

    new Setting(c)
      .setName('温度')
      .setDesc('0 = 最保守稳定；0.3 适合润色 / 翻译；想更有创意可调到 0.7 以上')
      .addSlider((sl) => sl.setLimits(0, 1, 0.05).setValue(s.temperature).setDynamicTooltip()
        .onChange(async (v) => { s.temperature = v; await plug.saveSettings(); }));

    /* ── 接口列表 ── */
    c.createEl('p', {
      text: '可以加任意多个（本地 / 云端都行）。点标题展开配置；**列表顺序就是「自动」模式的尝试顺序**。' +
        'API Key 加密后存本机，界面从不回显。',
      cls: 'setting-item-description',
    });

    (s.providers || []).forEach((p) => this._renderProvider(c, p));

    const addWrap = c.createEl('div', { cls: 'obai-add-row' });
    const addBtn = addWrap.createEl('button', { text: '＋ 添加接口', cls: 'obai-add-btn' });
    addBtn.onclick = async () => {
      const id = 'p' + Date.now().toString(36);
      s.providers.push({ id: id, name: '新接口', format: 'openai', baseUrl: '', apiKey: '', model: '' });
      await plug.saveSettings();
      this.display();
    };

  }

  _pageActions(c) {
    const plug = this.plugin, s = plug.settings;
    /* ── 动作与入口 ── */

    new Setting(c)
      .setName('选中文字时浮出小工具条')
      .setDesc('选中一段文字后，在选区旁边浮出一条：润色 / 翻译 / 总结 / ⋯（⋯ 里有全部动作）。关闭后仍可用命令面板和左侧 ✨')
      .addToggle((t) => t.setValue(s.selectionBubble !== false)
        .onChange(async (v) => { s.selectionBubble = v; await plug.saveSettings(); }));

    new Setting(c)
      .setName('浮条出现位置')
      .setDesc('默认放在选区下方（上方常被别的工具栏占着）。不管选哪种，贴边放不下时都会自动翻到另一边')
      .addDropdown((d) => {
        d.addOption('below', '选区下方（默认）');
        d.addOption('above', '选区上方');
        d.setValue(s.bubblePosition === 'above' ? 'above' : 'below');
        d.onChange(async (v) => { s.bubblePosition = v; await plug.saveSettings(); });
      });

    new Setting(c)
      .setName('流式输出（边生成边显示）')
      .setDesc('开启后思考过程和正文会逐字出现，不用干等。'
        + '如果你的接口不支持流式（比如某些代理或本地服务没开 CORS），会自动退回普通模式，不影响使用')
      .addToggle((t) => t.setValue(s.stream !== false)
        .onChange(async (v) => { s.stream = v; await plug.saveSettings(); }));

    new Setting(c)
      .setName('记住对话历史')
      .setDesc('把「提问 + 回答」存在本机，方便回看与继续；**不含选中的正文**。'
        + '关掉后不再新增，已有记录可在对话框的「历史」里清空')
      .addToggle((t) => t.setValue(s.rememberChat !== false)
        .onChange(async (v) => { s.rememberChat = v; await plug.saveSettings(); }));

    new Setting(c)
      .setName('笔记属性用中文键名')
      .setDesc('开启后写「标题 / 摘要 / tags」；默认写 title / summary / tags。'
        + 'tags 始终英文 —— 它是 Obsidian 内置属性，改了会失去标签功能')
      .addToggle((t) => t.setValue(s.fmZh === true)
        .onChange(async (v) => { s.fmZh = v; await plug.saveSettings(); }));

    /* 每动作指定接口（折叠，避免一屏 12 行） */
    const apD = c.createEl('details', { cls: 'obai-slot' });
    const apS = apD.createEl('summary');
    apS.createEl('span', { text: '每个动作单独指定接口', cls: 'obai-slot-name' });
    const usedCount = Object.keys(s.actionProviders || {}).length;
    apS.createEl('span', { text: usedCount ? usedCount + ' 个已指定' : '默认全部跟随顶部', cls: 'obai-slot-state' });
    const apBody = apD.createDiv({ cls: 'obai-slot-body' });
    apBody.createEl('p', {
      text: '默认跟随顶部的「切换模式」。想让某个动作固定走某个接口（比如翻译走云端、润色走本地），在这里单独指定。'
        + '除了 16 个动作，下面还包含**快速改写 / AI 对话 / 转 Canvas / 添加笔记属性**四个入口。',
      cls: 'setting-item-description',
    });
    /* 16 个正文动作 + 4 个整篇/面板级入口 */
    allActions(s).concat(PROVIDER_EXTRA_TARGETS).forEach((a) => {
      new Setting(apBody).setName(a.name)
        .addDropdown((d) => {
          d.addOption('', '跟随顶部设置');
          (s.providers || []).forEach((pv) => d.addOption(pv.id, pv.name || '未命名'));
          d.setValue((s.actionProviders || {})[a.id] || '');
          d.onChange(async (v) => {
            s.actionProviders = s.actionProviders || {};
            if (v) s.actionProviders[a.id] = v;
            else delete s.actionProviders[a.id];
            await plug.saveSettings();
          });
        });
    });

  }

  _pagePrompts(c) {
    const plug = this.plugin, s = plug.settings;
    c.createEl('p', {
      text: '16 个内置动作的提示词可以改。改过的会显示「已改」，随时能恢复默认。'
        + '想加全新动作请用「自定义动作」那一页。',
      cls: 'setting-item-description',
    });

    const boxes = [];
    new Setting(c)
      .setName('搜索')
      .setDesc('输入中文动作名筛选（如：润色 / 精简 / 翻译）')
      .addText((t) => t.setPlaceholder('输入动作名，如：润色')
        .setValue(this._promptFilter || '')
        .onChange((v) => {
          this._promptFilter = String(v || '').trim();
          const kw = this._promptFilter.toLowerCase();
          boxes.forEach(function (b) {
            if (!b.el) return;
            const hit = !kw || b.name.toLowerCase().indexOf(kw) >= 0;
            if (b.el.style) b.el.style.display = hit ? '' : 'none';
          });
        }));

    ACTIONS.forEach((a) => {
      const over = (s.actionPrompts || {})[a.id];
      const st = new Setting(c)
        .setName(a.name)
        .setDesc(over ? '已改（自定义提示词）' : '默认')
        .addButton((b) => b.setButtonText(over ? '查看 / 修改' : '改提示词')
          .setClass('obai-linkbtn')
          .onClick(() => {
            new PromptEditModal(
              plug.app,
              '「' + a.name + '」的提示词',
              over || a.instruction || '',
              a.instruction || '',
              async (val) => {
                s.actionPrompts = s.actionPrompts || {};
                const v = String(val || '').trim();
                if (v && v !== (a.instruction || '')) s.actionPrompts[a.id] = v;
                else delete s.actionPrompts[a.id];
                await plug.saveSettings();
                this.display();
                new Notice('Hadesr AI：已保存');
              }
            ).open();
          }));

      boxes.push({ name: a.name, el: st.settingEl || null });
    });
    /* 重渲染后按上次的关键词再过滤一次 */
    if (this._promptFilter) {
      const kw = this._promptFilter.toLowerCase();
      boxes.forEach(function (b) {
        if (!b.el || !b.el.style) return;
        if (b.name.toLowerCase().indexOf(kw) < 0) b.el.style.display = 'none';
      });
    }
  }

  _pageComplete(c) {
    const plug = this.plugin, s = plug.settings;
    /* ── 行内补全 ── */
    c.createEl('p', {
      text: '写东西时停一下，AI 会在光标后面用**灰色文字**接着往下猜：按 Tab 采纳，按 Esc 忽略，继续打字也会自动消失。'
        + '灰字不在文档里 —— 采纳之前，撤销栈、复制、字数统计都当它不存在。',
      cls: 'setting-item-description',
    });

    new Setting(c)
      .setName('启用行内补全')
      .setDesc('默认关闭。开启后每停手一次就发一个很短的请求，用得多再开；'
        + '失败不会弹窗打断你，原因记在下面的「补全诊断」里')
      .addToggle((t) => t.setValue(s.complete === true)
        .onChange(async (v) => {
          s.complete = v;
          await plug.saveSettings();
          if (!v) plug.clearGhosts();
          this.display();
        }));

    /* ── 补全诊断：不补的时候，先看这里 ── */
    const dg = c.createDiv({ cls: 'obai-diag' });
    dg.createEl('div', { cls: 'obai-diag-title', text: '补全诊断' });
    const lc = plug._lastComplete;
    const rows = [
      ['CodeMirror 模块', plug._cmInstalled ? '✅ 已取到' : '❌ 没取到（这一版 Obsidian 里拿不到内部模块）'],
      ['编辑器扩展', plug._cmInstalled ? '✅ 已注册' : '❌ 未注册'],
      ['总开关', s.complete ? '开' : '关（打开上面的开关）'],
      ['触发条件', '光标在行尾 + 停手 ' + s.completeDelay + 'ms'],
      ['上次尝试', lc
        ? ((lc.ok ? '✅ ' : (lc.level === 'skip' ? '⏭ ' : '❌ ')) + lc.msg
          + '　' + new Date(lc.at).toLocaleTimeString())
        : '还没试过（写一句话停手，或点下面的按钮）'],
    ];
    rows.forEach(function (r) {
      const row = dg.createDiv({ cls: 'obai-diag-row' });
      row.createEl('span', { cls: 'obai-diag-k', text: r[0] });
      row.createEl('span', { cls: 'obai-diag-v' + (String(r[1]).indexOf('❌') === 0 ? ' is-bad' : ''), text: r[1] });
    });
    const tryBtn = dg.createEl('button', { text: '现在补一次（用当前笔记）', cls: 'obai-diag-btn' });
    const self2 = this;
    tryBtn.onclick = function () {
      plug.completeNow();
      /* 请求要一两秒，回来后再刷一次面板，好让你直接看到结果 */
      setTimeout(function () { self2.display(); }, 1800);
    };

    if (s.complete) {
      new Setting(c)
        .setName('什么时候补')
        .setDesc('自动 = 停手后自己补（默认）；手动 = 只有你执行命令「行内补全：现在补一次」时才补')
        .addDropdown((d) => {
          d.addOption('auto', '自动（停手后）');
          d.addOption('manual', '仅手动（命令触发）');
          d.setValue(s.completeTrigger === 'manual' ? 'manual' : 'auto');
          d.onChange(async (v) => { s.completeTrigger = v; await plug.saveSettings(); });
        });

      new Setting(c)
        .setName('停手多久后开始补')
        .setDesc('「AI 思考中」药丸是按键就出的，这里只决定多久后真正发请求。'
          + '400 毫秒左右最跟手；觉得请求太频繁可以调到 800～1200')
        .addSlider((sl) => sl.setLimits(200, 2500, 50).setValue(s.completeDelay).setDynamicTooltip()
          .onChange(async (v) => { s.completeDelay = v; await plug.saveSettings(); }));

      new Setting(c)
        .setName('一次最多补几个字')
        .setDesc('只作保险 —— 正常由模型自己说完一句就收，120 字左右够用')
        .addSlider((sl) => sl.setLimits(40, 240, 10).setValue(s.completeMax).setDynamicTooltip()
          .onChange(async (v) => { s.completeMax = v; await plug.saveSettings(); }));

      new Setting(c)
        .setName('补全时参考整篇笔记')
        .setDesc('开启后会把当前笔记的**标题大纲 + 双链 + 术语 + 正文节选**一起发给模型，'
          + '补出来的话更贴合这篇文章的用词与风格。代价是首字会慢一点（prompt 变长）。'
          + '笔记按修改时间缓存，不会每次重复读盘')
        .addToggle((t) => t.setValue(s.completeNoteContext === true)
          .onChange(async (v) => { s.completeNoteContext = v; await plug.saveSettings(); }));

      new Setting(c)
        .setName('代码块里只补一行')
        .setDesc('模型经常把**下一条命令**也补出来（比如你要 interface Vlan-interface 62，它给你两条）。'
          + '开着就硬截成一行；这一行以 \\ / | / , / && 结尾时仍会保留续行')
        .addToggle((t) => t.setValue(s.completeCodeOneLine !== false)
          .onChange(async (v) => { s.completeCodeOneLine = v; await plug.saveSettings(); }));

      new Setting(c)
        .setName('Tab 采纳后自动补下一句')
        .setDesc('连续写作时不用每次都停手 —— 采纳完会立刻把下一句也猜出来。嫌吵可以关')
        .addToggle((t) => t.setValue(s.completeChain !== false)
          .onChange(async (v) => { s.completeChain = v; await plug.saveSettings(); }));

      new Setting(c)
        .setName('代码块里也补全')
        .setDesc('默认关。补错的命令（尤其是网络 / 删除这类）比不补危险得多 —— 确认过再开')
        .addToggle((t) => t.setValue(s.completeCode === true)
          .onChange(async (v) => { s.completeCode = v; await plug.saveSettings(); }));

      new Setting(c)
        .setName('补全用哪个接口')
        .setDesc('建议指到本地小模型 —— 补全请求很频繁，走云端又慢又费。留空则跟随顶部设置')
        .addDropdown((d) => {
          d.addOption('', '跟随顶部设置');
          (s.providers || []).forEach((pv) => d.addOption(pv.id, pv.name || '未命名'));
          d.setValue(s.completeProvider || '');
          d.onChange(async (v) => { s.completeProvider = v; await plug.saveSettings(); });
        });

      if (plug._cmMissing) {
        c.createEl('p', {
          text: '⚠ 这一版 Obsidian 里没拿到 CodeMirror 模块，补全装不上（其它功能不受影响）。'
            + '一般是 Obsidian 大版本升级改了内部结构，等插件更新即可。',
          cls: 'setting-item-description',
        });
      }
    }

  }

  _pageCustom(c) {
    const plug = this.plugin, s = plug.settings;
    /* ── 自定义动作 ── */
    c.createEl('p', {
      text: '自己定义的动作会**立刻出现在**浮条的 ▾ 菜单和右上角 ✨ 里；' +
        '想让它也有独立命令，加完重载一次 Obsidian。选中内容会作为「用户输入」发给模型，'
        + '「提示词」就是告诉模型"你要怎么处理它"。',
      cls: 'setting-item-description',
    });

    (s.customActions || []).forEach((ca, idx) => {
      const box = c.createEl('details', { cls: 'obai-slot' });
      const sm = box.createEl('summary');
      sm.createEl('span', { text: ca.name || '未命名', cls: 'obai-slot-name' });
      sm.createEl('span', { text: ca.system ? '已填提示词' : '缺提示词', cls: 'obai-slot-state' });
      const bd = box.createDiv({ cls: 'obai-slot-body' });

      new Setting(bd).setName('名称')
        .addText((t) => t.setPlaceholder('比如「改成客户口吻」').setValue(ca.name || '')
          .onChange(async (v) => { ca.name = v.trim(); await plug.saveSettings(); }));

      new Setting(bd).setName('提示词')
        .setDesc('告诉模型怎么处理选中的文字。要写清"只输出结果、不要解释"之类的约束')
        .addTextArea((t) => {
          t.setPlaceholder('你是……。请把用户给的文字……。只输出结果，不要解释。')
            .setValue(ca.system || '')
            .onChange(async (v) => { ca.system = v; await plug.saveSettings(); });
          t.inputEl.style.minWidth = '100%';
          t.inputEl.style.minHeight = '84px';
        });

      new Setting(bd).setName('用哪个接口')
        .setDesc('留空跟随顶部设置；想让这个动作固定走某个接口就在这里选')
        .addDropdown((d) => {
          d.addOption('', '跟随顶部设置');
          (s.providers || []).forEach((pv) => d.addOption(pv.id, pv.name || '未命名'));
          d.setValue((s.actionProviders || {})[ca.id] || '');
          d.onChange(async (v) => {
            s.actionProviders = s.actionProviders || {};
            if (v) s.actionProviders[ca.id] = v;
            else delete s.actionProviders[ca.id];
            await plug.saveSettings();
          });
        });

      new Setting(bd).setName('删除这个动作')
        .addButton((b) => {
          b.setButtonText('删除').setWarning();
          let armed = false;
          b.onClick(async () => {
            if (!armed) {
              armed = true; b.setButtonText('确认删除？');
              setTimeout(() => { armed = false; b.setButtonText('删除'); }, 4000);
              return;
            }
            s.customActions = (s.customActions || []).filter((x) => x.id !== ca.id);
            delete (s.actionProviders || {})[ca.id];
            await plug.saveSettings();
            this.display();
            new Notice('Hadesr AI：已删除「' + (ca.name || '未命名') + '」');
          });
        });
    });

    const caAddWrap = c.createEl('div', { cls: 'obai-add-row' });
    const caAddBtn = caAddWrap.createEl('button', { text: '＋ 添加自定义动作', cls: 'obai-add-btn' });
    caAddBtn.onclick = async () => {
      s.customActions = s.customActions || [];
      s.customActions.push({ id: 'c' + Date.now().toString(36), name: '新动作', icon: 'sparkles', system: '' });
      await plug.saveSettings();
      this.display();
    };

  }

  _pageTemplates(c) {
    const plug = this.plugin, s = plug.settings;
    /* 这一页只有模板这一个东西，再套一层折叠就是"子模块里套折叠"，纯属多余 —— 直接平铺 */
    const tplBody = c;
    tplBody.createEl('p', {
      text: '对话框里「一点就填」的常用指令。共 ' + (s.promptTemplates || []).length + ' 个。',
      cls: 'setting-item-description',
    });

    /* 变量说明 */
    const varBox = tplBody.createDiv({ cls: 'obai-vars' });
    varBox.createEl('div', { cls: 'obai-vars-title', text: '可用变量（发出去之前会在本地展开成实际内容）' });
    const varRow = varBox.createDiv({ cls: 'obai-vars-row' });
    ['{{selection}}', '{{file:content}}', '{{file:path}}', '{{date}}', '{{time}}', '{{datetime}}', '{{vault:name}}']
      .forEach((v) => varRow.createEl('code', { text: v, cls: 'obai-var' }));

    (s.promptTemplates || []).forEach((t) => {
      const row = tplBody.createDiv({ cls: 'obai-tplrow' });
      const left = row.createDiv({ cls: 'obai-tplrow-main' });
      left.createEl('div', { text: t.name || '未命名模板', cls: 'obai-tplrow-name' });
      left.createEl('div', { text: (t.text || '（还没填内容）').replace(/\s+/g, ' ').slice(0, 90), cls: 'obai-tplrow-desc' });

      const btns = row.createDiv({ cls: 'obai-tplrow-btns' });
      const eBtn = btns.createEl('button', { text: '编辑', cls: 'obai-chipbtn' });
      eBtn.onclick = () => {
        const copy = { id: t.id, name: t.name, text: t.text };
        new TemplateEditModal(plug.app, copy, async () => {
          t.name = copy.name;
          t.text = copy.text;
          await plug.saveSettings();
          this.display();
        }).open();
      };
      const dBtn = btns.createEl('button', { text: '删除', cls: 'obai-chipbtn is-danger' });
      dBtn.onclick = async () => {
        s.promptTemplates = (s.promptTemplates || []).filter((x) => x.id !== t.id);
        await plug.saveSettings();
        this.display();
      };
    });

    const tplFoot = tplBody.createDiv({ cls: 'obai-tplfoot' });
    const resetBtn = tplFoot.createEl('button', { text: '重置默认模板', cls: 'obai-chipbtn' });
    resetBtn.onclick = async () => {
      s.promptTemplates = DEFAULT_TEMPLATES.map(function (t) {
        return { id: t.id, name: t.name, text: t.text };
      });
      await plug.saveSettings();
      this.display();
      new Notice('Hadesr AI：已重置为默认 5 个模板');
    };
    const tplAddBtn = tplFoot.createEl('button', { text: '＋ 添加模板', cls: 'obai-chipbtn is-accent' });
    tplAddBtn.onclick = async () => {
      s.promptTemplates = s.promptTemplates || [];
      s.promptTemplates.push({ id: 'tp' + Date.now().toString(36), name: '新模板', text: '' });
      await plug.saveSettings();
      this.display();
    };

  }

  /* 扳手进来的页：故障检测 + 关于与用法 */
  _pageMore(c) {
    c.createEl('h3', { text: '故障检测' });
    this._pageDiag(c);
    c.createEl('h3', { text: '关于与用法' });
    this._pageHelp(c);
  }

  _pageDiag(c) {
    const plug = this.plugin, s = plug.settings;
    /* ── 调试开关 ── */
    new Setting(c)
      .setName('调试日志')
      .setDesc('开着时把被静默兜底的异常打到开发者控制台（[obai] 开头）；关着时完全静默。'
        + '排查「AI 没反应 / 补全不出字 / 结果写不回去」时打开它，再看控制台输出就能定位是哪一步断了。')
      .addToggle((t) => {
        t.setValue(!!s.debug);
        t.onChange(async (v) => {
          s.debug = !!v;
          setDebug(s.debug);
          await plug.saveSettings();
        });
      });

    /* ── 故障检测 ── */
    c.createEl('p', {
      text: 'AI 用不了时点这里。会逐段检查：Obsidian 模块是否可用 → 每个接口的「地址 / 连通 / 鉴权 / 模型」。' +
        '哪一步标红，问题就在哪一段 —— 不用再猜是网络、Key 还是模型名。',
      cls: 'setting-item-description',
    });

    new Setting(c)
      .setName('运行诊断')
      .setDesc('会真的发请求；离线时也能看出是网络问题而不是配置问题')
      .addButton((b) => {
        b.setButtonText('开始检测').setCta();
        b.onClick(async () => {
          b.setButtonText('检测中…'); b.setDisabled(true);
          try {
            const sections = [];
            const curP = (s.providers || []).filter((x) => x.id === s.activeProvider)[0];

            sections.push({
              heading: '环境',
              lines: [
                { ok: true, label: 'Hadesr AI 版本', detail: plug.manifest.version },
                {
                  ok: true, label: '当前模式',
                  detail: s.mode === MODE_AUTO ? '自动(依次尝试)' : '手动(' + (curP ? (curP.name || '未命名') : '未指定') + ')',
                },
                { ok: true, label: '接口数量', detail: (s.providers || []).length + ' 个' },
              ],
            });

            sections.push({
              heading: 'Obsidian 模块（行内补全将来要用）',
              lines: probeModules().map(function (m) {
                return {
                  ok: m.ok && !m.missing.length,
                  label: m.mod,
                  detail: m.ok ? (m.missing.length ? '缺：' + m.missing.join('、') : '全部可用') : ('拿不到：' + m.err),
                };
              }),
            });

            for (const pv of (s.providers || [])) {
              b.setButtonText('检测「' + (pv.name || '未命名') + '」…');
              sections.push({ heading: '接口 · ' + (pv.name || '未命名'), lines: await testProvider(pv) });
            }

            new DiagModal(plug.app, 'Hadesr AI 故障检测', sections).open();
          } catch (e) {
            new Notice('Hadesr AI：诊断本身出错 —— ' + String((e && e.message) || e), 10000);
          } finally {
            b.setButtonText('开始检测'); b.setDisabled(false);
          }
        });
      });

  }

  _pageHelp(c) {
    const plug = this.plugin, s = plug.settings;
    /* ── 怎么用 ── */
    const ul = c.createEl('ul');
    [
      '选中一段文字 → 旁边浮出胶囊「✦ AI ▾」：点 AI 直接跑上次那个动作，点 ▾ 换别的',
      '右键 → Hadesr AI → 编辑 / 生成 / 翻译，分类里挑（语气还分了专业 / 口语）',
      '左侧栏的 ✨ → AI 对话：可拖动、能多轮、能「＋ 引用笔记」，结果落在原位置',
      '结果卡片的按钮按场景变：替换 / 插入下方 / 创建 / 创建并嵌入 / 复制 / 丢弃',
      '整篇处理：命令「对整篇笔记执行某个动作…」；另有「添加笔记属性」「转成 Canvas」',
      '行内补全（要手动开）：停手约 0.9 秒，光标后出现灰字 —— Tab 采纳、Esc 忽略、继续打字自动消失',
    ].forEach((t) => ul.createEl('li', { text: t }));
  }

  /* 调整接口顺序（自动模式按这个顺序挨个试） */
  async _moveProvider(p, dir) {
    const arr = this.plugin.settings.providers || [];
    const i = arr.indexOf(p);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    await this.plugin.saveSettings();
    this.display();
  }

  _renderProvider(c, p) {
    const plug = this.plugin, s = plug.settings, tab = this;

    const details = c.createEl('details', { cls: 'obai-slot' });
    /* 记住每块的展开状态 —— 否则「获取模型」重渲染后会把正在配的那块收起来 */
    /* 默认全部折叠，点过就记住状态。 */
    const shouldOpen = tab._open[p.id] !== undefined ? tab._open[p.id] : false;
    details.open = !!shouldOpen;
    details.addEventListener('toggle', () => { tab._open[p.id] = details.open; });

    const summary = details.createEl('summary');
    const nameEl = summary.createEl('span', { text: p.name || '未命名', cls: 'obai-slot-name' });
    const fmtBadge = summary.createEl('span', { cls: 'obai-fmt-badge' });
    fmtBadge.setText((FORMATS[p.format] || FORMATS.openai).label);
    /* 顺序按钮：自动模式按列表顺序尝试，所以要能调 */
    const arr = s.providers || [];
    const idx = arr.indexOf(p);
    const mkOrder = (dir, label) => {
      const b = summary.createEl('button', { cls: 'obai-order-btn', text: label });
      const off = (dir < 0 && idx <= 0) || (dir > 0 && idx >= arr.length - 1);
      if (off) { b.classList.add('is-off'); b.disabled = true; }
      b.title = dir < 0 ? '上移（更早尝试）' : '下移（更晚尝试）';
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        tab._moveProvider(p, dir);
      };
      return b;
    };
    mkOrder(-1, '↑');
    mkOrder(1, '↓');

    const stateEl = summary.createEl('span', { cls: 'obai-slot-state' });
    stateEl.setText(tab._state(p));
    const refresh = () => { stateEl.setText(tab._state(p)); };

    const body = details.createDiv({ cls: 'obai-slot-body' });

    /* 名称 */
    new Setting(body).setName('名称')
      .setDesc('只在这里显示，随便起（比如「本地服务」「云端 DeepSeek」）')
      .addText((t) => {
        t.setPlaceholder('接口名称').setValue(p.name || '')
          .onChange(async (v) => {
            p.name = v.trim() || '未命名';
            await plug.saveSettings();
            nameEl.setText(p.name);
          });
        t.inputEl.style.minWidth = '200px';
      });

    /* 接口格式 */
    new Setting(body).setName('接口格式')
      .setDesc(FORMATS[p.format] ? FORMATS[p.format].hint : '')
      .addDropdown((d) => {
        FORMAT_KEYS.forEach((k) => d.addOption(k, FORMATS[k].label));
        d.setValue(p.format || 'openai');
        d.onChange(async (v) => {
          p.format = v;
          await plug.saveSettings();
          tab.display();       /* 地址占位符等会随格式变，整体重渲染最省事 */
        });
      });

    /* API 地址 */
    new Setting(body).setName('API 地址')
      .setDesc('按上面的接口格式填；调用时会自动补具体路径')
      .addText((t) => {
        const f = FORMATS[p.format] || FORMATS.openai;
        t.setPlaceholder(f.urlPlaceholder).setValue(p.baseUrl || '')
          .onChange(async (v) => { p.baseUrl = v.trim(); await plug.saveSettings(); refresh(); });
        t.inputEl.style.minWidth = '280px';
      });

    /* API Key：可选 / 不回显 / 可清空 */
    let keyInput = null;
    let keyTimer = 0;
    const savedKey = decStr(p.apiKey);
    const fmtCfg = FORMATS[p.format] || FORMATS.openai;
    const keyHint = savedKey
      ? '已保存（末 4 位 ' + savedKey.slice(-4) + '）· 留空不改，要删点右边 🧹'
      : (fmtCfg.needsKey ? '这个格式通常需要 Key' : 'sk-... 或留空');

    new Setting(body).setName('API Key')
      .setDesc('**可选**（Ollama / 本地服务通常不需要）。出于安全**从不回显**：留空表示不改动，填新的才会覆盖并自动加密')
      .addText((t) => {
        keyInput = t;
        t.inputEl.type = 'password';
        t.inputEl.autocomplete = 'off';
        t.inputEl.spellcheck = false;
        t.setPlaceholder(keyHint)
          .setValue('')                       /* 完全不回填，二次进来就是空白 */
          .onChange((v) => {
            const val = v.trim();
            if (!val) return;
            clearTimeout(keyTimer);
            keyTimer = setTimeout(() => {
              /* 这里不能写 async —— 定时器里的 async 抛错没人接，会变成
                 unhandled rejection，Obsidian 直接弹红框。自己 try 住。 */
              p.apiKey = encStr(val);
              Promise.resolve(plug.saveSettings()).then(
                function () {
                  t.setPlaceholder('已保存（末 4 位 ' + val.slice(-4) + '）· 留空不改，要删点右边 🧹');
                },
                function () { new Notice('Hadesr AI：Key 保存失败，请重试'); }
              );
            }, 400);
          });
        t.inputEl.style.minWidth = '240px';
      })
      .addExtraButton((b) => b.setIcon('eraser').setTooltip('清空这个接口的 Key（立即生效）')
        .onClick(async () => {
          keyInput.setValue('');
          p.apiKey = '';
          await plug.saveSettings(); refresh();
          keyInput.setPlaceholder('sk-... 或留空');
          new Notice('Hadesr AI：已清空「' + (p.name || '未命名') + '」的 API Key');
        }));

    this._providerModelSection(body, p, plug, refresh);
  }

  /* 模型选择 / 测试连接 / 删除接口 —— 从 _renderProvider 里拆出来的。
     原来那个函数 200 多行，改一行要上下翻半天，容易看漏上下文。 */
  _providerModelSection(body, p, plug, refresh) {
    const tab = this, s = plug.settings;

    /* 模型：下拉选择（获取后填充），另留「手动输入…」的口子 */
    /* ⚠ 手输框要**懒创建**：它必须排在「选择模型」那行**下面**，
       所以不能在前面先 createDiv（那样会跑到上一行去）。 */
    let manualWrap = null;

    const cached = plug._modelCache[p.id] || [];
    const opts = [];
    if (!cached.length) {
      opts.push({ v: '', t: '（还没获取模型）' });
      if (p.model) opts.push({ v: p.model, t: p.model + '（当前）' });
    } else {
      if (!p.model) opts.push({ v: '', t: '（请选择模型）' });
      cached.forEach((id) => opts.push({ v: id, t: id }));
      /* 当前值不在列表里（手输的 / 列表刷新过）→ 补一项，保证下拉能反映真实值 */
      if (p.model && cached.indexOf(p.model) < 0) opts.push({ v: p.model, t: p.model + '（当前）' });
    }
    opts.push({ v: '__manual__', t: '✑ 手动输入…' });

    const showManual = () => {
      if (!manualWrap) return;
      manualWrap.empty();
      manualWrap.style.display = '';
      new Setting(manualWrap)
        .setName('模型名称')
        .setDesc('填完自动保存')
        .addText((t) => {
          t.setPlaceholder('模型名').setValue(p.model || '')
            .onChange(async (v) => { p.model = v.trim(); await plug.saveSettings(); refresh(); });
          t.inputEl.style.minWidth = '240px';
        });
    };
    const hideManual = () => {
      if (!manualWrap) return;
      manualWrap.empty();
      manualWrap.style.display = 'none';
    };

    new Setting(body).setName('选择模型')
      .setDesc('点「获取模型」拉列表后在这里选；想自己填就选「✑ 手动输入…」')
      .addDropdown((d) => {
        opts.forEach((o) => d.addOption(o.v, o.t));
        d.setValue(p.model && opts.some((o) => o.v === p.model) ? p.model : '');
        d.onChange(async (v) => {
          if (v === '__manual__') { showManual(); return; }
          p.model = v;
          await plug.saveSettings();
          refresh();
          hideManual();
        });
      })
      .addButton((b) => b.setButtonText('获取模型').onClick(async () => {
        b.setButtonText('获取中…'); b.setDisabled(true);
        try {
          const ids = await fetchModels(p);
          plug._modelCache[p.id] = ids;
          tab.display();          /* 重渲染，下拉里就带上列表了 */
          new Notice('Hadesr AI：拉到 ' + ids.length + ' 个模型，在上面的下拉里选');
        } catch (e) {
          new Notice('Hadesr AI：取模型失败 —— ' + String((e && e.message) || e), 12000);
        } finally {
          b.setButtonText('获取模型'); b.setDisabled(false);
        }
      }));

    /* 手输框容器：紧跟「选择模型」这一行下面先建好（平时隐藏）。
       ⚠ 不能等到点了才建 —— 后建的元素会 append 到 body 末尾，跑到「删除」下面去。 */
    manualWrap = body.createDiv({ cls: 'obai-manual-wrap' });
    manualWrap.style.display = 'none';

    /* 还没有列表时，直接把手输框摆出来（不然没地方填） */
    if (!cached.length) showManual();
    else hideManual();

    /* 测试连接：分两步，模型没填也能先验证「地址 + Key」 */
    new Setting(body).setName('测试连接')
      .setDesc('分两步查：**① 地址 + Key 通不通**（不需要模型）→ **② 模型能不能用**（需要模型）。哪一步红了就知道问题在哪')
      .addButton((b) => b.setButtonText('测试').onClick(async () => {
        b.setButtonText('测试中…'); b.setDisabled(true);
        try {
          const lines = await testProvider(p);
          new DiagModal(plug.app, '接口诊断 · ' + (p.name || '未命名'), [{ lines: lines }]).open();
        } catch (e) {
          new Notice('Hadesr AI：测试本身出错 —— ' + String((e && e.message) || e), 10000);
        } finally {
          b.setButtonText('测试'); b.setDisabled(false);
        }
      }));

    /* 删除这个接口 */
    new Setting(body).setName('删除这个接口').setDesc('从列表里移除（不影响其他接口）')
      .addButton((b) => {
        b.setButtonText('删除').setWarning();
        let armed = false;
        b.onClick(async () => {
          if (!armed) {
            armed = true;
            b.setButtonText('确认删除？');
            setTimeout(() => { armed = false; b.setButtonText('删除'); }, 4000);
            return;
          }
          s.providers = s.providers.filter((x) => x.id !== p.id);
          if (s.activeProvider === p.id && s.providers.length) s.activeProvider = s.providers[0].id;
          delete plug._modelCache[p.id];
          await plug.saveSettings();
          tab.display();
          new Notice('Hadesr AI：已删除「' + (p.name || '未命名') + '」');
        });
      });

  }
}
