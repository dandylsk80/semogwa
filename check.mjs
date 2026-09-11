#!/usr/bin/env node
/* 배포 전 검사. 의존성 없이 Node 내장만 쓴다 (이 저장소엔 package.json 이 없다).
 *
 *   node check.mjs                    7개 항목 전부
 *   node check.mjs --only 사이트맵,색인  일부만
 *   node check.mjs --sample 120       지역 페이지 표본 수 (기본 40)
 *   node check.mjs -v                 통과 항목까지 전부 출력
 *
 * 워커의 fetch() 를 직접 구동해서 실제로 배포될 응답을 본다.
 * 함수 하나하나를 부르지 않는 건, 라우팅까지 지나온 결과여야 의미가 있기 때문이다.
 * D1 과 IndexNow 는 스텁으로 가로챈다 — 검사가 실제 DB 를 건드리거나
 * 검색엔진에 URL 을 제출하는 일은 없다.
 * 종료 코드 0 = 통과, 1 = 실패 (GitHub Actions 에서 그대로 게이트로 쓴다). */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const VERBOSE = argv.includes("-v") || argv.includes("--verbose");
const SAMPLE = Number(argOf("--sample", 40));
const WORKER = path.resolve(HERE, argOf("--file", "semogwa_worker.js"));
const ONLY = (argOf("--only", "") || "").split(",").map(x => x.trim()).filter(Boolean);
const ORIGIN = "https://semogwa.com";
const INDEXNOW_KEY = "41990cbcc27241c6b899d18d983370a3";

/* ── 결과 수집 ───────────────────────────────────────────────── */
const groups = [];
let cur = null;
const group = (id, title) => { cur = { id, title, pass: 0, fails: [] }; groups.push(cur); };
const ok = msg => { cur.pass++; if (VERBOSE) console.log(`    ✓ ${msg}`); };
/* where 는 어디서 틀렸는지 (경로·UA). 같은 원인이 수백 건 나와도 앞 3건만 보여준다. */
const fail = (msg, where = "") => cur.fails.push(where ? `${msg}  [${where}]` : msg);
const check = (cond, msg, where) => cond ? ok(msg) : fail(msg, where);
const wanted = id => !ONLY.length || ONLY.some(o => id.includes(o) || o.includes(id));

/* ── 워커 로드 ───────────────────────────────────────────────── */
if (!fs.existsSync(WORKER)) { console.error(`워커 파일이 없습니다: ${WORKER}`); process.exit(1); }

let worker = null, loadErr = null;
const tmp = path.join(os.tmpdir(), `semogwa-check-${process.pid}.mjs`);
try {
  fs.writeFileSync(tmp, fs.readFileSync(WORKER, "utf8"));
  worker = (await import("file://" + tmp)).default;
} catch (e) { loadErr = e; }
finally { try { fs.unlinkSync(tmp); } catch {} }

/* ── D1 스텁 ─────────────────────────────────────────────────
   prepare().bind().run() 만 흉내 낸다. 워커가 무엇을 적으려 했는지
   그대로 모아두고, 크롤러 기록·IndexNow 기록 검사에서 그 내용을 본다. */
let writes = [];
const DB = {
  prepare(sql) {
    const row = { sql, args: [] };
    return {
      bind(...args) { row.args = args; return this; },
      run() { writes.push(row); return Promise.resolve({ success: true, meta: {} }); },
      first() { writes.push(row); return Promise.resolve(null); },
      all() { writes.push(row); return Promise.resolve({ results: [] }); },
    };
  },
};
const insertsTo = t => writes.filter(w => new RegExp(`INSERT INTO ${t}\\b`, "i").test(w.sql));

/* ── IndexNow 스텁 ───────────────────────────────────────────
   진짜로 제출하면 검사를 돌릴 때마다 검색엔진에 4만 URL 이 나간다. 가로챈다. */
const realFetch = globalThis.fetch;
let indexnowPosts = [];
let stubStatus = 202;
globalThis.fetch = async (u, opt) => {
  const url = String(u && u.url ? u.url : u);
  if (/indexnow/i.test(url)) {
    indexnowPosts.push({ url, body: JSON.parse(opt.body) });
    return new Response("", { status: stubStatus });
  }
  return realFetch(u, opt);
};

