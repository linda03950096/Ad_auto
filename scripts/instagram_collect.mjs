import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath        = path.join(root, "instagram_sources.json");
const queuePath         = path.join(root, "instagram_queue.json");
const brandCachePath    = path.join(root, "instagram_brands_cache.json");
const brandsLearnedPath = path.join(root, "brands_learned.json");
const shouldPublish     = process.argv.includes("--publish");

// ── Gemini API 직접 호출 (Node.js https) ───────────────────
import https from "node:https";
function callGemini(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch { reject(new Error('Gemini 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Gemini 타임아웃')); });
    req.write(body);
    req.end();
  });
}

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

// ── 팔로워 수 + 브랜드명 + 바이오 캐시 (프로필 방문, 세션 내 1회) ──
const followerCache = new Map();
async function visitProfile(page, username) {
  if (!username) return { followers: null, displayName: null, bio: null };
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
      // og:description에서 바이오 추출 (팔로워 수, 포스트 수 뒤에 바이오가 있음)
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
      // 형식: "X Followers, Y Following, Z Posts - See Instagram photos and videos from ..."
      // 바이오는 페이지 본문의 특정 영역에 있음
      const bio = ogDesc.replace(/^[\d,.]+ Followers.*?- /i, '').slice(0, 200).trim() || null;
      return { followers, displayName, bio };
    });
    followerCache.set(username, result);
    return result;
  } catch {
    const result = { followers: null, displayName: null, bio: null };
    followerCache.set(username, result);
    return result;
  }
}
async function getFollowerCount(page, username) {
  return (await visitProfile(page, username)).followers;
}

// ── 미등록 브랜드 자동 학습 (Instagram @멘션 → Gemini 분류 → brands_learned.json) ──
const brandCache = new Map();   // handle → koreanName (beauty only, 기존 호환)
const brandsLearned = new Map(); // handle → { koreanName, isBeauty, learnedAt }

async function loadBrandCache() {
  const data = await readJson(brandCachePath, {});
  for (const [k, v] of Object.entries(data)) brandCache.set(k.toLowerCase(), v);
}
async function loadBrandsLearned() {
  const data = await readJson(brandsLearnedPath, {});
  for (const [k, v] of Object.entries(data)) brandsLearned.set(k.toLowerCase(), v);
}
async function saveBrandCache(config) {
  const obj = Object.fromEntries(brandCache);
  await writeJson(brandCachePath, obj);
  // worktree/GitHub Pages 디렉터리에도 동기화
  for (const extraDir of (config.additionalQueuePaths || [])) {
    try {
      await writeJson(path.resolve(root, extraDir, "instagram_brands_cache.json"), obj);
    } catch {}
  }
}
async function saveBrandsLearned(config) {
  const obj = Object.fromEntries(brandsLearned);
  await writeJson(brandsLearnedPath, obj);
  for (const extraDir of (config.additionalQueuePaths || [])) {
    try {
      await writeJson(path.resolve(root, extraDir, "brands_learned.json"), obj);
    } catch {}
  }
}

// Gemini로 계정 목록을 뷰티 브랜드인지 일괄 분류
async function classifyBrandsWithGemini(apiKey, accountInfos) {
  // accountInfos: [{ handle, displayName, bio }]
  if (!apiKey || !accountInfos.length) return [];
  const lines = accountInfos.map(a =>
    `- handle: ${a.handle}, 표시이름: "${a.displayName || ''}", 소개글: "${(a.bio || '').slice(0, 100)}"`
  ).join('\n');
  const prompt = `다음 인스타그램 계정들이 뷰티/메이크업/향수/스킨케어 브랜드 공식 계정인지 판단해주세요.
개인 인플루언서, 아이돌, 연예인, 일반인 계정은 isBeauty: false로 분류해주세요.
브랜드라면 한국에서 통용되는 한국어 브랜드명(짧고 간결하게)도 알려주세요.

계정 목록:
${lines}

반드시 JSON 배열만 출력해주세요 (다른 설명 없이):
[
  {"handle": "계정명", "isBeauty": true/false, "koreanName": "한국어브랜드명 또는 null"}
]`;
  try {
    const raw = await callGemini(apiKey, prompt);
    // JSON 배열 추출
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn('  Gemini 분류 실패:', e.message);
    return [];
  }
}

