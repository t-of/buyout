// 画面と操作。遊びの中身は game.js にある。
import {
  COMPANIES, byId, QUARTER_MS, YEAR_DAYS, DAY_MS, DIV_UNIT,
  price, change, newsBefore, newsEffect, gameDay,
  newState, advance, nextDividend, totals, held, boughtOut, boughtOutCount, perQuarter,
  buyable, buy, sell, halfOf, rescue, serialize, deserialize, fmtNum, fmtYen,
} from './game.js';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'buyout.' で始める。
const STORE = 'buyout.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'BUYOUT', text: '架空の会社の株を売り買いして、配当で資産を増やす放置ゲーム（架空の相場ゲーム）。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

const $ = (id) => document.getElementById(id);
const titleEl = $('title'), playEl = $('play');

// ---- 保存 ----
// 読めないときは消さずに buyout.save.broken に写してから新しく始める
let brokenSave = false;
function loadState() {
  let raw = null;
  try { raw = localStorage.getItem(STORE + 'save'); } catch { /* 読めない */ }
  if (raw == null) return newState(Date.now());
  try { return deserialize(JSON.parse(raw)); } catch {
    try { localStorage.setItem(STORE + 'save.broken', raw); } catch { /* 写せない */ }
    brokenSave = true;
    return newState(Date.now());
  }
}
const state = loadState();
const store = () => save('save', serialize(state));
let settings = { v: 1, sound: (load('settings', {}) || {}).sound !== false };