/* ── 워커 호출 ───────────────────────────────────────────────── */
let waits = [];
const ENV = { DB };
const CTX = { waitUntil(p) { waits.push(Promise.resolve(p).catch(() => {})); } };
const settle = async () => { await Promise.all(waits); waits = []; };
const GET = async (p, init = {}) => {
  const { ua, ...rest } = init;
  const headers = Object.assign({}, rest.headers, ua ? { "user-agent": ua } : {});
  const r = new Request(p.startsWith("http") ? p : ORIGIN + p, { ...rest, headers, redirect: "manual" });
  const res = await worker.fetch(r, ENV, CTX);
  await settle();
  return res;
};
const body = async (p, init) => { const r = await GET(p, init); return { r, t: await r.text() }; };
const fresh = () => { writes = []; indexnowPosts = []; };

/* ── 유틸 ────────────────────────────────────────────────────── */
const text = h => h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const attr = (h, re) => { const m = h.match(re); return m ? m[1] : null; };
const ldBlocks = h => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);

/* ── 표본 수집: 사이트맵에서 실제 URL 을 가져온다 ───────────── */
let SM = "", smHeaders = null, urls = [], regionPaths = [];
if (worker) {
  const r = await GET("/sitemap.xml");
  smHeaders = r.headers;
  SM = await r.text();
  urls = [...SM.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  /* 앞쪽만 뽑으면 과목 페이지만 걸린다. 전 구간에 걸쳐 고르게 뽑는다. */
  const deep = urls.map(u => new URL(u).pathname).filter(p => p.split("/").length === 3);
  const step = Math.max(1, Math.floor(deep.length / SAMPLE));
  for (let i = 0; i < deep.length && regionPaths.length < SAMPLE; i += step) regionPaths.push(deep[i]);
}
/* 사이트맵이 죽으면 이후 검사가 전부 무의미해진다. 조용히 0건 통과로
   지나가지 않도록 여기서 끊는다. */
if (worker && !regionPaths.length) {
  group("표본", "0. 표본 수집");
  fail("사이트맵에서 지역 페이지 URL 을 얻지 못함", `/sitemap.xml → ${urls.length} URL`);
}

const pages = [];
for (const p of regionPaths) { const { r, t } = await body(p); pages.push({ p, status: r.status, html: t }); }
fresh();

/* ══ 1. 문법 ═══════════════════════════════════════════════════ */
if (wanted("문법")) {
  group("문법", "1. 문법");
  const { stderr } = await promisify(execFile)("node", ["--check", WORKER]).catch(e => e);
  check(!stderr, `node --check ${path.basename(WORKER)}`, stderr && String(stderr).split("\n")[0]);
  check(!loadErr, "ES 모듈로 로드", loadErr && loadErr.message);
  if (worker) {
    check(typeof worker.fetch === "function", "export default.fetch 존재");
    check(typeof worker.scheduled === "function", "export default.scheduled 존재 (cron)");
  }
  const wt = path.join(HERE, "wrangler.toml");
  if (fs.existsSync(wt)) {
    const s = fs.readFileSync(wt, "utf8");
    const main = attr(s, /^\s*main\s*=\s*"([^"]+)"/m);
    check(main && fs.existsSync(path.join(HERE, main)), `wrangler.toml main 파일 존재 (${main})`);
    check(/\[\[d1_databases\]\]/.test(s), "wrangler.toml D1 바인딩 존재 (크롤러 기록에 필요)");
    check(/^\s*crons\s*=/m.test(s), "wrangler.toml cron 트리거 존재");
  }
}