async function autoDiscoverBrands(page, captions, config) {
  await loadBrandCache();
  await loadBrandsLearned();

  // 캡션에서 @멘션 추출, 빈도 집계
  const counts = new Map();
  for (const cap of captions) {
    for (const [, h] of (cap.matchAll(/@([\w.]+)/g) || [])) {
      const handle = h.toLowerCase();
      // 이미 알고 있는 계정은 건너뜀
      if (BUILT_IN_BRANDS.has(handle)) continue;
      if (brandCache.has(handle)) continue;
      if (brandsLearned.has(handle)) continue;
      counts.set(handle, (counts.get(handle) || 0) + 1);
    }
  }

  const toLookup = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)   // 최대 30개 계정 조회
    .map(([h]) => h);

  if (!toLookup.length) {
    console.log('\n  새로 조회할 @멘션 계정 없음.');
    return;
  }
  console.log(`\n🔍 브랜드 자동 학습: @멘션 ${toLookup.length}개 계정 프로필 조회...`);

  // 1단계: 프로필 방문으로 displayName + bio 수집
  const accountInfos = [];
  for (const handle of toLookup) {
    const { displayName, bio } = await visitProfile(page, handle);
    accountInfos.push({ handle, displayName: displayName || handle, bio: bio || '' });
    console.log(`  @${handle} → "${displayName || '?'}"`);
  }

  // 2단계: Gemini로 뷰티 브랜드 일괄 분류
  const geminiKey = config.geminiKey || '';
  let classifications = [];
  if (geminiKey) {
    console.log(`\n  🤖 Gemini로 ${accountInfos.length}개 계정 뷰티 브랜드 분류 중...`);
    classifications = await classifyBrandsWithGemini(geminiKey, accountInfos);
  } else {
    console.log('  ⚠️  Gemini 키 없음 — displayName을 브랜드명으로 저장합니다.');
    classifications = accountInfos.map(a => ({ handle: a.handle, isBeauty: true, koreanName: a.displayName }));
  }

  // 3단계: 결과 저장
  let beautyCount = 0;
  for (const cls of classifications) {
    const handle = cls.handle?.toLowerCase();
    if (!handle) continue;
    const isBeauty = Boolean(cls.isBeauty);
    const koreanName = isBeauty ? (cls.koreanName || null) : null;
    const learnedAt = new Date().toISOString().slice(0, 10);
    brandsLearned.set(handle, { koreanName, isBeauty, learnedAt });
    if (isBeauty && koreanName) {
      brandCache.set(handle, koreanName);  // 기존 brands_cache에도 추가 (프론트 호환)
      beautyCount++;
      console.log(`  ✅ 뷰티 브랜드: @${handle} → "${koreanName}"`);
    } else {
      console.log(`  ⬜ 비브랜드: @${handle}`);
    }
  }

  // 아직 분류 안 된 것들 (Gemini 응답 누락) — displayName 그대로 저장
  const classifiedHandles = new Set(classifications.map(c => c.handle?.toLowerCase()).filter(Boolean));
  for (const ai of accountInfos) {
    if (!classifiedHandles.has(ai.handle) && !brandsLearned.has(ai.handle)) {
      brandsLearned.set(ai.handle, { koreanName: ai.displayName, isBeauty: true, learnedAt: new Date().toISOString().slice(0, 10) });
      brandCache.set(ai.handle, ai.displayName);
    }
  }

  await saveBrandCache(config);
  await saveBrandsLearned(config);
  console.log(`\n  💾 자동 학습 완료: 뷰티 브랜드 ${beautyCount}개 신규 등록`);
}

// ── 포스트 상세 스크랩 ─────────────────────────────────────
// 연속 rate-limit 감지 카운터
let _rateLimitStreak = 0;
const RATE_LIMIT_BAIL = 3; // 연속 3회 429 → 스크랩 중단

