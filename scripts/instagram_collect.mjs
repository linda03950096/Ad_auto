import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath      = path.join(root, "instagram_sources.json");
const queuePath       = path.join(root, "instagram_queue.json");
const brandCachePath  = path.join(root, "instagram_brands_cache.json");
const shouldPublish   = process.argv.includes("--publish");

// 하드코딩된 브랜드 매핑 (index.html과 동기화)
const BUILT_IN_BRANDS = new Set([
  'banilaco_official','clio_official','clio_cosmetics','peripera_official',
  'etudeofficial','etudehouse','romandyou','romand_official','herabeauty_official',
  'laneige_kr','laneige_official','innisfreeofficial','innisfree_official',
  'espiox_official','holikaholika_official','vdl_cosmetics','luna_makeup_official',
  'naming.cosmetic','hince_official','mude_official','fwee_makeup','aoucosmetics',
  'dasique_official','wakemake_official','3ce_official','threeconcepteyes',
  'missha.official','apieu_official','too_cool_for_school_official','thesaem.official',
  'muzigae_mansion','glint__official','heartpercent','colorgram.official',
  'alternativestereo','a.chicosmetics','lummir_makeup','riskybeauty_official',
  'tooc_official','be_of_official','iam_amuse','moumou_official_','2an_official',
  'yslbeauty','diormakeup','diorbeauty','chanel.beauty','narsissist','nars_cosmetics',
  'maccosmeticskorea','maccosmetics','giorgioarmani_beauty','armanibeauty',
  'bobbibrownkorea','charlottetilbury','lauramercier','makeupforever',
  'shiseido','tomfordbeauty','givenchybeauty','valentino.beauty','hourglasscosmetics',
]);

// 크롤링 중 발견한 미등록 브랜드 캐시
const brandCache = new Map();

const nowIso = () => new Date().toISOString();

// ── 키워드 목록 ────────────────────────────────────────────
const PRODUCT_BRANDS = [
  '롬앤','rom&nd','3ce','클리오','clio','에뛰드','etude','이니스프리','innisfree',
  '라네즈','laneige','헤라','hera','설화수','아모레퍼시픽','미샤','missha',
  '토니모리','tonymoly','페리페라','peripera','에스쁘아','espoir',
  '웨이크메이크','wakemake','데이지크','dasique','가히','kahi',
  '정샘물','jung saem mool','맥','mac','샤넬','chanel','디올','dior',
  '나스','nars','랑콤','lancome','이브생로랑','ysl','샬롯틸버리','charlotte tilbury',
  '베네피트','benefit','어반디케이','urban decay','타르트','tarte',
  '닉스','nyx','메이블린','maybelline','로레알','loreal',
  '캔메이크','canmake','세자느','cezanne','바비브라운','bobbi brown',
  '라운드랩','닥터자르트','마녀공장','코스알엑스','cosrx','스킨1004',
];
const PRODUCT_KW = [
  '파운데이션','쿠션','컨실러','프라이머','블러셔','하이라이터','컨투어','쉐딩',
  '아이섀도우','섀도우','팔레트','아이라이너','마스카라','아이브로우',
  '틴트','립스틱','립글로스','립밤','세팅파우더','픽서',
  'foundation','cushion','concealer','blush','highlighter','shadow','palette',
  'liner','mascara','tint','lipstick','gloss','brow','primer',
];
const AD_KEYWORDS = [
  '#광고','#협찬','#유료광고','#광고포함','#ad ','#ad\n','#sponsored','#제품협찬',
  '#브랜드협찬','#ppaid','#paidpartnership','유료 광고','이 포스팅은 광고',
  '브랜드로부터 제품을 제공','제품을 제공받아','원고료를 받','협찬을 받',
];

function hasProductInfo(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return PRODUCT_BRANDS.some(b => lo.includes(b)) || PRODUCT_KW.some(k => lo.includes(k));
}
function isAdPost(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return AD_KEYWORDS.some(kw => lo.includes(kw.toLowerCase()));
}

// "카테고리 @brand 컬러" 구조가 명확히 있는 게시물 — 최우선 보존 대상
const STRUCT_CAT_KW = ['섀도우','블러셔','하이라이터','립','치크','틴트','아이라이너','마스카라','파운데이션','쿠션','컨실러'];
function hasStructuredProductList(caption) {
  if (!caption) return false;
  return caption.split('\n').some(line => {
    const lo = line.toLowerCase().trim();
    return STRUCT_CAT_KW.some(kw => lo.startsWith(kw)) && /@[\w.]+/.test(line);
  });
}