// ---- 効果音（Web Audio で作る。音声ファイルは使わない） ----
// iPhone のマナーモードでも鳴らす（Safari 16.4 以降）。
// 'playback' にすると音楽アプリの曲が止まるので、アプリの音がオンのときだけにする。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
const Sound = {
  ctx: null, out: null,
  // 最初に触ったときに呼ぶ（ブラウザは触る前の音を止める）。裏に回っている間は鳴らさない
  ensure() {
    if (!settings.sound || document.hidden) return null;
    if (!this.ctx || this.ctx.state === 'suspended') setAudioSession(true);
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.6;   // 全体を控えめに
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  tone(freq, dur, { type = 'sine', gain = 0.08, at = 0 } = {}) {
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime + at;
    const o = c.createOscillator(), v = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(v).connect(this.out);
    o.start(t); o.stop(t + dur + 0.05);
  },
  notes(fs, step, dur, type = 'triangle', gain = 0.07) { fs.forEach((f, i) => this.tone(f, dur, { type, gain, at: i * step })); },
  tap() { this.tone(1800, 0.025, { type: 'square', gain: 0.015 }); },
  buy() { this.notes([660, 880], 0.04, 0.05, 'sine', 0.09); },
  sell() { this.notes([880, 660], 0.04, 0.05, 'sine', 0.09); },
  dividend() { this.tone(1047, 0.12, { type: 'triangle', gain: 0.04 }); this.tone(1319, 0.12, { type: 'triangle', gain: 0.03, at: 0.03 }); },
  news() { this.tone(2600, 0.04, { type: 'square', gain: 0.012 }); },
  welcome() { this.notes([523, 659, 784], 0.11, 0.25, 'sine', 0.06); },
  boughtOut() { this.notes([523, 659, 784, 1047], 0.09, 0.2); },
  clear() { this.notes([523, 659, 784, 1047, 784, 1047, 1319], 0.12, 0.3); },
};
setAudioSession(settings.sound);
document.addEventListener('pointerdown', () => Sound.ensure(), { capture: true });

const soundButtons = document.querySelectorAll('[data-sound]');
function renderSound() {
  soundButtons.forEach((b) => {
    b.setAttribute('aria-pressed', settings.sound);
    b.setAttribute('aria-label', settings.sound ? '音をオフにする' : '音をオンにする');
    b.querySelector('span').textContent = settings.sound ? '音 オン' : '音 オフ';
  });
}
soundButtons.forEach((b) => b.addEventListener('click', () => {
  settings = { ...settings, sound: !settings.sound };
  save('settings', settings);
  setAudioSession(settings.sound);
  renderSound();
  Sound.tap();
}));
renderSound();

// ---- 書き方 ----
const yen = (p) => `${p.toLocaleString('ja-JP')} 円`;
const signed = (n) => (n > 0n ? '+' : '') + fmtYen(n);
const pct = (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
// 上げ = 赤系、下げ = 青系。色だけに頼らず ▲▼ も付ける
function setDir(el, x) {
  el.classList.remove('up', 'down');
  if (x > 0) el.classList.add('up'); else if (x < 0) el.classList.add('down');
}
function changeText(c, t) {
  const d = change(c, t), prev = price(c, t) - d;
  return { d, text: `${d > 0 ? '▲' : d < 0 ? '▼' : '±'}${Math.abs(d).toLocaleString('ja-JP')}（${pct((d / prev) * 100)}）` };
}
function ago(e, t) {
  const d = Math.floor(gameDay(t) - e.day);
  return d < 1 ? '今' : `${d}日前`;
}
function duration(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}日${h % 24}時間`;
  if (h) return `${h}時間${m % 60}分`;
  return `${m}分`;
}
function newsList(ul, items, t) {
  if (!items.length) {
    const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'まだありません';
    return ul.replaceChildren(li);
  }
  ul.replaceChildren(...items.map((e) => {
    const li = document.createElement('li');
    const s = document.createElement('span'); s.textContent = e.text;
    const a = document.createElement('small'); a.textContent = ago(e, t);
    li.append(s, a);
    return li;
  }));
}

// ---- チャート（自前の SVG） ----
const series = (c, t, days, n) => Array.from({ length: n + 1 }, (_, i) => price(c, t - (days * (n - i) / n) * DAY_MS));
function linePoints(ps, w, h, pad = 2) {
  const lo = Math.min(...ps), hi = Math.max(...ps), span = hi - lo || 1;
  return ps.map((p, i) => `${(i / (ps.length - 1) * w).toFixed(1)},${(pad + (1 - (p - lo) / span) * (h - pad * 2)).toFixed(1)}`).join(' ');
}

// ---- 会社の一覧（行は一度だけ作り、毎秒は中身だけ書き換える。押している最中に消えないように） ----
const rows = {};
for (const c of COMPANIES) {
  const li = document.createElement('li');
  li.innerHTML = `<button class="row">
    <span class="row__name"><b></b><small></small></span>
    <svg class="spark" viewBox="0 0 60 24" preserveAspectRatio="none" aria-hidden="true"><polyline points=""/></svg>
    <span class="row__px"><b class="num"></b><small class="num"></small></span>
  </button>`;
  const b = li.firstElementChild;
  b.querySelector('.row__name b').textContent = c.name;
  b.addEventListener('click', () => openCompany(c.id));
  $('list').append(li);
  rows[c.id] = { b, sub: b.querySelector('.row__name small'), spark: b.querySelector('svg'), line: b.querySelector('polyline'), px: b.querySelector('.row__px b'), chg: b.querySelector('.row__px small') };
}

function render(t = Date.now()) {
  const tot = totals(state, t);
  $('total').textContent = fmtYen(tot.total);
  $('cash').textContent = fmtYen(state.cash);
  $('pl').textContent = tot.basis ? signed(tot.pl) : '—';
  setDir($('pl'), tot.basis ? Number(tot.pl) : 0);

  const nd = nextDividend(state, t);
  $('divLeft').textContent = Math.ceil(nd.leftMs / 1000);
  $('divYen').textContent = perQuarter(state) ? `見込み +${fmtYen(nd.yen)}` : '株を持つと入る';
  $('divBar').style.width = `${(1 - nd.leftMs / QUARTER_MS) * 100}%`;

  newsList($('news'), newsBefore(t, { max: 2 }), t);

  const bo = boughtOutCount(state);
  $('boCount').textContent = bo ? `買い占め ${bo}/8` : '全 8 社';
  for (const c of COMPANIES) {
    const r = rows[c.id], h = held(state, c.id), all = boughtOut(state, c.id);
    r.sub.textContent = all ? `${c.sector} · 買い占め` : h ? `${c.sector} · ${fmtNum(h)} 株` : c.sector;
    r.b.classList.toggle('row--held', h > 0n);
    r.b.classList.toggle('row--bo', all);
    const ps = series(c, t, 30, 30);
    r.line.setAttribute('points', linePoints(ps, 60, 24));
    setDir(r.spark, ps[30] - ps[0]);
    r.px.textContent = yen(price(c, t));
    const ch = changeText(c, t);
    r.chg.textContent = ch.text;
    setDir(r.chg, ch.d);
  }
  // 共有の文面（切り出されても本物の投資の成績に見えないよう「架空」「ゲーム」を必ず入れる）
  $('shareBtn').dataset.wakText = `BUYOUT（架空の相場ゲーム）で総資産 ${fmtYen(tot.total)}。${bo}/8 社を買い占め中。`;

  if (state.seenIntro) {
    $('rTotal').textContent = fmtYen(tot.total);
    $('rBo').textContent = `買い占め ${bo}/8 社`;
  }

  if (openId) renderCompany(t);
}

// ---- 会社シート ----
let openId = null;
let range = 30;
function openCompany(id) {
  openId = id;
  const c = byId[id];
  $('cName').textContent = c.name;
  $('cMeta').textContent = `${c.sector} · 年の配当利回り ${c.yieldPct}% · 発行済 ${fmtNum(c.shares)} 株 · 架空の会社`;
  renderCompany(Date.now());
  showSheet($('company'));
}
function renderCompany(t) {
  const c = byId[openId], p = price(c, t), h = held(state, c.id);
  $('cPrice').textContent = yen(p);
  const ch = changeText(c, t);
  $('cChg').textContent = ch.text;
  setDir($('cChg'), ch.d);

  const ps = series(c, t, range, 120);
  const pts = linePoints(ps, 320, 140, 6);
  const svg = $('cChart');
  svg.querySelector('polyline').setAttribute('points', pts);
  svg.querySelector('path').setAttribute('d', `M0,140 L${pts.replaceAll(' ', ' L')} L320,140 Z`);
  setDir(svg, ps[120] - ps[0]);
  $('cRange').textContent = `${range === 30 ? '30 日' : '1 年'}の高値 ${yen(Math.max(...ps))} / 安値 ${yen(Math.min(...ps))}`;

  const value = h * BigInt(p), basis = state.basis[c.id] ?? 0n;
  $('cHeld').textContent = `${fmtNum(h)} 株`;
  $('cValue').textContent = fmtYen(value);
  $('cPl').textContent = h ? `${signed(value - basis)}${basis ? `（${pct(Number(value - basis) / Number(basis) * 100)}）` : ''}` : '—';
  setDir($('cPl'), h ? Number(value - basis) : 0);
  $('cDiv').textContent = fmtYen(h * BigInt(c.base * c.bps) / DIV_UNIT);
  $('cBo').hidden = !boughtOut(state, c.id);

  document.querySelectorAll('[data-buy]').forEach((b) => {
    const [num, den] = b.dataset.buy.split('/').map(Number);
    const n = buyable(state, c.id, num, den, t);
    b.disabled = n <= 0n;
    b.querySelector('small').textContent = n > 0n ? `${fmtNum(n)} 株` : '—';
  });
  document.querySelectorAll('[data-sell]').forEach((b) => {
    const n = b.dataset.sell === 'all' ? h : h ? halfOf(state, c.id) : 0n;
    b.disabled = n <= 0n;
    b.querySelector('small').textContent = n > 0n ? `${fmtNum(n)} 株` : '—';
  });
  newsList($('cNews'), newsBefore(t, { max: 3, pred: (e) => newsEffect(e, c) !== 0 }), t);
}
document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
  range = Number(b.dataset.range);
  document.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  Sound.tap();
  renderCompany(Date.now());
}));
document.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => {
  const t = Date.now(), id = openId;
  const [num, den] = b.dataset.buy.split('/').map(Number);
  const n = buyable(state, id, num, den, t);
  if (n <= 0n) return;
  const wasCleared = state.clearedAt;
  buy(state, id, n, t);
  store();
  if (!wasCleared && state.clearedAt) { Sound.clear(); showClear(); } else if (boughtOut(state, id)) Sound.boughtOut(); else Sound.buy();
  render(t);
}));
document.querySelectorAll('[data-sell]').forEach((b) => b.addEventListener('click', () => {
  const t = Date.now(), id = openId, h = held(state, id);
  const n = b.dataset.sell === 'all' ? h : halfOf(state, id);
  if (n <= 0n) return;
  sell(state, id, n, t);
  store();
  Sound.sell();
  render(t);
}));

// ---- シート ----
function showSheet(d) {
  if (!d.open) { d.showModal(); Sound.tap(); }
}
document.querySelectorAll('dialog').forEach((d) => {
  // 外（背景）をタップしても閉じる
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => { Sound.tap(); if (d.id === 'company') openId = null; });
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
});
$('helpBtn').addEventListener('click', () => showSheet($('help')));
$('helpBtn2').addEventListener('click', () => showSheet($('help')));

function showClear() {
  const ms = state.clearedAt - state.createdAt;
  const text = `始めてから ${duration(ms)}（ゲーム内 ${Math.floor(ms / (YEAR_DAYS * DAY_MS))} 年）。`;
  $('clearText').textContent = `全 8 社の株を全部持ちました。${text}`;
  $('clearShare').onclick = () => WebAppKit.share({ text: `BUYOUT（架空の相場ゲーム）で 8 社を買い占めた。${text}` });
  showSheet($('clear'));
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  if (el.showPopover && !el.matches(':popover-open')) el.showPopover();   // 開いているシートより上に出す
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (el.hidePopover && el.matches(':popover-open')) el.hidePopover(); el.hidden = true; }, 5000);
}

// ---- 時間を進める ----
// 開いたとき・戻ったとき・開いている間の 1 秒ごと、すべて同じ advance を通す
let lastNewsSlot = null;
function step(resumed = false) {
  const t = Date.now();
  const since = state.lastSeen;
  const before = totals(state, since).total;
  const r = advance(state, t);
  const rescued = rescue(state, t);
  store();

  const latest = newsBefore(t, { max: 1 })[0]?.slot ?? null;
  if (resumed && r.elapsed >= 60000 && state.seenIntro) showWelcome(r, since, before, t);
  else {
    if (r.n > 0) Sound.dividend();
    if (lastNewsSlot !== null && latest !== lastNewsSlot) Sound.news();
  }
  lastNewsSlot = latest;
  render(t);
  if (rescued) toast('現金が足りなくなったので、10,000 円に戻しました');   // シートより後に出して上に重ねる
}
function showWelcome(r, since, before, t) {
  $('wAway').textContent = `${duration(r.elapsed)} 留守にしていました。`;
  $('wGain').textContent = r.gain > 0n ? `配当 ${r.n} 回で +${fmtYen(r.gain)}` : '配当はありませんでした';
  $('wTotal').textContent = `総資産 ${fmtYen(before)} → ${fmtYen(totals(state, t).total)}`;
  $('wCap').hidden = !r.capped;
  newsList($('wNews'), newsBefore(t, { max: 3, since, maxSlots: 2000 }), t);
  showSheet($('welcome'));
  Sound.welcome();
}

// 裏に回ったら 1 秒の時計を止めて保存。戻ったら進める
let timer = 0;
function start() {
  clearInterval(timer);
  step(true);
  timer = setInterval(step, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearInterval(timer); store(); } else start();
});
addEventListener('pagehide', store);

start();

// ---- タイトル ⇔ 遊ぶ ----

function showTitle() {
  $('record').hidden = !state.seenIntro;
  $('reset-btn').hidden = !state.seenIntro;
  $('start-btn').textContent = state.seenIntro ? 'つづきから' : 'はじめる';
  render(Date.now());
  playEl.hidden = true;
  titleEl.hidden = false;
  window.scrollTo(0, 0);
}
function showPlay() {
  titleEl.hidden = true;
  playEl.hidden = false;
  window.scrollTo(0, 0);
}
$('start-btn').addEventListener('click', () => {
  Sound.tap();
  if (!state.seenIntro) { state.seenIntro = true; store(); }
  showPlay();
});
$('back-btn').addEventListener('click', () => { Sound.tap(); showTitle(); });
$('reset-btn').addEventListener('click', () => {
  if (!confirm('はじめから遊びますか？ これまでの記録は消えます。')) return;
  Object.assign(state, newState(Date.now()));
  store();
  showTitle();
});

// 読めなかったときは新しく始めているので、その旨をトーストで伝える
if (brokenSave) toast('保存データが読めなかったので、新しく始めます（元のデータは残してあります）');
showTitle();
