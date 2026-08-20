#!/usr/bin/env node
/**
 * cloud_snapshot.js - 云端版 14:45 正式快照（GitHub Actions 专用，零本地依赖）
 * 逻辑与本地 server/services/t1.js 完全一致（同一套规则），仅剥离本地文件依赖。
 * 输出：t1_snapshot.json（供 GitHub Pages / WorkBuddy 展示）
 *
 * 用法：node cloud_snapshot.js [output.json]
 * 由 .github/workflows/snapshot.yml 每交易日 14:45（Asia/Shanghai）调用。
 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
async function jfetch(url, timeout = 30000, tries = 1) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA }, signal: ctl.signal });
      clearTimeout(t);
      const j = await res.json();
      if (j && (j.data !== undefined || j.code === 0)) return j;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('fetch fail: ' + url.slice(0, 90));
}
const round = (v, n = 2) => (v === null || v === undefined || isNaN(v)) ? null : Number(v.toFixed(n));

// ---------- 全市场池 ----------
const POOL_FIELDS = 'f12,f14,f2,f3,f5,f6,f8,f10,f15,f16,f17,f18,f20,f21,f100'.split(',').join(',');
async function getStockPool() {
  const POOL_HOST = 'https://push2delay.eastmoney.com/api/qt/clist/get';
  const all = [];
  const CONC = 7;
  for (let start = 1; start <= 56; start += CONC) {
    const batch = [];
    for (let pn = start; pn < start + CONC && pn <= 56; pn++) {
      batch.push(jfetch(`${POOL_HOST}?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=${POOL_FIELDS}`, 60000)
        .then((j) => (j.data && j.data.diff) || []).catch(() => []));
    }
    (await Promise.all(batch)).forEach((diff) => diff.forEach((b) => all.push({
      code: b.f12, name: b.f14, price: b.f2, pct: b.f3, volume: b.f5, amount: b.f6,
      turnover: b.f8, volRatio: b.f10, high: b.f15, low: b.f16, open: b.f17, preClose: b.f18,
      totalMv: b.f20, floatMv: b.f21, industry: b.f100 || '',
    })));
  }
  return all;
}

// ---------- 指数 ----------
async function getIndexes() {
  const targets = [['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指']];
  const fields = 'f43,f57,f58,f60,f170,f171'.split(',').join(',');
  const out = [];
  for (const [secid, name] of targets) {
    try {
      const j = await jfetch(`https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secid}&fields=${fields}&fltt=2`, 20000);
      const d = (j.data && j.data.diff && j.data.diff[0]) || {};
      out.push({ name, price: d.f43, changePct: d.f170, amount: d.f57, volume: d.f58 });
    } catch (e) { /* skip */ }
  }
  return out;
}