const IDOL_KW = [
  '아이브','뉴진스','에스파','블랙핑크','트와이스','세븐틴','르세라핌',
  'ive','newjeans','aespa','blackpink','twice','lesserafim',
  '아이유','선미','화사','청하','이효리',
];
function isIdolPost(item) {
  const text = (item.caption || '').toLowerCase();
  return IDOL_KW.some(k => text.includes(k));
}

// 게시물 우선순위 점수 (높을수록 상단)
function scorePost(item) {
  const cap = item.caption || '';
  let score = 0;
  if (isIdolPost(item))              score += 10000; // 아이돌 최우선
  if (hasStructuredProductList(cap)) score += 3000;  // 구조화 제품 리스트
  if (hasProductInfo(cap))           score += 500;
  score += Math.min(item.likes || 0, 5000);          // 좋아요 (최대 5000점)
  return score;
}
function parseLikeCount(text) {
  if (!text) return null;
  const patterns = [
    /(\d[\d,.]+)\s*(?:likes?|좋아요|명이 좋아)/i,
    /좋아요\s*(\d[\d,.]+)/i,
    /(\d[\d,.]+)\s*개.*좋아/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1].replace(/[,. ]/g, ''), 10);
  }
  return null;
}
function parseFollowerCount(text) {
  if (!text) return null;
  const m = text.match(/(\d[\d,.]+[KkMm]?)\s*(?:followers?|팔로워)/i)
          || text.match(/팔로워\s*(\d[\d,.]+[KkMm]?)/i);
  if (!m) return null;
  let n = m[1].replace(/,/g, '');
  if (/[Kk]$/.test(n)) return Math.round(parseFloat(n) * 1000);
  if (/[Mm]$/.test(n)) return Math.round(parseFloat(n) * 1000000);
  return parseInt(n, 10);
}

function normalizeInstagramUrl(url) {
  try {
    const u = new URL(url, "https://www.instagram.com");
    if (!/instagram\.com$/.test(u.hostname.replace(/^www\./, ""))) return null;
    const match = u.pathname.match(/^\/(p|reel|reels)\/([^/]+)/);
    if (!match) return null;
    const type = match[1] === "p" ? "post" : "reel";
    return { id: `${type}:${match[2]}`, type, url: `https://www.instagram.com/${match[1]}/${match[2]}/` };
  } catch { return null; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ── 팔로워 수 + 브랜드명 캐시 (프로필 방문, 세션 내 1회) ──
const followerCache = new Map();
async function visitProfile(page, username) {
  if (!username) return { followers: null, displayName: null };
  if (followerCache.has(username)) return followerCache.get(username);
  try {
    await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const result = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/(\d[\d,.]+[KkMm]?)\s*(?:followers?|팔로워)/i)
              || text.match(/팔로워\s*(\d[\d,.]+[KkMm]?)/i);
      let followers = null;
      if (m) {
        let n = m[1].replace(/,/g, '');
        if (/[Kk]$/i.test(n)) followers = Math.round(parseFloat(n) * 1000);
        else if (/[Mm]$/i.test(n)) followers = Math.round(parseFloat(n) * 1000000);
        else followers = parseInt(n, 10);
      }
      // 페이지 타이틀에서 표시 이름 추출: "모우모우 (@moumou_official_) • Instagram..."
      const titleMatch = document.title.match(/^(.+?)\s*\(@/);
      const displayName = titleMatch ? titleMatch[1].trim() : null;
      return { followers, displayName };
    });
    followerCache.set(username, result);
    return result;
  } catch {
    const result = { followers: null, displayName: null };
    followerCache.set(username, result);
    return result;
  }
}
async function getFollowerCount(page, username) {
  return (await visitProfile(page, username)).followers;
}

// ── 미등록 브랜드 이름 자동 수집 ──────────────────────────
async function loadBrandCache() {
  const data = await readJson(brandCachePath, {});
  for (const [k, v] of Object.entries(data)) brandCache.set(k.toLowerCase(), v);
}
async function saveBrandCache(config) {
  const obj = Object.fromEntries(brandCache);
  await writeJson(brandCachePath, obj);
  for (const extraDir of (config.additionalQueuePaths || [])) {
    try {
      await writeJson(path.resolve(root, extraDir, "instagram_brands_cache.json"), obj);
    } catch {}
  }
}
async function autoDiscoverBrands(page, captions, config) {
  await loadBrandCache();
  const counts = new Map();
  for (const cap of captions) {
    for (const [, h] of (cap.matchAll(/@([\w.]+)/g) || [])) {
      const handle = h.toLowerCase();
      if (!BUILT_IN_BRANDS.has(handle) && !brandCache.has(handle))
        counts.set(handle, (counts.get(handle) || 0) + 1);
    }
  }
  const toLookup = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([h]) => h);
  if (!toLookup.length) return;
  console.log(`\n브랜드명 자동 수집: ${toLookup.length}개 계정...`);
  for (const handle of toLookup) {
    const { displayName } = await visitProfile(page, handle);
    if (displayName) {
      brandCache.set(handle, displayName);
      console.log(`  @${handle} → ${displayName}`);
    }
  }
  await saveBrandCache(config);
}

