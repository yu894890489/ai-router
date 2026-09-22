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
</style>
</head>
<body>
<h1>ai-router · 会话切换器</h1>
<div class="sub">最近 5 个活跃会话 · 钉住优先，规则链兜底 · <span id="now"></span></div>
<div id="keybox" style="display:none">
  <div>输入 accessKey（config.yaml 中 accessKeys 的任一 Key）</div>
  <input id="key" type="password" placeholder="sk-..." />
  <button onclick="saveKey()">进入</button>
  <div id="err"></div>
</div>
<table id="tbl" style="display:none">
  <thead><tr>
    <th>会话</th><th>项目</th><th>当前模型</th><th>最近 token</th><th>活跃时间</th><th>切换模型</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
let KEY = localStorage.getItem('ai-router-key') || '';
let MODELS = [], THRESH = 0.85, timer = null;

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

  return tr;
}

async function load() {
  if (!KEY) { showKey(''); return; }
  try {
    const m = await api('/admin/api/models');
    MODELS = m.models; THRESH = m.thresholdRatio;
    const s = await api('/admin/api/sessions?limit=5');
    document.getElementById('keybox').style.display = 'none';
    document.getElementById('tbl').style.display = 'table';
    document.getElementById('now').textContent = fmtTs(new Date().toISOString());
    const rows = document.getElementById('rows');
    rows.innerHTML = '';
    for (const it of s.sessions) rows.appendChild(buildRow(it));
    if (s.sessions.length === 0) {
      rows.innerHTML = '<tr><td colspan="6" class="muted">还没有会话记录。用 Claude Code 发一条消息后再来。</td></tr>';
    }
    if (!timer) timer = setInterval(load, 15000); // 登录成功后才轮询
  } catch (e) { /* 401 已处理 */ }
}

if (!KEY) showKey(''); else load();
</script>
</body>
</html>`;
