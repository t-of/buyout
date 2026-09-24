// 遊びの中身のテスト。node test.mjs で走る（フレームワークなし）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ORIGIN, QUARTER_MS, CAP_MS, START_CASH, COMPANIES, byId, ALL_NEWS_TEXT,
  price, newsAt, newsBefore, newState, advance, perQuarter, buyable, buy, sell, halfOf, boughtOut,
  totals, nextDividend, serialize, deserialize, fmtNum, fmtYen, rescue,
} from './game.js';

const test = (name, fn) => { fn(); console.log('✓', name); };
const T = Date.UTC(2026, 8, 25, 3, 0, 0);   // 決まった時刻

test('同じ時刻からは同じ株価。円の整数で 1 円以上', () => {
  for (const c of COMPANIES) {
    for (let i = 0; i < 200; i++) {
      const t = T + i * 7919;
      const p = price(c, t);
      assert.equal(p, price(c, t));
      assert.ok(Number.isInteger(p) && p >= 1);
    }
  }
  // 値を覚えていない: 別の時刻を挟んでも同じ
  const a = price(byId.neko, T);
  price(byId.neko, T + 123456789);
  assert.equal(price(byId.neko, T), a);
});

test('株価はよく動くが、基準からかけ離れない', () => {
  for (const c of COMPANIES) {
    const ps = Array.from({ length: 2000 }, (_, i) => price(c, T + i * 37_000));
    const lo = Math.min(...ps), hi = Math.max(...ps);
    assert.ok(lo >= c.base * 0.05 && hi <= c.base * 3, `${c.id} ${lo}〜${hi}`);
    assert.ok(hi / lo > 1.3, `${c.id} が動かない`);
  }
});

test('ニュースも時刻から決まる。だいたい 20 枠に 8 件、災害の見出しはない', () => {
  let n = 0;
  for (let k = 1000; k < 3000; k++) {
    const e = newsAt(k);
    assert.deepEqual(e, newsAt(k));
    if (!e) continue;
    n++;
    assert.ok(e.day >= k * 20 && e.day < (k + 1) * 20);
    assert.ok(e.rise >= 0.5 && e.rise <= 3 && e.half >= 20 && e.half <= 90);
  }
  assert.ok(n > 700 && n < 900, `${n} 件`);
  for (const text of ALL_NEWS_TEXT) assert.ok(!/地震|噴火|津波|震災|火山|洪水|土砂/.test(text), text);
  const list = newsBefore(T, { max: 5 });
  assert.equal(list.length, 5);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].day > list[i].day);
});

test('経過が負（時計が戻された）なら配当なし。前回の時刻は今にする', () => {
  const s = newState(T);
  buy(s, 'neko', 5n, T);
  const cash = s.cash;
  const r = advance(s, T - 10 * QUARTER_MS);
  assert.equal(r.elapsed, 0);
  assert.equal(r.n, 0);
  assert.equal(s.cash, cash);
  assert.equal(s.lastSeen, T - 10 * QUARTER_MS);
});

test('経過 0 なら何も起きない', () => {
  const s = newState(T);
  buy(s, 'neko', 5n, T);
  const before = serialize(s);
  const r = advance(s, T);
  assert.equal(r.n, 0);
  assert.deepEqual(serialize(s), before);
});

test('8 時間を超えた分は数えない（配当は最大 320 回）', () => {
  const s = newState(T);
  buy(s, 'neko', 10n, T);
  const r = advance(s, T + 3 * CAP_MS);
  assert.equal(r.capped, true);
  assert.equal(r.counted, CAP_MS);
  assert.equal(r.n, 320);
  assert.equal(s.lastSeen, T + 3 * CAP_MS);
  // 10 株 × 780 円 × 4.5 % ÷ 4 × 320 回 = 28,080 円
  assert.equal(r.gain, 28080n);
});

test('1 秒ずつ 900 回進めても、900 秒を一度に進めても現金が同じ', () => {
  const a = newState(T), b = newState(T);
  for (const s of [a, b]) { buy(s, 'neko', 3n, T); buy(s, 'kawa', 1n, T); }   // 端数が出る持ち方
  for (let i = 1; i <= 900; i++) advance(a, T + i * 1000);
  advance(b, T + 900 * 1000);
  assert.equal(a.cash, b.cash);
  assert.equal(a.carry, b.carry);
  assert.ok(a.cash > START_CASH - 3n * BigInt(price(byId.neko, T)) - BigInt(price(byId.kawa, T)));
});