// ── 포스트 상세 스크랩 ─────────────────────────────────────
async function enrichPost(page, item) {
  try {
    console.log(`  Enriching: ${item.url}`);
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(3000);

    const details = await page.evaluate(() => {
      const meta = (prop) =>
        document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute("content") || "";

      let caption = "";
      for (const sel of ["h1", "article div > span > span", "article span"]) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim().length > 15) { caption = el.textContent.trim(); break; }
      }
      if (!caption) caption = meta("og:description");

      const titleMeta = meta("og:title");
      const username  = titleMeta.match(/@?([\w.]+)/)?.[1] || "";

      // 게시 날짜
      const timeEl  = document.querySelector("time[datetime]");
      const postedAt = timeEl?.getAttribute("datetime") || null;

      // 좋아요 수
      let likeText = "";
      const likeEl = document.querySelector('[aria-label*="like"], [aria-label*="좋아요"]');
      if (likeEl) likeText = likeEl.getAttribute("aria-label") || likeEl.textContent || "";
      if (!likeText) {
        const bodyText = document.body.innerText.slice(0, 3000);
        const m = bodyText.match(/(\d[\d,.]+)\s*(?:likes?|좋아요|명이 좋아)/i)
                || bodyText.match(/좋아요\s*(\d[\d,.]+)/i);
        if (m) likeText = m[0];
      }

      return { caption: caption.slice(0, 4000), image: meta("og:image"), username, postedAt, likeText };
    });

    const likes = parseLikeCount(details.likeText);
    return { ...item, ...details, likes: likes ?? null, status: "enriched", enrichedAt: nowIso() };
  } catch (e) {
    console.error(`  Enrich failed (${item.url}): ${e.message}`);
    return { ...item, status: "enrich-failed" };
  }
}

// ── 피드 수집 (URL만) ──────────────────────────────────────
async function collectFromSource(page, source, scrolls) {
  console.log(`Collecting: ${source.label} → ${source.url}`);
  await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  console.log(`  URL: ${page.url()} / 제목: ${await page.title()}`);

  const found = new Map();
  for (let i = 0; i < scrolls; i++) {
    const links = await page.$$eval("a[href]", anchors => anchors.map(a => a.href));
    for (const href of links) {
      const item = normalizeInstagramUrl(href);
      if (item) found.set(item.id, item);
    }
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1800);
  }
  return [...found.values()].map(item => ({
    ...item,
    sourceLabel:    source.label,
    sourceUrl:      source.url,
    sourceType:     source.sourceType || "hashtag",
    collectedAt:    nowIso(),
    status:         "new",
    caption: "", image: "", username: "", note: "",
  }));
}

function publishQueue() {
  spawnSync("git", ["add", "instagram_queue.json"], { cwd: root, stdio: "inherit" });
  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root });
  if (diff.status === 0) { console.log("No queue changes to publish."); return 0; }
  spawnSync("git", ["commit", "-m", `chore: update instagram queue ${nowIso().slice(0, 10)}`], { cwd: root, stdio: "inherit" });
  return spawnSync("git", ["push", "origin", "master"], { cwd: root, stdio: "inherit" }).status ?? 1;
}

