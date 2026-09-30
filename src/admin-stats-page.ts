export const ADMIN_STATS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ai-router · 统计看板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0f1115; color: #e6e6e6;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b8f98; margin-bottom: 16px; }
  a.navlink { color: #3b82f6; text-decoration: none; }
  /* 筛选行：一行置顶，作用域覆盖下方全部内容 */
  #filters { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; }
  #filters label { color: #8b8f98; }
  select { background: #1a1e26; color: #e6e6e6; border: 1px solid #333a47; border-radius: 6px; padding: 6px 8px; }
  /* 指标瓦片 */
  #tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
  .tile { flex: 1 1 160px; background: #1a1e26; border-radius: 10px; padding: 14px 16px; }
  .tile .tlabel { color: #8b8f98; font-size: 13px; }
  .tile .tvalue { font-size: 26px; font-weight: 600; margin-top: 2px; }
  .tile .tmeta { color: #8b8f98; font-size: 12px; margin-top: 2px; }
  /* 卡片 */
  .card { background: #1a1e26; border-radius: 10px; padding: 16px; margin-bottom: 18px; }
  .card h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
  .card .hint { color: #8b8f98; font-size: 12px; font-weight: 400; margin-left: 8px; }
  .muted { color: #8b8f98; }
  #err { color: #f87171; }
  /* 图例 */
  .legend { display: flex; gap: 16px; margin-bottom: 10px; font-size: 12px; color: #8b8f98; }
  .legend .key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  /* 每日堆叠柱 */
  #dailyWrap { overflow-x: auto; }
  #dailyChart { position: relative; height: 200px; min-width: 100%; }
  .gridline { position: absolute; left: 0; right: 0; height: 1px; background: rgba(255,255,255,0.08); }
  .gridlabel { position: absolute; right: 4px; transform: translateY(-50%); color: #8b8f98; font-size: 11px;
               background: #1a1e26; padding: 0 4px; font-variant-numeric: tabular-nums; }
  #dailyBands { position: absolute; inset: 0; display: flex; align-items: flex-end; }
  .band { flex: 1 1 0; min-width: 14px; height: 100%; display: flex; align-items: flex-end; justify-content: center; outline: none; }
  .band:focus .col, .band:hover .col { filter: brightness(1.2); }
  .col { width: 24px; display: flex; flex-direction: column-reverse; justify-content: flex-start; height: 100%; }
  .seg-in { background: #3987e5; }
  .seg-out { background: #d95926; }
  .colgap { height: 2px; } /* 表面色间隔：堆叠段之间 */
  #dailyX { display: flex; margin-top: 6px; }
  #dailyX .xl { flex: 1 1 0; min-width: 14px; text-align: center; color: #8b8f98; font-size: 11px; white-space: nowrap; }
  /* 横向条形 */
  .bar-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; border-radius: 6px; outline: none; }
  .bar-row:hover, .bar-row:focus { background: rgba(255,255,255,0.04); }
  .bar-label { flex: 0 0 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
  .bar-label .k { font-family: ui-monospace, monospace; font-size: 12px; }
  .bar-track { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .bar-fill { height: 16px; background: #3987e5; border-radius: 0 4px 4px 0; min-width: 2px; }
  .bar-value { color: #8b8f98; font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* 表格 */
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.07); vertical-align: top; }
  th { color: #8b8f98; font-weight: 500; white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .ttl { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sid { color: #8b8f98; font-family: ui-monospace, monospace; font-size: 12px; }
  /* 悬浮提示 */
  #tip { position: fixed; display: none; background: #232836; border: 1px solid #333a47; border-radius: 8px;
         padding: 8px 10px; font-size: 12px; pointer-events: none; z-index: 10; max-width: 320px; }
  #tip .tt { color: #8b8f98; margin-bottom: 4px; }
  #tip .row { display: flex; align-items: center; gap: 6px; }
  #tip .row .key { display: inline-block; width: 10px; height: 2px; border-radius: 1px; }
  #tip .row .v { font-weight: 600; font-variant-numeric: tabular-nums; }
  #tip .row .n { color: #8b8f98; }
  #keybox { margin: 40px auto; max-width: 420px; background: #1a1e26; padding: 24px; border-radius: 10px; }
  #keybox input { width: 100%; padding: 8px; margin: 8px 0; background: #0f1115; color: #e6e6e6;
                  border: 1px solid #333a47; border-radius: 6px; }
  #keybox button { padding: 8px 16px; background: #3b82f6; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
</style>
</head>
<body>
<h1>ai-router · 统计看板</h1>
<div class="sub"><a class="navlink" href="/admin">← 会话切换器</a></div>
<div id="keybox" style="display:none">
  <div>输入 accessKey（config.yaml 中 accessKeys 的任一 Key）</div>
  <input id="key" type="password" placeholder="sk-..." />
  <button onclick="saveKey()">进入</button>
  <div id="err"></div>
</div>
<div id="board" style="display:none">
  <div id="filters">
    <label for="range">时间范围</label>
    <select id="range">
      <option value="7">最近 7 天</option>
      <option value="30" selected>最近 30 天</option>
      <option value="0">全部</option>
    </select>
    <span class="muted" id="generated"></span>
  </div>

  <div id="tiles"></div>

  <div class="card">
    <h2>每日 tokens<span class="hint">按本地时区日期</span></h2>
    <div class="legend">
      <span><span class="key" style="background:#3987e5"></span>输入 tokens</span>
      <span><span class="key" style="background:#d95926"></span>输出 tokens</span>
    </div>
    <div id="dailyWrap">
      <div id="dailyChart">
        <div id="dailyBands"></div>
      </div>
      <div id="dailyX"></div>
    </div>
  </div>

  <div class="card">
    <h2>按厂商<span class="hint">总 tokens = 输入 + 输出</span></h2>
    <div id="byProvider"></div>
  </div>
  <div class="card">
    <h2>按模型（上游）</h2>
    <div id="byModel"></div>
  </div>
  <div class="card">
    <h2>按项目</h2>
    <div id="byProject"></div>
  </div>
  <div class="card">
    <h2>会话 Top 20<span class="hint">按总 tokens</span></h2>
    <div id="bySession"></div>
  </div>
</div>
<div id="tip"></div>
<script>
let KEY = localStorage.getItem('ai-router-key') || '';

function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}
function full(n) { return Number(n || 0).toLocaleString('zh-CN'); }

async function api(path) {
  const res = await fetch(path, { headers: { 'x-api-key': KEY } });
  if (res.status === 401) { showKey('Key 无效，请重新输入'); throw new Error('401'); }
  return res.json();
}

function showKey(msg) {
  document.getElementById('keybox').style.display = 'block';
  document.getElementById('board').style.display = 'none';
  document.getElementById('err').textContent = msg || '';
}
function saveKey() {
  KEY = document.getElementById('key').value.trim();
  localStorage.setItem('ai-router-key', KEY);
  load();
}

/* ---- 悬浮提示：textContent 渲染，value 强、label 弱 ---- */
const tip = document.getElementById('tip');
function tipShow(evt, title, rows) {
  tip.textContent = '';
  const t = document.createElement('div');
  t.className = 'tt';
  t.textContent = title;
  tip.appendChild(t);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    if (r.color) {
      const k = document.createElement('span');
      k.className = 'key';
      k.style.background = r.color;
      row.appendChild(k);
    }
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = r.value;
    row.appendChild(v);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = r.name;
    row.appendChild(n);
    tip.appendChild(row);
  }
  tip.style.display = 'block';
  tipMove(evt);
}
function tipMove(evt) {
  const pad = 12;
  const x = Math.min(evt.clientX + pad, window.innerWidth - tip.offsetWidth - pad);
  const y = Math.min(evt.clientY + pad, window.innerHeight - tip.offsetHeight - pad);
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function tipHide() { tip.style.display = 'none'; }

/* ---- 指标瓦片 ---- */
function renderTiles(totals) {
  const box = document.getElementById('tiles');
  box.textContent = '';
  const defs = [
    { label: '请求数', value: full(totals.requests) },
    { label: '错误数', value: full(totals.errors) },
    { label: '输入 tokens', value: compact(totals.inputTokens), meta: full(totals.inputTokens) },
    { label: '输出 tokens', value: compact(totals.outputTokens), meta: full(totals.outputTokens) },
  ];
  for (const d of defs) {
    const t = document.createElement('div');
    t.className = 'tile';
    const l = document.createElement('div');
    l.className = 'tlabel';
    l.textContent = d.label;
    const v = document.createElement('div');
    v.className = 'tvalue';
    v.textContent = d.value;
    t.append(l, v);
    if (d.meta) {
      const m = document.createElement('div');
      m.className = 'tmeta';
      m.textContent = d.meta;
      t.appendChild(m);
    }
    box.appendChild(t);
  }
}

/* ---- 每日堆叠柱（输入下、输出上；柱宽 24px；段间 2px 表面色间隔；顶端 4px 圆角）---- */
function renderDaily(daily) {
  const chart = document.getElementById('dailyChart');
  const bands = document.getElementById('dailyBands');
  const xAxis = document.getElementById('dailyX');
  chart.querySelectorAll('.gridline, .gridlabel').forEach((el) => el.remove());
  bands.textContent = '';
  xAxis.textContent = '';
  if (daily.length === 0) {
    bands.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: '该时间范围内没有请求。' }));
    return;
  }
  // 零值日期补齐，趋势不失真
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const days = [];
  const first = new Date(daily[0].date + 'T00:00:00');
  const last = new Date(daily[daily.length - 1].date + 'T00:00:00');
  for (let dt = new Date(first); dt <= last; dt.setDate(dt.getDate() + 1)) {
    const key = dt.toLocaleDateString('sv-SE');
    days.push(byDate.get(key) || { date: key, requests: 0, inputTokens: 0, outputTokens: 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  // 纵轴取整到干净的刻度
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const niceMax = Math.ceil(max / step) * step;
  for (const frac of [1, 0.5]) {
    const y = niceMax * frac;
    const line = document.createElement('div');
    line.className = 'gridline';
    line.style.bottom = (frac * 100) + '%';
    const lab = document.createElement('div');
    lab.className = 'gridlabel';
    lab.style.bottom = (frac * 100) + '%';
    lab.textContent = compact(y);
    chart.append(line, lab);
  }
  const zero = document.createElement('div');
  zero.className = 'gridlabel';
  zero.style.bottom = '0';
  zero.textContent = '0';
  chart.appendChild(zero);

  const labelEvery = Math.max(1, Math.ceil(days.length / 8));
  days.forEach((d, i) => {
    const total = d.inputTokens + d.outputTokens;
    const band = document.createElement('div');
    band.className = 'band';
    band.tabIndex = 0;
    const col = document.createElement('div');
    col.className = 'col';
    // 自下而上：输入（蓝）、2px 间隔、输出（橙）；顶端段 4px 圆角
    const inH = (d.inputTokens / niceMax) * 100;
    const outH = (d.outputTokens / niceMax) * 100;
    if (d.inputTokens > 0) {
      const segIn = document.createElement('div');
      segIn.className = 'seg-in';
      segIn.style.height = inH + '%';
      col.appendChild(segIn);
    }
    if (d.inputTokens > 0 && d.outputTokens > 0) {
      col.appendChild(Object.assign(document.createElement('div'), { className: 'colgap' }));
    }
    if (d.outputTokens > 0) {
      const segOut = document.createElement('div');
      segOut.className = 'seg-out';
      segOut.style.height = outH + '%';
      segOut.style.borderRadius = '4px 4px 0 0';
      col.appendChild(segOut);
    }
    if (d.outputTokens === 0 && d.inputTokens > 0) {
      col.children[0].style.borderRadius = '4px 4px 0 0';
    }
    band.appendChild(col);
    const rows = [
      { color: '#3987e5', value: full(d.inputTokens), name: '输入 tokens' },
      { color: '#d95926', value: full(d.outputTokens), name: '输出 tokens' },
      { value: full(total), name: '合计' },
      { value: full(d.requests), name: '请求数' },
    ];
    const show = (e) => tipShow(e, d.date, rows);
    band.addEventListener('pointermove', show);
    band.addEventListener('pointerleave', tipHide);
    band.addEventListener('focus', (e) => tipShow({ clientX: band.getBoundingClientRect().left, clientY: band.getBoundingClientRect().top }, d.date, rows));
    band.addEventListener('blur', tipHide);
    bands.appendChild(band);

    const xl = document.createElement('div');
    xl.className = 'xl';
    xl.textContent = i % labelEvery === 0 || i === days.length - 1 ? d.date.slice(5) : '';
    xAxis.appendChild(xl);
  });
}

/* ---- 横向条形：单色度量蓝，值标在条尾，悬停给明细 ---- */
function renderBars(elId, rows) {
  const box = document.getElementById(elId);
  box.textContent = '';
  if (rows.length === 0) {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: '没有数据。' }));
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.inputTokens + r.outputTokens));
  for (const r of rows) {
    const total = r.inputTokens + r.outputTokens;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.tabIndex = 0;
    const label = document.createElement('div');
    label.className = 'bar-label';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = r.key;
    label.appendChild(k);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = Math.max(0.5, (total / max) * 100) + '%';
    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = compact(total);
    track.append(fill, value);
    row.append(label, track);
    const tipRows = [
      { value: full(r.inputTokens), name: '输入 tokens' },
      { value: full(r.outputTokens), name: '输出 tokens' },
      { value: full(total), name: '合计 tokens' },
      { value: full(r.requests), name: '请求数' },
      { value: full(r.errors), name: '错误数' },
    ];
    const show = (e) => tipShow(e, r.key, tipRows);
    row.addEventListener('pointermove', show);
    row.addEventListener('pointerleave', tipHide);
    row.addEventListener('focus', (e) => tipShow({ clientX: row.getBoundingClientRect().left, clientY: row.getBoundingClientRect().top }, r.key, tipRows));
    row.addEventListener('blur', tipHide);
    box.appendChild(row);
  }
}

/* ---- 会话表格 ---- */
function renderSessions(rows) {
  const box = document.getElementById('bySession');
  box.textContent = '';
  if (rows.length === 0) {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: '没有数据。' }));
    return;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['会话', '标题', '项目', '请求数', '错误数', '输入', '输出', '合计']) {
    const th = document.createElement('th');
    if (['请求数', '错误数', '输入', '输出', '合计'].includes(h)) th.className = 'num';
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const td = (cls, text) => {
      const c = document.createElement('td');
      if (cls) c.className = cls;
      c.textContent = text;
      return c;
    };
    const sid = document.createElement('td');
    sid.className = 'sid';
    sid.title = r.sessionId;
    sid.textContent = r.sessionId;
    tr.appendChild(sid);
    tr.appendChild(td('ttl', r.title || ''));
    tr.appendChild(td('', r.project || ''));
    tr.appendChild(td('num', full(r.requests)));
    tr.appendChild(td('num', full(r.errors)));
    tr.appendChild(td('num', full(r.inputTokens)));
    tr.appendChild(td('num', full(r.outputTokens)));
    tr.appendChild(td('num', full(r.inputTokens + r.outputTokens)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
}

async function load() {
  if (!KEY) { showKey(''); return; }
  const board = document.getElementById('board');
  try {
    const days = document.getElementById('range').value;
    board.style.opacity = '0.5'; // 重取数据时保持上一帧
    const st = await api('/admin/api/stats?days=' + days);
    document.getElementById('keybox').style.display = 'none';
    board.style.display = 'block';
    document.getElementById('generated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    renderTiles(st.totals);
    renderDaily(st.daily);
    renderBars('byProvider', st.byProvider);
    renderBars('byModel', st.byModel);
    renderBars('byProject', st.byProject);
    renderSessions(st.bySession);
    board.style.opacity = '1';
  } catch (e) { /* 401 已处理 */ board.style.opacity = '1'; }
}

document.getElementById('range').addEventListener('change', load);
if (!KEY) showKey(''); else load();
</script>
</body>
</html>`;