// ---------- 分时 ----------
async function getTrends(code) {
  const secid = /^(60|68|9)/.test(code) ? '1.' + code : /^(00|30|20)/.test(code) ? '0.' + code : '0.' + code;
  const hosts = ['https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
  for (const host of hosts) {
    try {
      const j = await jfetch(`${host}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`, 30000, 2);
      const trends = (j.data && j.data.trends) || [];
      if (trends.length > 100) return trends.map((l) => {
        const p = l.split(',');
        return { time: p[0], price: +p[1], avg: +p[3], volume: +p[5] };
      });
    } catch (e) { /* next host */ }
  }
  throw new Error('trends fail ' + code);
}

// ---------- 日K（20日均量 volMulti，单位统一为手） ----------
async function getKline(code, lmt = 70) {
  const secid = /^(60|68|9)/.test(code) ? '1.' + code : '0.' + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=0&end=20500101&lmt=${lmt}`;
  const j = await jfetch(url, 30000, 2);
  const kl = (j.data && j.data.klines) || [];
  return kl.map((l) => { const p = l.split(','); return { date: p[0], close: +p[2], volume: Math.round(+p[5] / 100) }; });
}

// ---------- 板块 ----------
async function getIndustryBoards() {
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=f12,f14,f3`;
  const j = await jfetch(url, 30000, 2);
  const diff = (j.data && j.data.diff) || [];
  return diff.map((b) => ({ name: b.f14, pct: b.f3 }));
}

// ---------- 资金（主力净流入） ----------
async function getMainInflow(code) {
  const secid = /^(60|68|9)/.test(code) ? '1.' + code : '0.' + code;
  try {
    const j = await jfetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f135,f137,f139,f141,f57,f58`, 15000, 1);
    const d = j.data || {};
    return d.f137 || 0; // 主力净流入（元）
  } catch (e) { return 0; }
}

// ---------- 市场温度（5因子） ----------
async function getMarketEnv(pool) {
  const indexes = await getIndexes();
  const idx = indexes.find((i) => i.name === '上证指数') || null;
  const shPct = idx ? idx.changePct : null;
  const temp = { idx: 0, breadth: 0, emo: 0, rate: 0, m15: 0, total: null, detail: {} };
  const pcts = indexes.filter((i) => ['上证指数', '深证成指', '创业板指'].includes(i.name)).map((i) => i.changePct).filter((v) => v !== null && v !== undefined);
  const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  if (avg !== null) { temp.idx = avg > 0.5 ? 20 : avg >= 0 ? 12 : avg > -0.5 ? 8 : 4; temp.detail.idx = `指数 ${round(avg)}%`; }
  if (pool.length) {
    let up = 0, down = 0, lu = 0, ou = 0, br = 0;
    for (const s of pool) {
      if (s.pct > 0) up++; else if (s.pct < 0) down++;
      const th = /^(30|68)/.test(s.code) ? 19 : /^(4|8)/.test(s.code) ? 29 : 9.5;
      if (s.pct >= th) lu++;
      if (s.open && s.preClose) { const op = ((s.open - s.preClose) / s.preClose) * 100; if (op > 3) { ou++; if (s.pct < op - 2) br++; } }
    }
    const ur = up / pool.length;
    temp.breadth = ur > 0.6 ? 20 : ur > 0.45 ? 12 : ur > 0.3 ? 8 : 4;
    temp.detail.breadth = `涨跌 ${up}/${down}`;
    temp.emo = lu > 60 ? 20 : lu > 30 ? 14 : lu > 12 ? 9 : lu > 5 ? 5 : 2;
    temp.detail.emo = `涨停 ${lu}`;
    const rate = ou ? br / ou : 0;
    temp.rate = rate < 0.2 ? 20 : rate < 0.4 ? 12 : rate < 0.6 ? 6 : 2;
    temp.detail.rate = `炸板 ${round(rate * 100, 0)}%`;
  }
  try {
    const t = await getTrends('000001').catch(() => null);
    if (t && t.length > 15) {
      const tail = t.slice(-15);
      const slope = ((tail[tail.length - 1].price - tail[0].price) / tail[0].price) * 100;
      temp.m15 = slope > 0.1 ? 20 : slope > -0.05 ? 12 : slope > -0.2 ? 6 : 2;
      temp.detail.m15 = `15分 ${round(slope)}%`;
    }
  } catch (e) { temp.m15 = 12; }
  temp.total = Math.round(temp.idx + temp.breadth + temp.emo + temp.rate + temp.m15);
  const status = temp.total >= 70 ? 'ok' : temp.total >= 50 ? 'warn' : 'no';
  return { shPct, temp, status };
}

// ---------- 分时分析（与 t1.js 一致） ----------
function analyzeIntraday(trends, preClose) {
  if (!trends || trends.length < 100 || !preClose) return null;
  const pts = trends.map((t) => ({ time: t.time.slice(11), price: t.price, avg: t.avg, vol: t.volume }));
  const pctOf = (p) => ((p - preClose) / preClose) * 100;
  const at = (hm) => { const p = pts.find((x) => x.time === hm); return p ? { pct: pctOf(p.price), price: p.price } : null; };
  const open = at('09:30'), t1430 = at('14:30'), t1455 = at('14:55');
  const last = pts[pts.length - 1];
  const pctNow = pctOf(last.price);
  const delta = t1430 && t1455 ? round(t1455.pct - t1430.pct, 2) : null;
  const morning = pts.filter((x) => x.time >= '09:30' && x.time <= '11:30');
  const afternoon = pts.filter((x) => x.time >= '13:00' && x.time <= '14:30');
  const tail = pts.filter((x) => x.time >= '14:30');
  const morningPct = morning.length && open ? round(pctOf(morning[morning.length - 1].price) - pctOf(morning[0].price)) : null;
  const afternoonRange = afternoon.length ? round((Math.max(...afternoon.map((x) => x.price)) - Math.min(...afternoon.map((x) => x.price))) / preClose * 100) : null;
  const p945 = at('09:45'), p1030 = at('10:30'), p1100 = at('11:00');
  const morningTrend = p945 && p1030 && p1100 ? p1030.price > p945.price && p1100.price >= p1030.price : null;
  let tailVol = null;
  if (tail.length >= 2) tailVol = round((Math.max(...tail.map((x) => x.price)) - Math.min(...tail.map((x) => x.price))) / preClose * 100);
  const dayHigh = Math.max(...pts.map((x) => x.price));
  const dayLow = Math.min(...pts.map((x) => x.price));
  const closePos = dayHigh > dayLow ? round(((last.price - dayLow) / (dayHigh - dayLow)) * 100, 0) : null;
  const dayHighTime = dayHigh > 0 ? (pts.find((x) => x.price === dayHigh) || {}).time || null : null;
  const tailNewHigh = dayHighTime !== null && dayHighTime >= '14:30';
  const tailMax = Math.max(...tail.map((x) => x.price));
  let pullbackFromTailHigh = null;
  if (tailMax) { const i = tail.findIndex((x) => x.price === tailMax); if (i >= 0 && i < tail.length - 2) pullbackFromTailHigh = round((tailMax - last.price) / tailMax * 100); }
  return { openPct: round(pctOf(open.price)), pctAt1430: t1430 ? round(t1430.pct) : null, pctAt1455: t1455 ? round(t1455.pct) : null, pctNow: round(pctNow), delta, morningPct, morningTrend, afternoonRange, tailVol, closePos, dayHighTime, tailNewHigh, pullbackFromTailHigh, aboveAvgRatio: round(pts.filter((x) => x.price >= x.avg).length / pts.length * 100, 0) };
}

// ---------- 资金类型 / 拥挤 / 隔夜适配 / 评分 / 裁决（与 t1.js 一致） ----------
function classifyFund(d) {
  const flags = [];
  const suddenTail = d.delta !== null && d.delta >= 1.5;
  const flatThenRush = (d.pctAt1430 === null || d.pctAt1430 <= 1.5) && suddenTail;
  if (flatThenRush) flags.push('尾盘偷袭'); else if (suddenTail) flags.push('尾盘抢筹');
  const oversold = (d.pct20 !== null && d.pct20 <= -12);
  if (oversold && d.pctNow >= 2) flags.push('超跌反弹');
  const trendStrong = d.morningTrend === true && (d.delta !== null && Math.abs(d.delta) <= 1.5) && !flatThenRush && (d.volMulti !== null && d.volMulti >= 1.2 && d.volMulti <= 3.5);
  if (trendStrong) flags.push('趋势真强');
  const overnightStrong = (d.dayHighTime !== null && d.dayHighTime < '10:30') && !d.tailNewHigh && (d.delta !== null && Math.abs(d.delta) <= 1) && (d.closePos !== null && d.closePos >= 55) && (d.volMulti !== null && d.volMulti >= 1.5 && d.volMulti <= 3) && (d.boardPct !== null && d.boardPct <= 5) && (d.pct20 !== null && d.pct20 <= 22);
  if (overnightStrong) flags.push('隔夜真强');
  if (!flags.length) flags.push('中性');
  return flags;
}
function crowdingScore(s) {
  let c = 0;
  if (s.pct5 !== null && s.pct5 > 12) c++;
  if (s.pct5 !== null && s.pct5 > 20) c++;
  if (s.pct20 !== null && s.pct20 > 20) c++;
  if (s.pct20 !== null && s.pct20 > 30) c++;
  if (s.pctNow !== null && s.pctNow > 7) c++;
  if (s.turnover !== null && s.turnover > 8) c++;
  if (s.boardPct !== null && s.boardPct > 5) c++;
  return c <= 1 ? '低拥挤' : c <= 3 ? '中拥挤' : '高拥挤';
}
function overnightFitScore(s) {
  let f = 0;
  if (s.dayHighTime !== null && s.dayHighTime !== undefined) {
    if (s.dayHighTime < '10:30') f += 25; else if (s.dayHighTime <= '13:30') f += 15; else if (s.dayHighTime <= '14:30') f += 8; else f += 2;
  }
  if (!s.tailNewHigh) f += 20; else f -= 10;
  if (s.delta !== null && Math.abs(s.delta) <= 1) f += 15; else if (s.delta !== null && Math.abs(s.delta) > 1.5) f -= 15;
  if (s.closePos !== null && s.closePos >= 80) f += 15; else if (s.closePos !== null && s.closePos < 50) f -= 10;
  if (s.volMulti !== null && s.volMulti >= 1.5 && s.volMulti <= 3) f += 15; else if (s.volMulti !== null && s.volMulti > 5) f -= 10;
  if (s.crowding === '低拥挤') f += 10; else if (s.crowding === '高拥挤') f -= 10;
  return Math.max(0, Math.min(100, f));
}
function scoreModel(s, shPct) {
  const parts = { trend: 0, fund: 0, sector: 0, time: 0 };
  if (s.aboveMa20) parts.trend += 10;
  if (s.aboveMa60) parts.trend += 10;
  if (s.newHigh) parts.trend += 5;
  if (s.pct20 !== null && s.pct20 > 25) parts.trend -= 5;
  if (s.pct20 !== null && s.pct20 > 35) parts.trend -= 5;
  if (s.volMulti !== null && s.volMulti >= 1.5 && s.volMulti <= 3) parts.fund += 10;
  if (s.mainInflow > 0) parts.fund += 10;
  if (s.turnover >= 5 && s.turnover <= 8) parts.fund += 10; else if (s.turnover > 8 && s.turnover <= 10) parts.fund += 6;
  if (s.boardPct !== null && s.boardPct > 0) parts.sector += 10;
  if (s.boardRankPct !== null && s.boardRankPct <= 5) parts.sector += 10;
  if (s.boardPct !== null && s.boardPct >= 1 && s.boardPct <= 5) parts.sector += 5; else if (s.boardPct !== null && s.boardPct > 5 && s.boardPct <= 7) parts.sector += 2;
  if (s.dayHighTime !== null && s.dayHighTime !== undefined) {
    if (s.dayHighTime < '10:30') parts.time += 8; else if (s.dayHighTime <= '13:30') parts.time += 4; else if (s.dayHighTime <= '14:30') parts.time += 1;
  }
  if (s.delta !== null && Math.abs(s.delta) <= 1) parts.time += 6;
  if (s.pullbackFromTailHigh !== null && s.pullbackFromTailHigh <= 1) parts.time += 4;
  if (s.closePos !== null && s.closePos >= 80) parts.time += 2; else if (s.closePos !== null && s.closePos < 50) parts.time -= 2;
  if (s.tailNewHigh) parts.time -= 2;
  let relBonus = 0;
  if (shPct !== null && shPct !== undefined) {
    const rel = s.pctNow - shPct;
    if (rel >= 4) relBonus = 5; else if (rel >= 2) relBonus = 3; else if (rel >= 1) relBonus = 2; else if (rel >= 0) relBonus = 1;
  }
  const total = Math.min(100, parts.trend + parts.fund + parts.sector + parts.time + relBonus);
  return { total, parts, relBonus };
}
function overnightGate(marketTotal) {
  if (marketTotal === null || marketTotal === undefined) return { tier: 'unknown', allow: true, requireQ: 75, requireO: 75, label: '温度未知' };
  if (marketTotal >= 70) return { tier: 'ok', allow: true, requireQ: 75, requireO: 75, label: '正常交易（温度≥70，Q≥75 且 O≥75）' };
  if (marketTotal >= 50) return { tier: 'warn', allow: true, requireQ: 80, requireO: 80, label: '精选交易（温度50-69，Q≥80 且 O≥80）' };
  return { tier: 'no', allow: false, requireQ: Infinity, requireO: Infinity, label: '禁止隔夜交易（温度<50）' };
}

// ---------- 主流程 ----------
async function main() {
  const t0 = Date.now();
  const pool = await getStockPool();
  const env = await getMarketEnv(pool);
  const shPct = env.shPct;
  // 初筛 + 漏斗
  const funnel = { total: pool.length, rejectST: 0, rejectLimit: 0, rejectPct: 0, rejectVolRatio: 0, rejectTurnover: 0, rejectMktcap: 0, passed: 0 };
  const candidates = [];
  for (const s of pool) {
    if (!s.code || !/^\d{6}$/.test(s.code)) continue;
    if (/ST|退|N\*/.test(s.name) || /^N|^C/.test(s.code)) { funnel.rejectST++; continue; }
    if (s.pct >= 9.4) { funnel.rejectLimit++; continue; }
    if (!s.pct || s.pct < 2 || s.pct > 8) { funnel.rejectPct++; continue; }
    if (!s.volRatio || s.volRatio < 1.2) { funnel.rejectVolRatio++; continue; }
    if (!s.turnover || s.turnover < 3 || s.turnover > 12) { funnel.rejectTurnover++; continue; }
    if (!s.floatMv || s.floatMv < 50e8 || s.floatMv > 200e8) { funnel.rejectMktcap++; continue; }
    candidates.push({ ...s });
  }
  funnel.passed = candidates.length;
  // Benchmark（原网页策略：涨幅榜前500+强于大盘1%+轻量过滤）
  const benchmark = pool.slice(0, 500).filter((s) => s.pct >= 2 && s.pct < 9.4 && (shPct !== null && shPct !== undefined ? s.pct - shPct >= 1 : true) && s.volRatio >= 1.2 && s.turnover >= 3 && s.turnover <= 12 && s.floatMv >= 50e8 && s.floatMv <= 200e8 && !/ST|退/.test(s.name)).slice(0, 10).map((s) => ({ code: s.code, name: s.name, pct: round(s.pct), volRatio: round(s.volRatio), turnover: round(s.turnover), industry: s.industry || '--' }));
  // 板块排名
  let boardRank = {};
  try {
    const boards = await getIndustryBoards();
    const total = boards.length;
    boards.forEach((b, i) => { boardRank[b.name] = { rank: i + 1, total, pct: b.pct }; });
  } catch (e) { /* skip */ }
  // 精筛（并发5）
  const refined = [];
  const CONC = 5;
  for (let i = 0; i < candidates.length; i += CONC) {
    const batch = await Promise.all(candidates.slice(i, i + CONC).map(async (s) => {
      const r = { ...s, aboveAvgRatio: null, pct5: null, pct20: null, boardPct: null, boardRankPct: null, volMulti: null, aboveMa20: false, aboveMa60: false, newHigh: false, mainInflow: 0, delta: null, fundTypes: [], dataStatus: 'ok', flags: [] };
      try {
        const [trends, kline] = await Promise.all([getTrends(s.code).catch(() => null), getKline(s.code, 70).catch(() => [])]);
        if (!trends) { r.dataStatus = 'invalid'; return null; }
        const intraday = analyzeIntraday(trends, s.preClose);
        if (!intraday) { r.dataStatus = 'invalid'; return null; }
        Object.assign(r, intraday);
        // 量能/趋势（20日）
        if (kline.length >= 21) {
          const vols = kline.map((b) => b.volume);
          const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
          r.volMulti = avg20 > 0 ? round(s.volume / avg20) : null;
          const closes = kline.map((b) => b.close);
          const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
          const ma60 = closes.length >= 60 ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60 : null;
          r.aboveMa20 = r.price > ma20;
          r.aboveMa60 = ma60 !== null && r.price > ma60;
          const prev20 = closes[closes.length - 21];
          r.newHigh = prev20 !== undefined && Math.max(...closes.slice(-21)) === closes[closes.length - 1];
          r.pct5 = closes.length >= 6 ? round((closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100) : null;
          r.pct20 = closes.length >= 21 ? round((closes[closes.length - 1] / closes[closes.length - 21] - 1) * 100) : null;
        }
        if (s.industry && boardRank[s.industry]) {
          const b = boardRank[s.industry];
          r.boardPct = round(b.pct, 2);
          r.boardRankPct = round((b.rank / b.total) * 100, 1);
        }
        r.mainInflow = await getMainInflow(s.code).catch(() => 0);
        // 数据质量
        if (r.volMulti !== null && (r.volMulti < 0.1 || r.volMulti > 50)) { r.dataStatus = 'invalid'; }
        r.fundTypes = classifyFund(r);
        r.crowding = crowdingScore(r);
        const sc = scoreModel(r, shPct);
        r.totalScore = sc.total;
        r.scoreParts = sc.parts;
        r.relBonus = sc.relBonus;
        r.overnightFit = overnightFitScore(r);
        if (r.totalScore < 60) return null;
        return r;
      } catch (e) { return null; }
    }));
    batch.forEach((r) => { if (r) refined.push(r); });
  }
  refined.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const marketScore = env.temp.total;
  const gate = overnightGate(marketScore);
  const isFriday = new Date().getDay() === 5;
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  // 档位：strict(14:44:30-14:46:30) / near(14:29:30-15:00) / late(15:00后)
  const tier = (hm >= 14 * 60 + 44.5 && hm <= 14 * 60 + 46.5) ? 'strict' : (hm >= 14 * 60 + 29.5 && hm <= 15 * 60) ? 'near' : 'late';
  const late = tier === 'late';
  const stocks = refined.map((s) => {
    const q = s.totalScore || 0, o = s.overnightFit || 0;
    const dataOk = s.dataStatus === 'ok' || !s.dataStatus;
    const passed = gate.allow && dataOk && q >= gate.requireQ && o >= gate.requireO;
    return { code: s.code, name: s.name, price: round(s.price), pct: round(s.pct), industry: s.industry || '--', volMulti: s.volMulti, turnover: round(s.turnover), delta: s.delta, dayHighTime: s.dayHighTime, tailNewHigh: s.tailNewHigh, closePos: s.closePos, crowding: s.crowding, fundTypes: s.fundTypes, qualityScore: q, overnightScore: o, marketScore, dataStatus: s.dataStatus, passed, recommendation: passed ? '可买' : (gate.allow ? '观望' : '禁止'), shadow: dataOk && !passed && (((q >= 70 && q <= 84) || (o >= 65 && o <= 79))) };
  });
  const snap = {
    generatedAt: now.toLocaleString('zh-CN', { hour12: false }),
    signalTime: now.toISOString(),
    sampleTier: tier,
    lateSnapshot: late,
    dataValid: !late,
    date: now.toISOString().slice(0, 10),
    marketScore,
    marketState: env.status,
    marketLabel: `${env.status === 'ok' ? '🟢' : env.status === 'warn' ? '🟡' : '🔴'} 短线市场温度 ${marketScore}/100`,
    gate,
    weekendHold: isFriday,
    funnel,
    benchmark,
    formal: stocks.filter((s) => s.passed),
    candidates: stocks.filter((s) => !s.passed && !s.shadow),
    shadow: stocks.filter((s) => s.shadow).map((s) => ({ code: s.code, name: s.name, quality: s.qualityScore, overnight: s.overnightScore, crowding: s.crowding })),
    all: stocks.map((s) => ({ code: s.code, name: s.name, industry: s.industry, quality: s.qualityScore, overnight: s.overnightScore, passed: s.passed, shadow: !!s.shadow, dataStatus: s.dataStatus })),
  };
  const out = process.argv[2] || 't1_snapshot.json';
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap, null, 2));
  console.log(`✅ 快照已生成: ${snap.date} | late=${late} | 温度 ${marketScore} | 正式 ${snap.formal.length} | 影子 ${snap.shadow.length} | Benchmark ${benchmark.length} | 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (snap.formal.length) snap.formal.forEach((s) => console.log(`  ✅ ${s.name} Q${s.qualityScore}/O${s.overnightScore} ${s.fundTypes.join('/')}`));
  return snap;
}

main().catch((e) => { console.error('快照失败:', e.message); process.exit(1); });
