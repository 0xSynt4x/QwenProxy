/* 号池看板 —— /pool.html 的逻辑。只读 /api/pool，无状态、可反复跑。 */

'use strict';

const REFRESH_MS = 5000;

const $ = (sel) => document.querySelector(sel);

let latest = null;
let timer = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  if (!ts) return '从未';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtCountdown(ms) {
  if (!ms || ms <= 0) return '';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} 分钟后`;
  const h = Math.floor(min / 60);
  return `${h} 小时 ${min % 60} 分后`;
}

function fmtReset(ts) {
  if (!ts) return '明日零点';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

/* ---------------- 汇总卡片 ---------------- */

function renderSummary(s) {
  $('#c-total').textContent = s.total;
  $('#c-total-hint').textContent = `有登录态 ${s.withToken} 个`;
  $('#c-available').textContent = s.available;
  $('#c-available-hint').textContent = s.total ? `占 ${Math.round((s.available / s.total) * 100)}%` : '';
  $('#c-used').textContent = s.usedTotal;
  $('#c-used-hint').textContent = `总配额 ${s.capacityTotal}（约 ${Math.floor(s.capacityTotal / s.dailyLimit) || 0} 个号 × ${s.dailyLimit}）`;
  $('#c-dead').textContent = `${s.exhausted} / ${s.cooling}`;
  $('#c-dead-hint').textContent = s.nextResetAt ? `打光的号 ${fmtCountdown(s.nextResetAt - s.now)} 全部恢复` : '今天没有号被打光';
  $('#limit-note').textContent = s.dailyLimit;

  const parts = [`共 ${s.total} 个号`];
  if (s.activeId) parts.push(`当前在用 ${s.activeId}`);
  if (s.off) parts.push(`${s.off} 个没有登录态`);
  $('#sub').textContent = parts.join(' · ');
}

/* ---------------- 模型配额 ---------------- */

function renderModels(s) {
  const box = $('#models');
  box.innerHTML = '';
  for (const m of s.models) {
    const row = document.createElement('div');
    row.className = 'model-row' + (m.pct >= 80 ? ' full' : '');
    const label = m.capacity ? `${m.used}/${m.capacity}` : '号池为空';
    const extra = m.fullCount ? ` · ${m.fullCount} 个号已打光` : '';
    row.innerHTML =
      `<span class="name" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>` +
      `<span class="bar"><i style="width:${m.pct}%"></i></span>` +
      `<span class="nums"><b>${label}</b>（${m.pct}%）${extra}</span>`;
    box.appendChild(row);
  }
}

/* ---------------- 账号明细 ---------------- */

function modelChips(a, limit) {
  const keys = Object.keys(a.counts || {}).filter((k) => k !== '_total');
  const dead = new Set((a.exhaustedModels || []).map((e) => e.model));
  const full = new Set(a.fullModels || []);
  if (!keys.length) return '<span class="none">今天还没用过</span>';
  return keys
    .map((k) => {
      const cls = dead.has(k) ? 'exhausted' : full.has(k) ? 'full' : '';
      return `<span class="chip ${cls}">${escapeHtml(k)}×${a.counts[k]}</span>`;
    })
    .join('');
}

function statusTag(a) {
  const map = {
    active: ['tag-active', '正在使用'],
    idle: ['tag-idle', '待命'],
    exhausted: ['tag-exhausted', '已打光'],
    cooling: ['tag-cooling', '冷却中'],
    off: ['tag-off', '无登录态'],
  };
  const [cls, text] = map[a.status] || map.idle;
  let title = '';
  if (a.status === 'exhausted' && a.exhaustedModels.length) {
    title = ` ${a.exhaustedModels.map((e) => e.model).join('、')} 打光`;
  }
  if (a.status === 'cooling') {
    title = `还需 ${fmtCountdown(a.coolingMs)}`;
    if (a.lastError) title += `（最近错误：${a.lastError.slice(0, 40)}）`;
  }
  return `<span class="tag ${cls}" title="${escapeHtml(title)}">${text}</span>`;
}

function renderRows(s) {
  const q = ($('#filter').value || '').trim().toLowerCase();
  const onlyUsed = $('#only-used').checked;
  const onlyBad = $('#only-bad').checked;

  let rows = s.accounts.slice();
  if (q) {
    rows = rows.filter((a) => (a.id || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q));
  }
  if (onlyUsed) rows = rows.filter((a) => a.used > 0);
  if (onlyBad) {
    rows = rows.filter((a) => a.status === 'exhausted' || a.status === 'cooling' || a.status === 'off' || a.failures > 0);
  }
  // 默认先把「正在用 + 今天用得多」的排在前面，打光的沉底
  rows.sort((a, b) => {
    const rank = (x) => (x.active ? 0 : x.status === 'idle' ? 1 : x.status === 'exhausted' ? 3 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.used - a.used;
  });

  const body = $('#rows');
  body.innerHTML = '';
  $('#acct-count').textContent = `${rows.length} / ${s.total}`;
  $('#empty').hidden = s.total !== 0;
  if (s.total === 0) return;

  for (const a of rows) {
    const tr = document.createElement('tr');
    if (a.active) tr.className = 'row-active';
    const pct = Math.min(100, Math.round((a.used / s.dailyLimit) * 100));
    const barCls = pct >= 90 ? 'dead' : pct >= 70 ? 'hot' : '';
    tr.innerHTML =
      `<td class="col-id">${escapeHtml(a.id)}${a.email ? `<span class="email">${escapeHtml(a.email)}</span>` : ''}</td>` +
      `<td>${statusTag(a)}</td>` +
      `<td class="col-num">${a.used}<span class="bar-mini ${barCls}"><i style="width:${pct}%"></i></span></td>` +
      `<td><div class="chips">${modelChips(a, s.dailyLimit)}</div></td>` +
      `<td class="col-time">${fmtTime(a.lastUsedAt)}</td>`;
    body.appendChild(tr);
  }
}

/* ---------------- 拉取 ---------------- */

async function load() {
  try {
    const res = await fetch('/api/pool', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latest = data;
    renderSummary(data);
    renderModels(data);
    renderRows(data);
    $('#live-dot').classList.remove('stale');
    $('#updated').textContent = `更新于 ${fmtTime(data.now)}`;
  } catch (err) {
    $('#live-dot').classList.add('stale');
    $('#sub').textContent = `读不到 /api/pool：${err.message}（服务没起？）`;
  }
}

function init() {
  $('#filter').addEventListener('input', () => latest && renderRows(latest));
  $('#only-used').addEventListener('change', () => latest && renderRows(latest));
  $('#only-bad').addEventListener('change', () => latest && renderRows(latest));
  // 页面切到后台时停轮询，回来立刻补一次
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(timer);
      timer = null;
    } else if (!timer) {
      load();
      timer = setInterval(load, REFRESH_MS);
    }
  });
  load();
  timer = setInterval(load, REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', init);