async function enrichPost(page, item) {
  // shortcode 추출 (예: https://www.instagram.com/p/ABC123/ → ABC123)
  const shortcodeMatch = item.url.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
  const shortcode = shortcodeMatch?.[2] || null;

  // ── 1단계: embed URL 시도 (공개, 로그인 불필요) ────────────
  if (shortcode) {
    try {
      const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
      console.log(`  Enriching (embed): ${embedUrl}`);
      await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(2000);

      const embedDetails = await page.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const bodyHtml  = document.body?.innerHTML || "";

        // embed가 실패하면 본문이 거의 비어있음
        if (bodyText.length < 30) return null;

        // 캡션: .Caption, ._a9zs, article 내 텍스트
        let caption = "";
        for (const sel of [".Caption", "._a9zs", "article .C4VMK span", "article"]) {
          const el = document.querySelector(sel);
          const t = el?.innerText?.trim();
          if (t && t.length > 10) { caption = t; break; }
        }
        // 캡션이 없으면 본문 전체에서 추출 시도
        if (!caption) {
          // embed HTML에서 <span> 태그들 중 가장 긴 것
          const spans = [...document.querySelectorAll("span, p")];
          const longest = spans.reduce((a, b) => (b.innerText?.length > a.innerText?.length ? b : a), { innerText: "" });
          if (longest.innerText?.length > 10) caption = longest.innerText.trim();
        }

        // 사용자명: .UsernameText, ._aaqt, a[href*="/"] 등
        let username = "";
        for (const sel of [".UsernameText", "._aaqt", "a.UserName", ".user a"]) {
          const el = document.querySelector(sel);
          const t = el?.innerText?.trim();
          if (t && t.length > 0) { username = t.replace(/^@/, ""); break; }
        }
        // href에서 추출 시도
        if (!username) {
          const a = document.querySelector("a[href^='/']");
          if (a) username = a.getAttribute("href").replace(/\//g, "") || "";
        }

        // 이미지: og:image 또는 img 태그
        const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
        const imgSrc  = document.querySelector("img.EmbedVideo, img")?.src || "";
        const image   = ogImage || imgSrc;

        // 게시 날짜
        const timeEl  = document.querySelector("time[datetime]");
        const postedAt = timeEl?.getAttribute("datetime") || null;

        // 좋아요 수
        let likeText = "";
        const m = bodyText.match(/(\d[\d,.]+)\s*(?:likes?|좋아요)/i);
        if (m) likeText = m[0];

        return { caption: caption.slice(0, 4000), username, image, postedAt, likeText };
      });

      if (embedDetails && (embedDetails.caption || embedDetails.username)) {
        _rateLimitStreak = 0;
        const likes = parseLikeCount(embedDetails.likeText);
        console.log(`  ✅ embed 성공 @${embedDetails.username || "?"} caption=${embedDetails.caption.slice(0,40)}...`);
        return { ...item, ...embedDetails, likes: likes ?? null, status: "enriched", enrichedAt: nowIso() };
      }
      console.log(`  embed 응답 비어있음, 직접 URL 시도...`);
    } catch (e) {
      console.log(`  embed 실패 (${e.message}), 직접 URL 시도...`);
    }
  }

  // ── 2단계: 직접 포스트 URL 시도 (로그인 세션 활용) ─────────
  try {
    console.log(`  Enriching (direct): ${item.url}`);
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(3000);

    const details = await page.evaluate(() => {
      const meta = (prop) =>
        document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute("content") || "";

      const currentUrl = location.href;
      const isRateLimited =
        (!currentUrl.includes("/p/") && !currentUrl.includes("/reel")) ||
        document.title === "Instagram" ||
        document.title === "페이지를 사용할 수 없음" ||
        document.body.innerText.includes("Too many requests") ||
        (document.body.innerText.includes("로그인") && document.body.innerText.length < 2000);

      let caption = "";
      for (const sel of ["h1", "article div > span > span", "article span"]) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim().length > 15) { caption = el.textContent.trim(); break; }
      }
      if (!caption) caption = meta("og:description");

      const titleMeta = meta("og:title");
      let username = "";
      const tm1 = titleMeta.match(/^([\w.]+)\s+on Instagram/i);
      const tm2 = titleMeta.match(/^(.+?)\s*\(@([\w.]+)\)/);
      if (tm1) username = tm1[1];
      else if (tm2) username = tm2[2];
      else username = titleMeta.match(/^@?([\w.]+)/)?.[1] || "";
      if (username.toLowerCase() === "instagram") username = "";

      const timeEl  = document.querySelector("time[datetime]");
      const postedAt = timeEl?.getAttribute("datetime") || null;

      let likeText = "";
      const likeEl = document.querySelector('[aria-label*="like"], [aria-label*="좋아요"]');
      if (likeEl) likeText = likeEl.getAttribute("aria-label") || likeEl.textContent || "";
      if (!likeText) {
        const bodyText = document.body.innerText.slice(0, 3000);
        const m = bodyText.match(/(\d[\d,.]+)\s*(?:likes?|좋아요|명이 좋아)/i)
                || bodyText.match(/좋아요\s*(\d[\d,.]+)/i);
        if (m) likeText = m[0];
      }

      return { caption: caption.slice(0, 4000), image: meta("og:image"), username, postedAt, likeText, isRateLimited };
    });

    if (details.isRateLimited) {
      _rateLimitStreak++;
      console.warn(`  ⚠️  Rate-limit 감지 (${_rateLimitStreak}/${RATE_LIMIT_BAIL}): ${item.url}`);
      if (_rateLimitStreak >= RATE_LIMIT_BAIL) {
        console.error(`  🚫 연속 ${RATE_LIMIT_BAIL}회 rate-limit → 스크랩 중단.`);
        return { ...item, status: "rate-limited", rateLimitedAt: nowIso() };
      }
      await page.waitForTimeout(10000);
      return { ...item, status: "enrich-failed" };
    }

    _rateLimitStreak = 0;
    const likes = parseLikeCount(details.likeText);
    const { isRateLimited: _, ...safeDetails } = details;
    console.log(`  ✅ direct 성공 @${safeDetails.username || "?"}`);
    return { ...item, ...safeDetails, likes: likes ?? null, status: "enriched", enrichedAt: nowIso() };
  } catch (e) {
    console.error(`  Enrich failed (${item.url}): ${e.message}`);
    return { ...item, status: "enrich-failed" };
  }
}