test('発行済株式数より多くは買えない。全部持つと買い占め', () => {
  const s = newState(T);
  const c = byId.neko;
  s.cash = 10n ** 12n;
  const n = buyable(s, 'neko', 1, 1, T);
  assert.equal(n, c.shares);
  buy(s, 'neko', n, T);
  assert.equal(boughtOut(s, 'neko'), true);
  assert.equal(buyable(s, 'neko', 1, 1, T), 0n);
  assert.throws(() => buy(s, 'neko', 1n, T));
});

test('お金が足りない買いと、持っていない株の売りはできない', () => {
  const s = newState(T);
  const p = BigInt(price(byId.nami, T));
  assert.equal(buyable(s, 'nami', 1, 1, T), START_CASH / p);
  assert.throws(() => buy(s, 'nami', START_CASH / p + 1n, T));
  assert.throws(() => sell(s, 'nami', 1n, T));
});

test('売ると取得原価が売った割合だけ減る。半分は切り上げ', () => {
  const s = newState(T);
  buy(s, 'neko', 4n, T);
  const cost = s.basis.neko;
  assert.equal(halfOf(s, 'neko'), 2n);
  sell(s, 'neko', 2n, T);
  assert.equal(s.basis.neko, cost / 2n);
  sell(s, 'neko', 1n, T);
  assert.equal(halfOf(s, 'neko'), 1n);
  sell(s, 'neko', 1n, T);
  assert.equal(s.holdings.neko, undefined);
});

test('8 社を全部買い占めるとクリアの時刻が入る。金額は Number の範囲を超えても正しい', () => {
  const s = newState(T);
  s.cash = 10n ** 19n;
  for (const c of COMPANIES) buy(s, c.id, c.shares, T);
  assert.equal(s.clearedAt, T);
  const { total } = totals(s, T);
  assert.ok(total > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(typeof total, 'bigint');
  assert.equal(typeof perQuarter(s), 'bigint');
});

test('次の配当: 期の境目までの残りと見込み', () => {
  const s = newState(T);
  const q0 = ORIGIN + Math.ceil((T - ORIGIN) / QUARTER_MS) * QUARTER_MS;
  assert.equal(nextDividend(s, q0 - 1000).leftMs, 1000);
  assert.equal(nextDividend(s, q0).leftMs, QUARTER_MS);
  buy(s, 'neko', 10n, T);
  assert.equal(nextDividend(s, T).yen, 87n);   // 10 × 780 × 4.5 % ÷ 4 = 87.75
});

test('保存して読むと元に戻る。知らない会社は数えない。壊れた形は例外', () => {
  const s = newState(T);
  buy(s, 'neko', 5n, T);
  advance(s, T + 95_000);
  const o = JSON.parse(JSON.stringify(serialize(s)));
  assert.deepEqual(serialize(deserialize(o)), serialize(s));
  o.holdings.gone = '5'; o.basis.gone = '100';
  assert.deepEqual(Object.keys(deserialize(o).holdings), ['neko']);
  assert.throws(() => deserialize({ ...o, cash: 'abc' }));
  assert.throws(() => deserialize({ ...o, v: 2 }));
  assert.throws(() => deserialize(null));
});

test('詰み防止は持ち株 0 で現金が足りないときだけ', () => {
  const s = newState(T);
  s.cash = 0n;
  assert.equal(rescue(s, T), true);
  assert.equal(s.cash, START_CASH);
  buy(s, 'neko', 1n, T);
  s.cash = 0n;
  assert.equal(rescue(s, T), false);
});

test('数の書き方（万進法、有効数字 3〜4 桁、切り捨て）', () => {
  assert.equal(fmtYen(9780n), '9,780 円');
  assert.equal(fmtYen(12345n), '1.23 万円');
  assert.equal(fmtNum(45_678_901n), '4,567 万');
  assert.equal(fmtNum(120_000_000n), '1.20 億');
  assert.equal(fmtNum(3_400_000_000_000n), '3.40 兆');
  assert.equal(fmtNum(10n ** 15n), '1,000 兆');
  assert.equal(fmtNum(100_000n), '10.0 万');
  assert.equal(fmtNum(10000n), '1.00 万');
  assert.equal(fmtNum(-12345n), '−1.23 万');
});

test('実在の指数・取引所の名前、投資をうたう言葉を使っていない', () => {
  const text = ['index.html', 'main.js', 'game.js', 'README.md'].map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const w of ['日経', 'TOPIX', '東証', 'ダウ', 'NASDAQ', 'S&P', '投資の練習', 'もうかる', '儲か', '必勝', '現実でも使える']) {
    assert.ok(!text.includes(w), w);
  }
});
