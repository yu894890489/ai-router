export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ai-router · 会话切换器</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0f1115; color: #e6e6e6;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b8f98; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #262a33; vertical-align: top; }
  th { color: #8b8f98; font-weight: 500; white-space: nowrap; }
  .title { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sid { color: #8b8f98; font-family: ui-monospace, monospace; font-size: 12px; }
  select { background: #1a1e26; color: #e6e6e6; border: 1px solid #333a47; border-radius: 6px; padding: 6px 8px; }
  .warn { color: #f0b429; cursor: help; }
  .cur { font-family: ui-monospace, monospace; font-size: 12px; }
  .muted { color: #8b8f98; }
  #keybox { margin: 40px auto; max-width: 420px; background: #1a1e26; padding: 24px; border-radius: 10px; }
  #keybox input { width: 100%; padding: 8px; margin: 8px 0; background: #0f1115; color: #e6e6e6;
                  border: 1px solid #333a47; border-radius: 6px; }
  #keybox button { padding: 8px 16px; background: #3b82f6; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  #err { color: #f87171; }
  .tag { display: inline-block; background: #1a1e26; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
  #searchbar { margin-bottom: 14px; }
  #searchbar input { width: 100%; max-width: 520px; padding: 8px; background: #1a1e26; color: #e6e6e6;
                     border: 1px solid #333a47; border-radius: 6px; }
  .back { color: #3b82f6; cursor: pointer; margin-bottom: 12px; display: inline-block; }
  .turn { margin-bottom: 14px; }
  .bubble { max-width: 78%; padding: 10px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .b-user { background: #1d3a5f; margin-left: auto; }
  .b-ai { background: #1a1e26; }
  .tmeta { color: #8b8f98; font-size: 12px; margin: 2px 0; }
  .rawbtn { color: #3b82f6; cursor: pointer; font-size: 12px; }
  .raw { background: #0a0c10; border: 1px solid #262a33; border-radius: 6px; padding: 10px;
         font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all;
         max-height: 320px; overflow: auto; display: none; }
  .hit { background: #1a1e26; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; cursor: pointer; }
  .hit:hover { background: #232836; }
  .chatbtn { background: none; border: 1px solid #333a47; color: #e6e6e6; border-radius: 6px;
             padding: 4px 8px; cursor: pointer; }
  .hl { background: #3a3320; }
</style>
</head>
<body>
<h1>ai-router · 会话切换器</h1>
<div class="sub">最近 5 个活跃会话 · 钉住优先，规则链兜底 · <span id="now"></span></div>
<div id="searchbar" style="display:none">
  <input id="q" type="search" placeholder="搜索对话内容，回车搜索" />
</div>
<div id="keybox" style="display:none">
  <div>输入 accessKey（config.yaml 中 accessKeys 的任一 Key）</div>
  <input id="key" type="password" placeholder="sk-..." />
  <button onclick="saveKey()">进入</button>
  <div id="err"></div>
</div>
<table id="tbl" style="display:none">
  <thead><tr>
    <th>会话</th><th>项目</th><th>当前模型</th><th>最近 token</th><th>活跃时间</th><th>切换模型</th><th>对话</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<div id="chat" style="display:none;max-width:860px"></div>
<div id="results" style="display:none;max-width:860px"></div>
<script>
let KEY = localStorage.getItem('ai-router-key') || '';
let MODELS = [], THRESH = 0.85, timer = null, VIEW = 'list';

function fmtTs(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function fmtWindow(n) { return n >= 1000000 ? (n / 1048576).toFixed(0) + 'M' : Math.round(n / 1024) + 'K'; }

async function api(path, opts) {
  opts = opts || {};
  // 深合并 headers：opts.headers 会整体覆盖默认头，必须保留 x-api-key
  const headers = Object.assign({ 'x-api-key': KEY }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers: headers }));
  if (res.status === 401) { showKey('Key 无效，请重新输入'); throw new Error('401'); }
  return res.json();
}

function showKey(msg) {
  if (timer) { clearInterval(timer); timer = null; }
  document.getElementById('keybox').style.display = 'block';
  document.getElementById('tbl').style.display = 'none';
  document.getElementById('err').textContent = msg || '';
}
function saveKey() {
  KEY = document.getElementById('key').value.trim();
  localStorage.setItem('ai-router-key', KEY);
  load();
}

async function switchModel(sid, ref) {
  await api('/admin/api/sessions/' + encodeURIComponent(sid) + '/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: ref || null }),
  });
  load();
}

function cell(cls, text) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

function buildRow(it) {
  const tr = document.createElement('tr');

  const tdSession = document.createElement('td');
  const titleDiv = document.createElement('div');
  titleDiv.className = 'title';
  titleDiv.title = it.title || '';
  titleDiv.textContent = it.title || '（无标题）';
  const sidDiv = document.createElement('div');
  sidDiv.className = 'sid';
  sidDiv.textContent = it.sessionId;
  tdSession.append(titleDiv, sidDiv);
  tr.appendChild(tdSession);

  tr.appendChild(cell('', it.project));

  const tdCur = document.createElement('td');
  tdCur.className = 'cur';
  const curSpan = document.createElement('span');
  if (it.currentRef) { curSpan.className = 'tag'; curSpan.textContent = it.currentRef; }
  else { curSpan.className = 'muted'; curSpan.textContent = '跟随规则'; }
  tdCur.appendChild(curSpan);
  tr.appendChild(tdCur);

  tr.appendChild(cell('', it.lastTokens.toLocaleString()));
  tr.appendChild(cell('muted', fmtTs(it.lastSeen)));

  const tdSwitch = document.createElement('td');
  const select = document.createElement('select');
  select.dataset.sid = it.sessionId;
  const optFollow = document.createElement('option');
  optFollow.value = '';
  optFollow.textContent = '跟随规则';
  select.appendChild(optFollow);
  for (const mo of MODELS) {
    const opt = document.createElement('option');
    opt.value = mo.ref;
    opt.textContent = mo.ref + ' · ' + fmtWindow(mo.contextWindow) +
      (it.lastTokens > mo.contextWindow * THRESH ? ' ⚠️' : '');
    if (it.overrideRef === mo.ref) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', function () { switchModel(this.dataset.sid, this.value); });
  const warn = document.createElement('span');
  warn.className = 'warn';
  warn.title = '带 ⚠️ 的选项：该会话 token 量超过目标窗口触发线，切换后将自动压缩历史';
  warn.textContent = '?';
  tdSwitch.append(select, document.createTextNode(' '), warn);
  tr.appendChild(tdSwitch);

  const tdChat = document.createElement('td');
  const chatBtn = document.createElement('button');
  chatBtn.className = 'chatbtn';
  chatBtn.textContent = '💬 对话';
  chatBtn.addEventListener('click', () => openChat(it.sessionId, it.title || '（无标题）'));
  tdChat.appendChild(chatBtn);
  tr.appendChild(tdChat);

  return tr;
}

async function load() {
  if (!KEY) { showKey(''); return; }
  try {
    const m = await api('/admin/api/models');
    MODELS = m.models; THRESH = m.thresholdRatio;
    const s = await api('/admin/api/sessions?limit=5');
    document.getElementById('keybox').style.display = 'none';
    document.getElementById('now').textContent = fmtTs(new Date().toISOString());
    if (VIEW !== 'list') return; // 聊天/搜索视图不被轮询打断，也不显示会话表格
    document.getElementById('tbl').style.display = 'table';
    document.getElementById('searchbar').style.display = 'block';
    const rows = document.getElementById('rows');
    rows.innerHTML='';
    for (const it of s.sessions) rows.appendChild(buildRow(it));
    if (s.sessions.length === 0) {
      rows.innerHTML='<tr><td colspan="7" class="muted">还没有会话记录。用 Claude Code 发一条消息后再来。</td></tr>';
    }
    if (!timer) timer = setInterval(load, 15000); // 登录成功后才轮询
  } catch (e) { /* 401 已处理 */ }
}

function showView(name) {
  VIEW = name;
  document.getElementById('tbl').style.display = name === 'list' ? 'table' : 'none';
  document.getElementById('chat').style.display = name === 'chat' ? 'block' : 'none';
  document.getElementById('results').style.display = name === 'results' ? 'block' : 'none';
}

async function openChat(sid, title) {
  location.hash = '#chat=' + encodeURIComponent(sid);
  showView('chat');
  const box = document.getElementById('chat');
  box.textContent = '';
  const back = document.createElement('div');
  back.className = 'back';
  back.textContent = '← 返回会话列表';
  back.addEventListener('click', () => { location.hash = ''; showView('list'); load(); });
  const h = document.createElement('h1');
  h.textContent = title;
  const sidDiv = document.createElement('div');
  sidDiv.className = 'sub';
  sidDiv.textContent = sid;
  box.append(back, h, sidDiv);

  const data = await api('/admin/api/sessions/' + encodeURIComponent(sid) + '/turns');
  if (data.turns.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '该会话还没有轮次记录（功能上线前的历史不回填）。';
    box.appendChild(empty);
    return;
  }
  for (const t of data.turns) box.appendChild(buildTurn(t));
}

function buildTurn(t) {
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  wrap.dataset.seq = String(t.seq);

  const um = document.createElement('div');
  um.className = 'tmeta';
  um.textContent = '用户 · ' + fmtTs(t.createdAt);
  const ub = document.createElement('div');
  ub.className = 'bubble b-user';
  ub.textContent = t.userText || '（空）';
  wrap.append(um, ub);

  const am = document.createElement('div');
  am.className = 'tmeta';
  am.textContent = 'AI';
  const ab = document.createElement('div');
  ab.className = 'bubble b-ai';
  ab.textContent = t.assistantText || '（无回复或请求失败）';
  wrap.append(am, ab);

  const rawBtn = document.createElement('span');
  rawBtn.className = 'rawbtn';
  rawBtn.textContent = '▸ 原始报文';
  const raw = document.createElement('pre');
  raw.className = 'raw';
  let loaded = false;
  rawBtn.addEventListener('click', async () => {
    if (!loaded) {
      loaded = true;
      const b = await api('/admin/api/requests/' + encodeURIComponent(t.requestId) + '/body');
      raw.textContent = JSON.stringify(b, null, 2);
    }
    const show = raw.style.display !== 'block';
    raw.style.display = show ? 'block' : 'none';
    rawBtn.textContent = (show ? '▾' : '▸') + ' 原始报文';
  });
  wrap.append(rawBtn, raw);
  return wrap;
}

async function doSearch() {
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const data = await api('/admin/api/search?q=' + encodeURIComponent(q));
  location.hash = '';
  showView('results');
  const box = document.getElementById('results');
  box.textContent = '';
  const back = document.createElement('div');
  back.className = 'back';
  back.textContent = '← 返回会话列表';
  back.addEventListener('click', () => { showView('list'); load(); });
  const h = document.createElement('h1');
  h.textContent = '搜索：' + q;
  box.append(back, h);
  if (data.hits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '没有命中。';
    box.appendChild(empty);
    return;
  }
  for (const hit of data.hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    const title = document.createElement('div');
    title.textContent = (hit.sessionTitle || hit.sessionId) + ' · 第 ' + hit.seq + ' 轮';
    const snip = document.createElement('div');
    snip.className = 'muted';
    snip.textContent = hit.snippet; // FTS 高亮标记为纯文本【】，textContent 渲染无注入面
    const ts = document.createElement('div');
    ts.className = 'tmeta';
    ts.textContent = fmtTs(hit.createdAt);
    div.append(title, snip, ts);
    div.addEventListener('click', () => openChat(hit.sessionId, hit.sessionTitle || hit.sessionId));
    box.appendChild(div);
  }
}

document.getElementById('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

if (!KEY) showKey(''); else load();

// 刷新保持聊天视图：#chat=<sessionId>
if (KEY && location.hash.startsWith('#chat=')) {
  const sid = decodeURIComponent(location.hash.slice(6));
  openChat(sid, sid);
}
</script>
</body>
</html>`;