// ── 기존 enriched 포스트에서 메이크업 해시태그 자동 추출 ──────
// 팔로우 계정·홈피드·저장 게시물 캡션에서 자주 나오는 태그를 뽑아 추가 소스로 활용
function autoDiscoverHashtagSources(existing, config) {
  const maxCount  = config.autoHashtagCount    ?? 8;   // 최대 추가할 해시태그 수
  const minOccur  = config.autoHashtagMinCount ?? 2;   // 최소 등장 횟수
  const tagCount  = new Map();

  const TRUSTED_TYPES = new Set(['account','following','saved']);
  for (const item of existing.values()) {
    if (!TRUSTED_TYPES.has(item.sourceType || '')) continue;
    if (item.status !== 'enriched') continue;
    const tags = (item.caption || '').match(/#[\w가-힣]+/g) || [];
    for (const tag of tags) {
      const clean = tag.toLowerCase();
      tagCount.set(clean, (tagCount.get(clean) || 0) + 1);
    }
  }

  // 이미 수집 중인 해시태그 URL 목록
  const existingUrls = new Set(
    (config.sources || []).map(s => s.url.toLowerCase())
  );

  const MAKEUP_HINTS = [
    '메이크업','뷰티','아이','립','파운','쿠션','블러','쉐딩','하이라이',
    '틴트','마스카라','컨실','섀도','컨투','makeup','beauty','cosmetic','kbeauty',
  ];

  return [...tagCount.entries()]
    .filter(([tag, cnt]) => {
      if (cnt < minOccur) return false;
      if (!MAKEUP_HINTS.some(h => tag.includes(h))) return false;
      const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag.replace(/^#/, ''))}/`.toLowerCase();
      return !existingUrls.has(url);
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCount)
    .map(([tag, cnt]) => {
      const clean = tag.replace(/^#/, '');
      console.log(`  🏷️  자동 발견 해시태그: ${tag} (${cnt}회)`);
      return {
        label:      `🔍 자동 ${tag}`,
        url:        `https://www.instagram.com/explore/tags/${encodeURIComponent(clean)}/`,
        sourceType: 'auto-hashtag',
      };
    });
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

  const ENRICH_ONLY      = process.argv.includes('--enrich-only');
  const MIN_LIKES        = config.minLikes              ?? 300;
  const BIG_ACCOUNT_THR  = config.bigAccountMinFollowers ?? 30000;
  const DAILY_PICK_COUNT = config.dailyPickCount         ?? 15;
  // --enrich-only 모드: 한 번에 최대 300개 분석 (새 수집 없이 기존 미분석 항목 처리)
  // 일반 모드: 기본 80개
  const MAX_ENRICH       = ENRICH_ONLY
    ? (config.maxEnrichOnlyPerRun ?? 300)
    : (config.maxEnrichPerRun     ?? 80);

  let pw;
  try { pw = await import("playwright"); }
  catch { throw new Error("Playwright not installed. Run: npm install"); }

  const queue    = await readJson(queuePath, { generatedAt: null, items: [] });
  const existing = new Map((queue.items || []).map(item => [item.id || item.url, item]));
  const profileDir = path.resolve(root, config.chromeProfileDir || ".instagram-profile");

  const context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: Boolean(config.headless),
    viewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ko-KR',
  });

  // 봇 감지 우회 (모든 페이지에 적용)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
  });
  const page = context.pages()[0] || await context.newPage();

  // ── 로그인 확인 ───────────────────────────────────────────────
  console.log('📲 인스타그램 로그인 상태 확인 중...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const isLoggedIn = await page.evaluate(() => {
    const url = location.href;
    const hasLoginForm = !!document.querySelector('input[name="username"]');
    const hasLoginLink = document.body.innerText.includes('로그인') && document.body.innerText.length < 3000;
    return !hasLoginForm && !hasLoginLink && (url.includes('instagram.com') && !url.includes('/accounts/login'));
  });

  if (!isLoggedIn) {
    console.log('\n🔐 인스타그램 로그인이 필요합니다!');
    console.log('   브라우저 창에서 인스타그램에 로그인해주세요.');
    console.log('   로그인 완료 후 자동으로 수집이 시작됩니다. (최대 3분 대기)\n');
    // 로그인 완료 대기 (피드 페이지로 이동되면 완료)
    try {
      await page.waitForFunction(
        () => !document.querySelector('input[name="username"]') && location.href.includes('instagram.com'),
        { timeout: 180000, polling: 2000 }
      );
      await page.waitForTimeout(2000);
      console.log('✅ 로그인 완료! 수집을 시작합니다.\n');
    } catch {
      console.error('❌ 로그인 타임아웃. 다시 실행해주세요.');
      await context.close();
      return;
    }
  } else {
    console.log('✅ 이미 로그인 상태입니다.\n');
  }

  // ── Ctrl+C / 오류 시 저장 보장 ─────────────────────────────
  let _shouldStop = false;
  const _onSigint = () => {
    if (_shouldStop) { process.exit(1); } // 두 번 누르면 강제 종료
    _shouldStop = true;
    console.log('\n⚠️  중단 신호 감지 — 현재까지 수집된 데이터를 저장합니다...');
    console.log('   (한 번 더 Ctrl+C 누르면 강제 종료)');
  };
  process.on('SIGINT', _onSigint);
  process.on('SIGTERM', _onSigint);

  // 3~5초 랜덤 대기 (rate-limit 방지)
  const enrichDelay = () => new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

  let added = 0;
  try {
    if (ENRICH_ONLY) {
      const pending = [...existing.values()].filter(i => i.status === 'new' || i.status === 'enrich-failed').length;
      console.log(`📋 분석 전용 모드 — 미분석 항목 ${pending}개 처리 (최대 ${MAX_ENRICH}개)`);
    } else {
      // 1단계: 해시태그 소스 수집
      for (const source of config.sources) {
        if (_shouldStop) break;
        const items = await collectFromSource(page, source, Number(config.scrollsPerSource || 6));
        for (const item of items) {
          if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
        }
      }

      // 팔로우한 계정 수집 (sourceType: "account")
      for (const account of (config.accounts || [])) {
        if (_shouldStop) break;
        if (!account) continue;
        const src = { label: `@${account}`, url: `https://www.instagram.com/${account}/`, sourceType: "account" };
        const items = await collectFromSource(page, src, Number(config.scrollsPerSource || 6));
        for (const item of items) {
          if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
        }
      }

      // 자동 해시태그 발견: 기존 팔로우/저장 게시물 캡션에서 자주 쓰는 메이크업 해시태그 추출
      if (config.autoHashtagCount !== 0) {
        const autoSources = autoDiscoverHashtagSources(existing, config);
        if (autoSources.length) {
          console.log(`\n🏷️  자동 발견 해시태그 ${autoSources.length}개 추가 수집`);
          for (const src of autoSources) {
            if (_shouldStop) break;
            const items = await collectFromSource(page, src, Math.max(2, Number(config.scrollsPerSource || 6) - 2));
            for (const item of items) {
              if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
            }
          }
        }
      }
    }

    console.log(`\nFound ${added} new post(s). Enriching (max ${MAX_ENRICH})...`);

    // 2단계: 새 포스트 상세 스크랩 (최대 MAX_ENRICH개)
    let enrichCount = 0;
    let bailOut = false;
    for (const [key, item] of existing) {
      if (bailOut || _shouldStop) break;
      if (item.status !== "new" && item.status !== "enrich-failed") continue;
      if (enrichCount >= MAX_ENRICH) break;
      const enriched = await enrichPost(page, item);
      existing.set(key, enriched);
      enrichCount++;
      if (enriched.status === "rate-limited") { bailOut = true; break; }
      await enrichDelay();
    }

    if (!_shouldStop) {
      // 2.5단계: 미등록 브랜드 이름 자동 수집
      const allCaptions = [...existing.values()].map(i => i.caption || '');
      await autoDiscoverBrands(page, allCaptions, config);
    }

    // 3단계: 필터링 — 탈락 항목은 삭제하지 않고 "filtered"로 유지
    // → 다음 크롤링 시 existing.has(id) 로 재수집 방지
    const _filter = (key, item, reason) => {
      console.log(`  ❌ ${reason}: ${item.url}`);
      existing.set(key, { ...item, status: 'filtered', filteredReason: reason, filteredAt: nowIso() });
    };

    for (const [key, item] of existing) {
      if (item.status !== "enriched") continue;

      // 광고는 무조건 제외 (모든 소스)
      if (isAdPost(item.caption)) { _filter(key, item, '광고'); continue; }

      const type = item.sourceType || "hashtag";

      if (type === "saved") {
        // 저장한 게시물: 광고만 필터, 나머지 전부 통과
        continue;
      }

      if (type === "following") {
        // 홈 피드(팔로잉): 광고만 제외, 나머지 통과
        // 내가 팔로우하는 사람들 게시물이므로 신뢰도 높음
        continue;
      }

      if (type === "account") {
        // 팔로우 계정: 제품 정보 있으면 통과 (좋아요/날짜 무관)
        if (!hasProductInfo(item.caption)) _filter(key, item, '제품 없음(팔로우계정)');
        continue;
      }

      // hashtag / explore / reels / auto-hashtag 소스: 제품 정보 없으면 제외
      if (!hasProductInfo(item.caption)) { _filter(key, item, '제품 없음'); continue; }

      // 구조화 제품 리스트("카테고리 @brand 컬러") → 좋아요 무관 통과
      if (hasStructuredProductList(item.caption)) {
        console.log(`  ✅ 구조화 제품리스트: ${item.url}`);
        continue;
      }

      // 좋아요 500 미만이면 → 팔로워 수 확인해서 대형 계정이면 통과
      if (item.likes !== null && item.likes < MIN_LIKES) {
        const followers = await getFollowerCount(page, item.username);
        if (followers === null || followers < BIG_ACCOUNT_THR) {
          _filter(key, item, `좋아요 ${item.likes ?? '?'} / 팔로워 ${followers ?? '?'}`);
          continue;
        }
        console.log(`  ✅ 대형계정(팔로워 ${followers}): ${item.url}`);
      }
    }
  } catch (e) {
    // 오류 발생해도 수집된 데이터는 저장
    console.error(`\n⚠️  크롤링 중 오류 (수집된 데이터는 저장합니다): ${e.message}`);
    _shouldStop = true;
  } finally {
    process.off('SIGINT', _onSigint);
    process.off('SIGTERM', _onSigint);
    try { await context.close(); } catch {}
  }

  // ── 중단/완료 관계없이 항상 저장 ───────────────────────────
  if (_shouldStop) {
    console.log('💾 중단 지점까지 수집된 데이터를 저장합니다...');
  }

  // 점수 기반 정렬: 아이돌 > 구조화 제품리스트 > 좋아요
  const sorted = [...existing.values()].sort((a, b) => scorePost(b) - scorePost(a));

  // todayPick 선정 — 로컬 자정 기준
  const todayLocal = new Date();
  todayLocal.setHours(0, 0, 0, 0);
  const todayCutoff = todayLocal.toISOString();
  // 7일 전 기준 (보충용)
  const week7Ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 기존 todayPick 초기화 (pickedAt도 함께 제거)
  for (const item of sorted) { item.todayPick = false; delete item.pickedAt; }

  // 1순위: 오늘 수집/Enrich된 항목 (filtered 제외)
  let pickCount = 0;
  const _pickNow = nowIso();
  for (const item of sorted) {
    if (pickCount >= DAILY_PICK_COUNT) break;
    if (item.status === 'filtered') continue;
    const lastActivity = item.enrichedAt && item.enrichedAt > (item.collectedAt||'')
      ? item.enrichedAt : (item.collectedAt || '');
    const isToday = lastActivity >= todayCutoff;
    const hasData = !!(item.caption?.trim() || item.username?.trim());
    if (isToday && hasData) { item.todayPick = true; item.pickedAt = _pickNow; pickCount++; }
  }

  // 2순위: 오늘 것만으로 부족하면 최근 7일 베스트로 보충 (filtered 제외)
  if (pickCount < DAILY_PICK_COUNT) {
    for (const item of sorted) {
      if (pickCount >= DAILY_PICK_COUNT) break;
      if (item.todayPick || item.status === 'filtered') continue;
      const lastActivity = item.enrichedAt && item.enrichedAt > (item.collectedAt||'')
        ? item.enrichedAt : (item.collectedAt || '');
      const isRecent = lastActivity >= week7Ago;
      const hasData  = !!(item.caption?.trim() || item.username?.trim());
      if (isRecent && hasData) { item.todayPick = true; item.pickedAt = _pickNow; pickCount++; }
    }
    if (pickCount > 0) console.log(`  📦 오늘 항목 부족 → 최근 7일 항목으로 보충 (총 ${pickCount}개)`);
  }

  // todayPick을 맨 앞으로, filtered는 맨 뒤에 (dedup용으로 유지)
  const items = [
    ...sorted.filter(i => i.todayPick),
    ...sorted.filter(i => !i.todayPick && i.status !== 'filtered'),
    ...sorted.filter(i => i.status === 'filtered'),
  ];

  const queueData = { generatedAt: nowIso(), items };
  await writeJson(queuePath, queueData);
  if (_shouldStop) {
    console.log(`✅ 저장 완료 (중단됨). Queue: ${items.length}개 (오늘 픽 ${pickCount}개)`);
  } else {
    console.log(`✅ 크롤링 완료. Queue: ${items.length}개 (오늘 픽 ${pickCount}개)`);
  }

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