/* ══ 2. 라우트 ═════════════════════════════════════════════════ */
if (wanted("라우트") && worker) {
  group("라우트", "2. 라우트");
  const must = [
    ["/", "text/html"], ["/list", "text/html"], ["/regions", "text/html"],
    ["/korean", "text/html"], ["/math", "text/html"],
    ["/seoul", "text/html"], ["/seoul/math", "text/html"],
    ["/robots.txt", "text/plain"], ["/llms.txt", "text/plain"],
    ["/sitemap.xml", "xml"], ["/rss.xml", "xml"],
    ["/atom.xml", "xml"], ["/atom", "xml"],
    ["/favicon.svg", "image/svg"], ["/favicon.ico", "image/svg"], ["/og.svg", "image/svg"],
    [`/${INDEXNOW_KEY}.txt`, "text/plain"],
  ];
  for (const [p, ct] of must) {
    const r = await GET(p);
    if (r.status !== 200) { fail("200 응답", `${p} → ${r.status}`); continue; }
    const got = r.headers.get("content-type") || "";
    check(got.includes(ct), "200 + content-type", got.includes(ct) ? "" : `${p} → ${got}`);
  }
  for (const { p, status } of pages) if (status !== 200) fail("지역 페이지 200", `${p} → ${status}`);
  if (pages.every(x => x.status === 200)) ok(`지역 페이지 ${pages.length}개 전부 200`);

  const nf = await GET("/이런건-없다");
  check(nf.status === 404, "없는 경로 404", `→ ${nf.status}`);
  const www = await GET("https://www.semogwa.com/korean");
  check(www.status === 301 && (www.headers.get("location") || "").startsWith(ORIGIN),
    "www → apex 301", `→ ${www.status} ${www.headers.get("location")}`);
  const bad = await GET("/", { method: "PUT" });
  check(bad.status === 405, "허용하지 않는 메서드 405", `→ ${bad.status}`);
  fresh();
}

/* ══ 3. 사이트맵 ═══════════════════════════════════════════════ */
if (wanted("사이트맵") && worker) {
  group("사이트맵", "3. 사이트맵");
  check(urls.length > 1000, `사이트맵 URL ${urls.length.toLocaleString()}개`);
  check(urls.every(u => u.startsWith(ORIGIN + "/")), "loc 전부 절대 URL");
  /* 중복 <loc> 은 크롤 예산을 그냥 버리는 것이다. 0 건이어야 한다. */
  const seen = new Set(), dup = [];
  for (const u of urls) { if (seen.has(u)) dup.push(u); seen.add(u); }
  check(!dup.length, "URL 중복 0건", dup.slice(0, 3).join(", "));
  check(!urls.some(u => /[^\x00-\x7F]/.test(u)), "URL 전부 ASCII");
  check(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(SM), "& 이스케이프");
  check(/<lastmod>/.test(SM), "lastmod 존재");
  const lm = [...SM.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);
  check(lm.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), "lastmod 날짜 형식");
  check(new Set(lm).size > 5, `lastmod 가 한 날짜에 몰려 있지 않음 (${new Set(lm).size}종)`);
  /* 4MB 급 XML 을 매 요청 새로 만들면 크롤러가 몰릴 때 그대로 부담이 된다. */
  const cc = smHeaders && smHeaders.get("cache-control");
  check(cc && /max-age=\d+/.test(cc), "cache-control 헤더 존재", `→ ${cc}`);
  const bytes = Buffer.byteLength(SM);
  check(bytes < 10 * 1024 * 1024, `용량 ${(bytes / 1048576).toFixed(1)}MB (네이버 10MB 한도 이내)`);
  check(urls.length < 50000, `URL 수 ${urls.length.toLocaleString()}개 (5만 한도 이내)`);
  /* 분할 사이트맵은 없앴다 — 404 가 아니라 본 사이트맵으로 넘어가야 한다. */
  for (const p of ["/sitemap-0.xml", "/sitemap-1.xml", "/sitemap-9.xml"]) {
    const r = await GET(p);
    check(r.status === 301 && r.headers.get("location") === ORIGIN + "/sitemap.xml",
      "분할 사이트맵 → /sitemap.xml 301", `${p} → ${r.status} ${r.headers.get("location")}`);
  }
  /* 사이트맵에 올린 URL 이 실제로 200 인지 (표본) */
  let dead = 0;
  for (const u of urls.filter((_, i) => i % Math.ceil(urls.length / 25) === 0)) {
    if ((await GET(new URL(u).pathname)).status !== 200) { dead++; fail("사이트맵 URL 이 200 아님", u); }
  }
  if (!dead) ok("사이트맵 표본 URL 전부 200");
  fresh();
}

