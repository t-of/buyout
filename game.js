// BUYOUT の遊びの中身（会社の表・株価・ニュース・配当・進める・売り買い・保存の形・数の書き方）。
// DOM には触らない。ブラウザでは main.js から、テストでは node test.mjs から読む。
//
// 株価とニュースは「時刻の関数」。同じ時刻からは必ず同じ値が出る（乱数を回して覚えない）。
// だから閉じている間の値動きを進める必要がなく、保存も要らない。
// 金額・株数は BigInt。最後の会社の発行済株式数や買い占めの額が Number の安全な範囲を超えるため。

// ---- 時間 ----
// 現実の 1 秒 = ゲーム内の 1 日。90 日 = 1 期（四半期）、360 日 = 1 年
export const ORIGIN = Date.UTC(2026, 0, 1);   // 時刻の原点。期の番号・ニュースの枠もここから数える
export const DAY_MS = 1000;
export const QUARTER_DAYS = 90;
export const YEAR_DAYS = 360;
export const QUARTER_MS = QUARTER_DAYS * DAY_MS;
export const CAP_MS = 8 * 3600 * 1000;        // 留守の間の配当は 8 時間分まで
export const START_CASH = 10000n;

export const gameDay = (t) => (t - ORIGIN) / DAY_MS;
export const quarterOf = (t) => Math.floor((t - ORIGIN) / QUARTER_MS);

// ---- 会社（数値はここだけ。釣り合いを直すときはこの表を触る） ----
// base: 基準の株価（円） / cap: 時価総額（円） / bps: 年の配当利回り（1/100 %） / vol: 荒さ
const TABLE = [
  { id: 'neko', name: 'ネコ電機', sector: '電機', base: 780, cap: 10n ** 8n, bps: 450, vol: 0.42 },
  { id: 'kawa', name: 'カワ製薬', sector: '製薬', base: 1240, cap: 10n ** 9n, bps: 320, vol: 0.39 },
  { id: 'sora', name: 'ソラ通信', sector: '通信', base: 3450, cap: 10n ** 10n, bps: 250, vol: 0.35 },
  { id: 'hane', name: 'ハネ重工', sector: '重工', base: 620, cap: 10n ** 11n, bps: 450, vol: 0.33 },
  { id: 'tsuki', name: 'ツキ不動産', sector: '不動産', base: 2180, cap: 10n ** 12n, bps: 500, vol: 0.30 },
  { id: 'nami', name: 'ナミ海運', sector: '海運', base: 5600, cap: 10n ** 13n, bps: 700, vol: 0.34 },
  { id: 'hoshi', name: 'ホシ自動車', sector: '自動車', base: 940, cap: 10n ** 14n, bps: 290, vol: 0.28 },
  { id: 'kaze', name: 'カゼ航空', sector: '航空', base: 1870, cap: 10n ** 15n, bps: 150, vol: 0.32 },
];
export const COMPANIES = TABLE.map((c, i) => ({
  ...c,
  seed: 1000 * (i + 1),
  shares: c.cap / BigInt(c.base),   // 発行済株式数（切り捨て）。これより多くは買えない
  yieldPct: c.bps / 100,
}));
export const byId = Object.fromEntries(COMPANIES.map((c) => [c.id, c]));

// 1 株の 1 期の配当 = 基準の株価 × 利回り ÷ 4。端数を落とさないよう 1/40000 円を単位にして整数で持つ
// （base × bps ÷ 10000 ÷ 4 円 = base × bps 単位）
export const DIV_UNIT = 40000n;