async function main() {
  const config = await readJson(configPath, null);
  if (!config?.sources?.length) throw new Error(`No sources in ${configPath}`);

  const MIN_LIKES        = config.minLikes              ?? 300;
  const BIG_ACCOUNT_THR  = config.bigAccountMinFollowers ?? 30000;
  const DAILY_PICK_COUNT = config.dailyPickCount         ?? 15;
  const MAX_ENRICH       = config.maxEnrichPerRun        ?? 80;

  let pw;
  try { pw = await import("playwright"); }
  catch { throw new Error("Playwright not installed. Run: npm install"); }

  const queue    = await readJson(queuePath, { generatedAt: null, items: [] });
  const existing = new Map((queue.items || []).map(item => [item.id || item.url, item]));
  const profileDir = path.resolve(root, config.chromeProfileDir || ".instagram-profile");

  const context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: Boolean(config.headless),
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();

  let added = 0;
  try {
    // 1단계: 해시태그 소스 수집
    for (const source of config.sources) {
      const items = await collectFromSource(page, source, Number(config.scrollsPerSource || 6));
      for (const item of items) {
        if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
      }
    }

    // 팔로우한 계정 수집 (sourceType: "account")
    for (const account of (config.accounts || [])) {
      if (!account) continue;
      const src = { label: `@${account}`, url: `https://www.instagram.com/${account}/`, sourceType: "account" };
      const items = await collectFromSource(page, src, Number(config.scrollsPerSource || 6));
      for (const item of items) {
        if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
      }
    }

    console.log(`\nFound ${added} new post(s). Enriching (max ${MAX_ENRICH})...`);

    // 2단계: 새 포스트 상세 스크랩 (최대 MAX_ENRICH개)
    let enrichCount = 0;
    for (const [key, item] of existing) {
      if (item.status !== "new") continue;
      if (enrichCount >= MAX_ENRICH) {
        existing.delete(key); // 이번 런에 처리 못한 항목은 다음 런에 처리
        continue;
      }
      const enriched = await enrichPost(page, item);
      existing.set(key, enriched);
      enrichCount++;
      await new Promise(r => setTimeout(r, 1500));
    }

    // 2.5단계: 미등록 브랜드 이름 자동 수집
    const allCaptions = [...existing.values()].map(i => i.caption || '');
    await autoDiscoverBrands(page, allCaptions, config);

    // 3단계: 필터링
    for (const [key, item] of existing) {
      if (item.status !== "enriched") continue;

      // 광고는 무조건 제외 (모든 소스)
      if (isAdPost(item.caption)) {
        console.log(`  ❌ 광고: ${item.url}`);
        existing.delete(key); continue;
      }

      const type = item.sourceType || "hashtag";

      if (type === "saved") {
        // 저장한 게시물: 광고만 필터, 나머지 전부 통과
        continue;
      }

      if (type === "account") {
        // 팔로우 계정: 제품 정보 있으면 통과 (좋아요/날짜 무관)
        if (!hasProductInfo(item.caption)) {
          console.log(`  ❌ 제품 없음(팔로우계정): ${item.url}`);
          existing.delete(key);
        }
        continue;
      }

      // hashtag 소스: 제품 정보 없으면 제외
      if (!hasProductInfo(item.caption)) {
        console.log(`  ❌ 제품 없음: ${item.url}`);
        existing.delete(key); continue;
      }

      // 구조화 제품 리스트("카테고리 @brand 컬러") → 좋아요 무관 통과
      if (hasStructuredProductList(item.caption)) {
        console.log(`  ✅ 구조화 제품리스트: ${item.url}`);
        continue;
      }

      // 좋아요 500 미만이면 → 팔로워 수 확인해서 대형 계정이면 통과
      if (item.likes !== null && item.likes < MIN_LIKES) {
        const followers = await getFollowerCount(page, item.username);
        if (followers === null || followers < BIG_ACCOUNT_THR) {
          console.log(`  ❌ 좋아요 ${item.likes ?? '?'} / 팔로워 ${followers ?? '?'}: ${item.url}`);
          existing.delete(key); continue;
        }
        console.log(`  ✅ 대형계정(팔로워 ${followers}): ${item.url}`);
      }
    }
  } finally {
    await context.close();
  }

  // 점수 기반 정렬: 아이돌 > 구조화 제품리스트 > 좋아요
  const sorted = [...existing.values()].sort((a, b) => scorePost(b) - scorePost(a));

  // 오늘 수집된 항목 중 상위 DAILY_PICK_COUNT개를 todayPick으로 태깅
  const todayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let pickCount = 0;
  for (const item of sorted) {
    const isToday = (item.collectedAt || '') >= todayCutoff;
    item.todayPick = isToday && pickCount < DAILY_PICK_COUNT;
    if (item.todayPick) pickCount++;
  }

  // todayPick을 맨 앞으로
  const items = [
    ...sorted.filter(i => i.todayPick),
    ...sorted.filter(i => !i.todayPick),
  ];

  const queueData = { generatedAt: nowIso(), items };
  await writeJson(queuePath, queueData);
  console.log(`Done. Queue: ${items.length}개 (오늘 픽 ${pickCount}개)`);

  // 추가 경로에도 동기화 (워크트리 등)
  for (const extraDir of (config.additionalQueuePaths || [])) {
    const extraPath = path.resolve(root, extraDir, "instagram_queue.json");
    try {
      await writeJson(extraPath, queueData);
      console.log(`Synced → ${extraPath}`);
    } catch (e) {
      console.warn(`Sync failed (${extraPath}): ${e.message}`);
    }
  }

  if (shouldPublish || config.publishToGit) {
    const s = publishQueue();
    if (s !== 0) process.exit(s);
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