/* ══ 4. 크롤러기록 ═════════════════════════════════════════════ */
if (wanted("크롤러기록") && worker) {
  group("크롤러기록", "4. 크롤러 기록");
  const CASES = [
    ["Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)", "Yeti"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "bingbot"],
    ["Mozilla/5.0 (compatible; Daum/4.1; +http://cs.daum.net/faq/15/4118.html)", "Daum"],
    ["Mozilla/5.0 (compatible; Daumoa/4.1)", "Daum"],
    ["Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", "YandexBot"],
    ["Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)", "PetalBot"],
    ["Scrapy/2.11 (+https://scrapy.org)", "기타봇"],
  ];
  for (const [ua, wantBot] of CASES) {
    fresh();
    await GET("/seoul/math", { ua });
    const ins = insertsTo("crawl_hits");
    if (ins.length !== 1) { fail("봇 요청 1건 기록", `${wantBot} → ${ins.length}건`); continue; }
    const [site, bot, gotUa, host, p, status] = ins[0].args;
    check(site === "semogwa" && bot === wantBot && p === "/seoul/math" && status === 200 && host === "semogwa.com",
      `${wantBot} 분류·경로·상태 기록`, `→ bot=${bot} path=${p} status=${status} host=${host}`);
    check(gotUa === ua.slice(0, 250), `${wantBot} UA 원문 보존`);
  }
  /* 사람은 기록하지 않는다. events 와 역할이 겹치고 양만 수백 배가 된다. */
  for (const ua of [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1",
  ]) {
    fresh();
    await GET("/seoul/math", { ua });
    check(insertsTo("crawl_hits").length === 0, "사람 트래픽은 기록하지 않음", ua.slice(0, 40));
  }
  /* 404·301 도 남아야 "크롤러가 헛도는지"를 볼 수 있다 */
  fresh();
  await GET("/없는경로", { ua: "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)" });
  const nf = insertsTo("crawl_hits")[0];
  check(nf && nf.args[5] === 404, "404 응답도 기록", nf ? `→ ${nf.args[5]}` : "기록 없음");
  fresh();
  await GET("https://www.semogwa.com/korean", { ua: "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)" });
  const rd = insertsTo("crawl_hits")[0];
  check(rd && rd.args[5] === 301 && rd.args[3] === "www.semogwa.com", "www 301 도 host 와 함께 기록",
    rd ? `→ ${rd.args[3]} ${rd.args[5]}` : "기록 없음");
  /* sitemap.xml 요청이 잡혀야 "네이버가 사이트맵을 읽는지"를 답할 수 있다 */
  fresh();
  await GET("/sitemap.xml", { ua: "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)" });
  const sm = insertsTo("crawl_hits")[0];
  check(sm && sm.args[4] === "/sitemap.xml", "sitemap.xml 요청 기록", sm ? `→ ${sm.args[4]}` : "기록 없음");
  /* D1 바인딩이 없는 환경(로컬 dev)에서도 죽지 않아야 한다 */
  fresh();
  const noDb = await worker.fetch(new Request(ORIGIN + "/seoul/math",
    { headers: { "user-agent": "Mozilla/5.0 (compatible; Yeti/1.1)" } }), {}, CTX);
  check(noDb.status === 200, "DB 바인딩 없어도 응답 정상", `→ ${noDb.status}`);
  fresh();
}