// ---- ハッシュとなめらかな揺れ ----
// 整数だけで混ぜる（どの端末でも同じ値になる）
function hash(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x6a09e667, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const unit = (a, b) => hash(a, b) / 4294967296;   // 0 以上 1 未満

// バリューノイズ: 整数の点ごとに −1〜1 の値を置き、間をなめらかにつなぐ
function noise(seed, x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = unit(seed, i) * 2 - 1, b = unit(seed, i + 1) * 2 - 1;
  return a + (b - a) * u;
}

// ---- ニュース ----
// ゲーム内 20 日ごとの枠で 40 % の確率で 1 件。枠の中の時刻もハッシュでずらす
const SLOT_DAYS = 20;
const NEWS_RATE = 0.4;
const NEWS_SEED = 0x5eed;
const LOOKBACK = 30;   // 何枠さかのぼって効きを足すか。半減期 90 日でも 600 日前は 1 % 未満

// dir: 向き / lo〜hi: 効きの強さ（割合） / sectors: 主に効く業種 / broad: ほかの全社に効くぶん / gainers: 逆に得をする業種
// 実際の災害を思わせる見出し（地震・噴火・津波など）は入れない
const COMPANY_NEWS = [
  { text: '{name}、今期の決算が大幅上振れ', dir: 1, lo: 0.10, hi: 0.28 },
  { text: '{name}が新製品を発表、評判は上々', dir: 1, lo: 0.06, hi: 0.18 },
  { text: '{name}、大型契約を受注', dir: 1, lo: 0.07, hi: 0.20 },
  { text: '{name}に自社株買いの観測', dir: 1, lo: 0.04, hi: 0.12 },
  { text: '{name}、通期見通しを下方修正', dir: -1, lo: 0.08, hi: 0.25 },
  { text: '{name}の主力工場で事故', dir: -1, lo: 0.08, hi: 0.22 },
  { text: '{name}に品質不正の疑い', dir: -1, lo: 0.12, hi: 0.30 },
  { text: '{name}、大株主が保有株を売却', dir: -1, lo: 0.04, hi: 0.13 },
];
const WEATHER_NEWS = [
  { text: '記録的な猛暑、冷房需要が急増', dir: 1, lo: 0.04, hi: 0.12, sectors: ['電機'] },
  { text: '寒波で暖房需要が増加', dir: 1, lo: 0.03, hi: 0.10, sectors: ['電機', '通信'] },
  { text: '長雨で物流が停滞', dir: -1, lo: 0.03, hi: 0.10, sectors: ['海運', '自動車'] },
  { text: '大型台風が接近、欠航相次ぐ', dir: -1, lo: 0.05, hi: 0.16, sectors: ['航空', '海運'] },
  { text: '好天続き、旅行の予約が好調', dir: 1, lo: 0.03, hi: 0.09, sectors: ['航空', '不動産'] },
  { text: '花粉の飛散が例年の倍に', dir: 1, lo: 0.03, hi: 0.10, sectors: ['製薬'] },
];
const EVENT_NEWS = [
  { text: '大規模な停電が発生', dir: -1, lo: 0.06, hi: 0.16, sectors: ['通信', '電機'], broad: 0.03, gainers: ['重工'] },
  { text: '景気の先行きに不安、幅広く売られる', dir: -1, lo: 0.04, hi: 0.10, sectors: [], broad: 0.05, gainers: ['製薬'] },
  { text: '原料の値上がりが続く', dir: -1, lo: 0.05, hi: 0.14, sectors: ['自動車', '重工'], broad: 0.02, gainers: ['海運'] },
  { text: '新しい鉄道計画が発表', dir: 1, lo: 0.05, hi: 0.15, sectors: ['重工', '不動産'], broad: 0.01, gainers: [] },
  { text: '観光客が過去最多に', dir: 1, lo: 0.05, hi: 0.14, sectors: ['航空', '不動産'], broad: 0.02, gainers: [] },
  { text: '景気回復の兆し、幅広く買われる', dir: 1, lo: 0.03, hi: 0.08, sectors: [], broad: 0.05, gainers: [] },
];
export const ALL_NEWS_TEXT = [...COMPANY_NEWS, ...WEATHER_NEWS, ...EVENT_NEWS].map((n) => n.text);

const pick = (list, u) => list[Math.floor(u * list.length)];

// 枠 k のニュース（起きなければ null）
export function newsAt(k) {
  if (unit(NEWS_SEED, k) >= NEWS_RATE) return null;
  const r = (j) => unit(NEWS_SEED + j, k);
  const day = (k + r(1)) * SLOT_DAYS;
  const kr = r(2);
  const kind = kr < 0.5 ? 'company' : kr < 0.8 ? 'weather' : 'event';
  const tpl = pick(kind === 'company' ? COMPANY_NEWS : kind === 'weather' ? WEATHER_NEWS : EVENT_NEWS, r(3));
  // 会社のニュースは小さい会社ほど選ばれやすい（始めたばかりの人に関係のあるニュースが流れるように）
  const target = kind === 'company' ? COMPANIES[Math.floor(r(4) ** 2 * COMPANIES.length)] : null;
  return {
    slot: k, day, kind,
    text: target ? tpl.text.replace('{name}', target.name) : tpl.text,
    target: target?.id ?? null,
    dir: tpl.dir,
    amp: tpl.lo + r(5) * (tpl.hi - tpl.lo),
    sectors: tpl.sectors ?? [], broad: tpl.broad ?? 0, gainers: tpl.gainers ?? [],
    rise: 0.5 + r(6) * 2.5,    // 立ち上がり 0.5〜3 日
    half: 20 + r(7) * 70,      // 半減期 20〜90 日
  };
}

// ニュースが会社 c に効く向きと強さ（最大のとき）
export function newsEffect(e, c) {
  if (e.kind === 'company') return e.target === c.id ? e.dir * e.amp : 0;
  if (e.sectors.includes(c.sector)) return e.dir * e.amp;
  if (e.gainers.includes(c.sector)) return -e.dir * e.broad;
  return e.dir * e.broad;
}

function newsFactor(c, d) {
  let sum = 0;
  const k0 = Math.floor(d / SLOT_DAYS);
  for (let k = k0; k > k0 - LOOKBACK; k--) {
    const e = newsAt(k);
    if (!e || e.day > d) continue;
    const x = newsEffect(e, c);
    if (!x) continue;
    const dt = d - e.day;
    sum += x * Math.min(1, dt / e.rise) * 0.5 ** (Math.max(0, dt - e.rise) / e.half);
  }
  return Math.max(-0.8, sum);
}

// 時刻 t までに起きたニュースを新しい順に。since より後だけ、pred に合うものだけ、max 件まで
export function newsBefore(t, { max = 3, since = -Infinity, pred = () => true, maxSlots = 400 } = {}) {
  const d = gameDay(t), d0 = gameDay(since);
  const out = [];
  const k0 = Math.floor(d / SLOT_DAYS);
  for (let k = k0; k > k0 - maxSlots && out.length < max; k--) {
    if ((k + 1) * SLOT_DAYS <= d0) break;
    const e = newsAt(k);
    if (e && e.day <= d && e.day > d0 && pred(e)) out.push(e);
  }
  return out;
}
export const newsTime = (e) => ORIGIN + e.day * DAY_MS;

// ---- 株価 ----
// 周期 360 日・30 日・2.5 日の揺れを重ね、ニュースの効きを掛ける。円の整数、最低 1 円
export function price(c, t) {
  const d = gameDay(t);
  const w = c.vol * (0.6 * noise(c.seed, d / 360) + 0.32 * noise(c.seed + 1, d / 30) + 0.08 * noise(c.seed + 2, d / 2.5));
  const m = Math.max(0.05, (1 + w) * (1 + newsFactor(c, d)));
  return Math.max(1, Math.round(c.base * m));
}
export const priceN = (c, t) => BigInt(price(c, t));
// 前日比（ゲーム内 1 日 = 1 秒前との差）
export const change = (c, t) => price(c, t) - price(c, t - DAY_MS);

// ---- 状態 ----
export function newState(now) {
  return { v: 1, cash: START_CASH, carry: 0n, holdings: {}, basis: {}, lastSeen: now, createdAt: now, clearedAt: null, seenIntro: false };
}
export const held = (s, id) => s.holdings[id] ?? 0n;
export const boughtOut = (s, id) => held(s, id) === byId[id].shares;
export const boughtOutCount = (s) => COMPANIES.filter((c) => boughtOut(s, c.id)).length;

// 1 期の配当（1/40000 円単位）
export function perQuarter(s) {
  let u = 0n;
  for (const c of COMPANIES) u += held(s, c.id) * BigInt(c.base * c.bps);
  return u;
}
// 配当 n 回ぶんを現金に入れる。端数は carry に持ち越す（まとめて数えても 1 回ずつでも総額が同じ）
function payout(s, n) {
  const u = BigInt(n) * perQuarter(s) + s.carry;
  const yen = u / DIV_UNIT;
  s.cash += yen;
  s.carry = u % DIV_UNIT;
  return yen;
}

// 開いたとき・戻ったとき・開いている間の 1 秒ごと、すべてこれを呼ぶ
export function advance(s, now) {
  let elapsed = now - s.lastSeen;
  if (!(elapsed > 0)) elapsed = 0;          // 時計が戻された（または同じ時刻）
  const counted = Math.min(elapsed, CAP_MS);
  const n = quarterOf(now) - quarterOf(now - counted);
  const gain = payout(s, n);
  s.lastSeen = now;                         // 経過 0 でも必ず更新する
  return { elapsed, counted, capped: elapsed > CAP_MS, n, gain };
}

// 次の配当までの秒数と見込み額
export function nextDividend(s, t) {
  const left = QUARTER_MS - (((t - ORIGIN) % QUARTER_MS) + QUARTER_MS) % QUARTER_MS;
  return { leftMs: left, yen: (perQuarter(s) + s.carry) / DIV_UNIT };
}

// 総資産・株の評価額・取得原価
export function totals(s, t) {
  let stock = 0n, basis = 0n;
  for (const c of COMPANIES) {
    const h = held(s, c.id);
    if (h) { stock += h * priceN(c, t); basis += s.basis[c.id] ?? 0n; }
  }
  return { total: s.cash + stock, stock, basis, pl: stock - basis };
}

// ---- 売り買い（現物だけ。手数料なし。値段はその瞬間の株価） ----
// 買える株数: 現金 × num/den を株価で割って切り捨て。発行済の残りを超えない
export function buyable(s, id, num, den, t) {
  const c = byId[id];
  const n = (s.cash * BigInt(num) / BigInt(den)) / priceN(c, t);
  const room = c.shares - held(s, id);
  return n < room ? n : room;
}
export function buy(s, id, n, t) {
  const c = byId[id];
  const cost = n * priceN(c, t);
  if (n <= 0n || cost > s.cash || held(s, id) + n > c.shares) throw new Error('買えない');
  s.cash -= cost;
  s.holdings[id] = held(s, id) + n;
  s.basis[id] = (s.basis[id] ?? 0n) + cost;
  if (!s.clearedAt && boughtOutCount(s) === COMPANIES.length) s.clearedAt = t;
  return cost;
}
export function sell(s, id, n, t) {
  const h = held(s, id);
  if (n <= 0n || n > h) throw new Error('売れない');
  const got = n * priceN(byId[id], t);
  s.cash += got;
  const b = s.basis[id] ?? 0n;
  s.basis[id] = b - b * n / h;   // 売った株数の割合だけ取得原価を減らす
  s.holdings[id] = h - n;
  if (s.holdings[id] === 0n) { delete s.holdings[id]; delete s.basis[id]; }
  return got;
}
export const halfOf = (s, id) => (held(s, id) + 1n) / 2n;   // 「半分」は切り上げ（1 株でも売れる）

// 詰み防止: 持ち株 0 株で、現金が一番安い株価に届かないときだけ 10,000 円に戻す
export function rescue(s, t) {
  if (Object.keys(s.holdings).length) return false;
  const min = COMPANIES.reduce((m, c) => (priceN(c, t) < m ? priceN(c, t) : m), priceN(COMPANIES[0], t));
  if (s.cash >= min) return false;
  s.cash = START_CASH; s.carry = 0n;
  return true;
}

// ---- 保存の形（金額・株数は BigInt を文字列で） ----
export function serialize(s) {
  const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
  return { v: 1, cash: s.cash.toString(), carry: s.carry.toString(), holdings: str(s.holdings), basis: str(s.basis),
    lastSeen: s.lastSeen, createdAt: s.createdAt, clearedAt: s.clearedAt, seenIntro: s.seenIntro };
}
// 読めない形なら例外を投げる（呼ぶ側が元のデータを別に写してから新しく始める）
export function deserialize(o) {
  const big = (x) => { if (typeof x !== 'string' || !/^\d+$/.test(x)) throw new Error('数でない'); return BigInt(x); };
  const time = (x) => { if (!Number.isFinite(x)) throw new Error('時刻でない'); return x; };
  if (!o || o.v !== 1) throw new Error('版が違う');
  const s = newState(time(o.lastSeen));
  s.cash = big(o.cash);
  s.carry = big(o.carry) % DIV_UNIT;
  s.createdAt = time(o.createdAt);
  s.clearedAt = o.clearedAt == null ? null : time(o.clearedAt);
  s.seenIntro = o.seenIntro === true;
  for (const [id, v] of Object.entries(o.holdings || {})) {
    const c = byId[id];
    if (!c) continue;   // 知らない会社は数えない（あとで表を変えても壊れない）
    const n = big(v);
    if (n === 0n) continue;
    s.holdings[id] = n > c.shares ? c.shares : n;
    s.basis[id] = o.basis?.[id] != null ? big(o.basis[id]) : 0n;
  }
  return s;
}

// ---- 数の書き方 ----
// 1 万未満はそのまま「9,780」、それ以上は万進法で有効数字 3〜4 桁（切り捨て）「1.23 万」「4,567 万」「1.20 億」
const UNITS = [[10n ** 12n, '兆'], [10n ** 8n, '億'], [10n ** 4n, '万']];
const comma = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function fmtNum(n) {
  const neg = n < 0n, a = neg ? -n : n;
  let out = comma(a);
  for (const [u, name] of UNITS) {
    if (a < u) continue;
    const whole = a / u;
    const digits = whole >= 100n ? 0 : whole >= 10n ? 1 : 2;
    const scale = 10n ** BigInt(digits);
    const v = a * scale / u;
    const frac = digits ? '.' + (v % scale).toString().padStart(digits, '0') : '';
    out = `${comma(v / scale)}${frac} ${name}`;
    break;
  }
  return (neg ? '−' : '') + out;
}
// 「9,780 円」「1.23 万円」
export const fmtYen = (n) => { const s = fmtNum(n); return /[万億兆]$/.test(s) ? `${s}円` : `${s} 円`; };
