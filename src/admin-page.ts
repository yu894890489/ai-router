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
let MODELS = [], THRESH = 0.85;

function fmtTs(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function fmtWindow(n) { return n >= 1000000 ? (n / 1048576).toFixed(0) + 'M' : Math.round(n / 1024) + 'K'; }

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'x-api-key': KEY } }, opts || {}));
  if (res.status === 401) { showKey('Key 无效，请重新输入'); throw new Error('401'); }
  return res.json();
}

function showKey(msg) {
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

async function load() {
  try {
    const m = await api('/admin/api/models');
    MODELS = m.models; THRESH = m.thresholdRatio;
    const s = await api('/admin/api/sessions?limit=5');
    document.getElementById('keybox').style.display = 'none';
    document.getElementById('tbl').style.display = 'table';
    document.getElementById('now').textContent = fmtTs(new Date().toISOString());
    const rows = document.getElementById('rows');
    rows.innerHTML = '';
    for (const it of s.sessions) {
      const tr = document.createElement('tr');
      const opts = ['<option value="">跟随规则</option>'].concat(MODELS.map(function (mo) {
        const sel = it.overrideRef === mo.ref ? ' selected' : '';
        const warn = it.lastTokens > mo.contextWindow * THRESH ? ' ⚠️' : '';
        return '<option value="' + mo.ref + '"' + sel + '>' + mo.ref + ' · ' + fmtWindow(mo.contextWindow) + warn + '</option>';
      })).join('');
      const cur = it.currentRef ? '<span class="tag">' + it.currentRef + '</span>' : '<span class="muted">跟随规则</span>';
      tr.innerHTML =
        '<td><div class="title" title="' + (it.title || '').replace(/"/g, '&quot;') + '">' + (it.title || '（无标题）') + '</div>' +
        '<div class="sid">' + it.sessionId + '</div></td>' +
        '<td>' + it.project + '</td>' +
        '<td class="cur">' + cur + '</td>' +
        '<td>' + it.lastTokens.toLocaleString() + '</td>' +
        '<td class="muted">' + fmtTs(it.lastSeen) + '</td>' +
        '<td><select onchange="switchModel(\\'' + it.sessionId + '\\', this.value)">' + opts + '</select> ' +
        '<span class="warn" title="带 ⚠️ 的选项：该会话 token 量超过目标窗口触发线，切换后将自动压缩历史">?</span></td>';
      rows.appendChild(tr);
    }
    if (s.sessions.length === 0) {
      rows.innerHTML = '<tr><td colspan="6" class="muted">还没有会话记录。用 Claude Code 发一条消息后再来。</td></tr>';
    }
  } catch (e) { /* 401 已处理 */ }
}

document.getElementById('now').textContent = fmtTs(new Date().toISOString());
if (!KEY) showKey(''); else load();
setInterval(load, 15000);
</script>
</body>
</html>`;