/* ══ 5. IndexNow ═══════════════════════════════════════════════ */
if (wanted("IndexNow") && worker) {
  group("IndexNow", "5. IndexNow");
  /* 키 없이 열려 있으면 아무나 4만 URL 제출을 반복시킬 수 있다 */
  fresh();
  for (const p of ["/indexnow-ping", "/indexnow-ping?n=1", "/indexnow-ping?key=틀린키&n=1"]) {
    const r = await GET(p);
    check(r.status === 403, "키 없이 403", `${p} → ${r.status}`);
  }
  check(indexnowPosts.length === 0, "키 없는 요청은 제출도 하지 않음", `→ ${indexnowPosts.length}건`);

  fresh();
  const { r, t } = await body(`/indexnow-ping?key=${INDEXNOW_KEY}&start=0&n=3`);
  check(r.status === 200, "올바른 키로 200", `→ ${r.status}`);
  check(indexnowPosts.length === 1 && indexnowPosts[0].body.urlList.length === 3,
    "요청한 만큼만 제출", `→ ${indexnowPosts.length}회 / ${indexnowPosts[0]?.body.urlList.length}건`);
  check(indexnowPosts[0]?.body.key === INDEXNOW_KEY && indexnowPosts[0]?.body.host === "semogwa.com",
    "payload host·key 정상");
  check(t.includes("응답 코드: 202"), "응답 코드 표시", t.split("\n").find(x => x.includes("응답 코드")));
  const man = insertsTo("indexnow_log");
  check(man.length === 1, "수동 제출이 indexnow_log 에 1건 기록", `→ ${man.length}건`);
  if (man.length) {
    const [site, , source, startIdx, count, status, ep] = man[0].args;
    check(site === "semogwa" && source === "manual" && startIdx === 0 && count === 3 && status === 202 && /indexnow/.test(ep),
      "기록 내용(건수·응답코드·엔드포인트) 정확", `→ ${source} ${count}건 ${status} ${ep}`);
  }

  /* cron 이 실제로 기록을 남기는지. 4만 URL 이 나가지 않도록 스텁이 받는다. */
  fresh();
  await worker.scheduled({}, ENV, CTX);
  await settle();
  const cronRows = insertsTo("indexnow_log");
  check(cronRows.length >= 1, "cron 제출이 indexnow_log 에 기록", `→ ${cronRows.length}건`);
  if (cronRows.length) {
    const [, , source, , count, status] = cronRows[0].args;
    check(source === "cron" && count === 1000 && status === 202,
      "cron 기록 내용(하루 1,000건·응답코드)", `→ ${source} ${count}건 ${status}`);
  }
  check(indexnowPosts.length === 1, "cron 은 성공 시 1회만 제출", `→ ${indexnowPosts.length}회`);

  /* 429 면 절반으로 줄여 재시도하고, 그 실패까지 전부 남아야 한다 */
  fresh();
  stubStatus = 429;
  await worker.scheduled({}, ENV, CTX);
  await settle();
  stubStatus = 202;
  const retry = insertsTo("indexnow_log");
  check(retry.length === 5, "429 재시도 4회 + 최종 실패까지 기록", `→ ${retry.length}건`);
  check(retry.every(x => x.args[5] === 429), "재시도 기록 응답코드 429");
  check(retry.at(-1)?.args[8]?.includes("실패"), "최종 실패 사유 기록", retry.at(-1)?.args[8]);
  fresh();
}

/* ══ 6. SEO ════════════════════════════════════════════════════ */
if (wanted("SEO") && pages.length) {
  group("SEO", "6. SEO");
  const titles = new Map();
  const tl = [], dl = [], can = [], h1 = [], og = [], lang = [], vp = [], nv = [], ld = [];
  for (const { p, html } of pages) {
    const t = attr(html, /<title>([\s\S]*?)<\/title>/);
    const d = attr(html, /<meta name="description" content="([^"]*)"/);
    const c = attr(html, /<link rel="canonical" href="([^"]*)"/);
    if (!t || t.length < 15 || t.length > 70) tl.push(`${p} ${t ? t.length + "자" : "없음"}`);
    if (!d || d.length < 50 || d.length > 160) dl.push(`${p} ${d ? d.length + "자" : "없음"}`);
    if (c !== ORIGIN + p) can.push(`${p} → ${c}`);
    if ((html.match(/<h1[\s>]/g) || []).length !== 1) h1.push(p);
    for (const k of ["og:title", "og:description", "og:image", "og:url"])
      if (!html.includes(`property="${k}"`)) og.push(`${p} ${k}`);
    if (!/<html lang="ko">/.test(html)) lang.push(p);
    if (!/name="viewport"/.test(html)) vp.push(p);
    /* 네이버 소유확인 메타가 빠지면 서치어드바이저가 통째로 끊긴다 */
    if (!html.includes("naver-site-verification")) nv.push(p);
    for (const b of ldBlocks(html)) { try { JSON.parse(b); } catch (e) { ld.push(`${p} ${e.message.slice(0, 40)}`); } }
    if (t) titles.set(t, (titles.get(t) || 0) + 1);
  }
  const rep = (arr, msg) => arr.length ? arr.slice(0, 3).forEach(w => fail(msg, w)) : ok(`${msg} (${pages.length}p)`);
  rep(tl, "title 15~70자");
  rep(dl, "meta description 50~160자");
  rep(can, "canonical 이 자기 경로와 일치");
  rep(h1, "h1 정확히 1개");
  rep(og, "og:* 완비");
  rep(lang, 'html lang="ko"');
  rep(vp, "viewport 메타");
  rep(nv, "네이버 소유확인 메타");
  rep(ld, "JSON-LD 파싱 정상");
  const dup = [...titles].filter(([, n]) => n > 1);
  dup.length ? dup.slice(0, 3).forEach(([t, n]) => fail("title 중복", `${n}회 "${t}"`)) : ok("title 표본 내 중복 없음");
}

/* ══ 7. 색인 ═══════════════════════════════════════════════════ */
if (wanted("색인") && worker) {
  group("색인", "7. 색인");
  const robots = (await body("/robots.txt")).t;
  check(/^Sitemap:\s*https?:\/\/\S+/mi.test(robots), "robots.txt 에 Sitemap 줄");
  check(robots.includes(`${ORIGIN}/sitemap.xml`), "robots.txt Sitemap 이 /sitemap.xml 을 가리킴");
  /* Disallow: / 자체는 문제가 아니다 — SemrushBot·AhrefsBot 같은 SEO 크롤러는
     일부러 막아두고 있다. 검색엔진 블록에만 걸리면 사고다. */
  const blocks = new Map();
  let uas = [];
  for (const line of robots.split(/\r?\n/)) {
    const ua = line.match(/^\s*User-agent:\s*(\S+)/i);
    const di = line.match(/^\s*(Disallow|Allow):\s*(\S*)/i);
    if (ua) { const v = ua[1].toLowerCase(); if (!blocks.has(v)) blocks.set(v, []); uas.push(v); }
    else if (di && uas.length) { for (const u of uas) blocks.get(u).push(`${di[1].toLowerCase()} ${di[2]}`); }
    else if (!line.trim()) uas = [];
  }
  const SEARCH = ["*", "googlebot", "bingbot", "yeti", "naverbot", "daum", "daumoa"];
  const blocked = SEARCH.filter(u => (blocks.get(u) || []).includes("disallow /"));
  check(!blocked.length, "검색엔진이 차단되지 않음", blocked.join(", "));
  for (const u of ["yeti", "naverbot"]) check(blocks.has(u), `robots.txt 에 ${u} 블록 존재`);
  const scrapers = [...blocks].filter(([, d]) => d.includes("disallow /")).map(([u]) => u);
  ok(`SEO 크롤러 ${scrapers.length}종 차단 (의도된 설정)`);

  const noidx = pages.filter(x => /noindex/i.test(x.html));
  check(!noidx.length, "지역 페이지에 noindex 없음", noidx[0]?.p);
  check(!/noindex/i.test((await body("/")).t), "홈에 noindex 없음");
  const llms = (await body("/llms.txt")).t;
  check(llms.length > 300 && llms.includes("semogwa"), `llms.txt 내용 존재 (${llms.length}자)`);
  for (const f of ["/rss.xml", "/atom.xml"]) {
    const x = (await body(f)).t;
    check(/^<\?xml/.test(x.trim()), `${f} XML 선언`);
    check(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(x), `${f} & 이스케이프`);
    check((x.match(/<item[\s>]|<entry[\s>]/g) || []).length > 0, `${f} 항목 존재`);
  }
  fresh();
}

/* ── 출력 ────────────────────────────────────────────────────── */
console.log("");
let failed = 0;
for (const g of groups) {
  const n = g.fails.length;
  failed += n;
  console.log(`${n ? "❌" : "✅"} ${g.title.padEnd(18)} 통과 ${String(g.pass).padStart(3)}${n ? ` · 실패 ${n}` : ""}`);
  g.fails.slice(0, 3).forEach(f => console.log(`      ↳ ${f}`));
  if (n > 3) console.log(`      ↳ … 외 ${n - 3}건`);
}
const total = groups.reduce((s, g) => s + g.pass, 0);
console.log("");
console.log(`검사 대상: ${path.basename(WORKER)} · 지역 페이지 표본 ${pages.length}개 · 사이트맵 ${urls.length.toLocaleString()} URL`);
console.log(failed ? `실패 ${failed}건 — 배포 중단` : `전체 통과 (${total}개 항목) — 배포 가능`);
process.exit(failed ? 1 : 0);
