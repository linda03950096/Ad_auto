/**
 * X(트위터) 메이크업 게시물 수집기
 * 아이돌 메이크업 정보 / 인플루언서 메이크업 정보만 필터링하여 수집
 * 실행: node scripts/twitter_collect.mjs
 * 설정: instagram_sources.json → twitterHashtags, twitterAccounts
 */
import fs   from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const root       = path.resolve(__dirname, "..");
const configPath = path.join(root, "instagram_sources.json");
const queuePath  = path.join(root, "instagram_queue.json");
const nowIso     = () => new Date().toISOString();

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
}
async function writeJson(p, data) {
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

// ── 필터 키워드 ───────────────────────────────────────────────

// 메이크업 제품 키워드 (있어야 통과)
const PRODUCT_KW = [
  '파운데이션','쿠션','컨실러','프라이머','블러셔','블러쉬','치크','하이라이터','컨투어','쉐딩',
  '아이섀도우','섀도우','팔레트','아이라이너','마스카라','아이브로우','눈썹',
  '틴트','립스틱','립글로스','립밤','세팅파우더','픽서','세팅스프레이',
  '글로우','쉬머','매트','베이스','베이스메이크업','스킨','톤업','선크림','비비크림',
  'foundation','cushion','concealer','blush','highlighter','contour','shadow',
  'palette','liner','mascara','tint','lipstick','gloss','brow','primer',
];

// 브랜드 키워드 (있으면 제품 정보로 인정)
const BRAND_KW = [
  '롬앤','rom&nd','3ce','클리오','clio','에뛰드','etude','이니스프리','innisfree',
  '라네즈','laneige','헤라','hera','설화수','미샤','missha','페리페라','peripera',
  '에스쁘아','espoir','웨이크메이크','wakemake','데이지크','dasique','가히','kahi',
  '정샘물','맥','mac','샤넬','chanel','디올','dior','나스','nars','랑콤','lancome',
  'ysl','이브생로랑','샬롯틸버리','charlotte tilbury','베네피트','benefit',
  '닉스','nyx','메이블린','maybelline','로레알','loreal','캔메이크','canmake',
  '바비브라운','bobbi brown','로라메르시에','laura mercier','맥','hince','힌스',
  'fwee','뮤지개','muzigae','글린트','glint','heartpercent','하트퍼센트',
  '컬러그램','colorgram','루미르','lummir','too cool','더샘','thesaem',
];

// 아이돌/연예인 키워드 (이쪽 맥락이면 브랜드 없어도 통과)
const IDOL_KW = [
  '아이돌','idol','kpop','k-pop','케이팝',
  '연예인','셀럽','celeb',
  '아이브','ive','뉴진스','newjeans','에스파','aespa','블랙핑크','blackpink',
  '트와이스','twice','있지','itzy','레드벨벳','redvelvet','소녀시대','snsd',
  '세븐틴','seventeen','방탄','bts','스트레이키즈','straykids','엔믹스','nmixx',
  '르세라핌','lesserafim','카라','kara','원더걸스','missA','미사','sistar','씨스타',
  // 멤버 이름
  '태연','아이린','제니','지수','로제','리사','윈터','카리나','닝닝','지젤',
  '민지','해린','혜인','다니엘','하니','설윤','장원영','안유진','리즈','가을','레이',
  '김민주','혜원','이서','은채','가을','채원','조유리','최예나','권은비','강혜원',
  '사쿠라','히토미','나코','미유키','야부키','야마다','오다','혼다','김채원',
  '수지','아이유','설현','소진','나연','사나','모모','미나','쯔위','다현','지효',
  '솔라','문별','화사','휘인','선미','현아','효연','소녀','유아','미미','혜진','지호',
  // 연기자/배우
  '김고은','박소담','전여빈','강한나','신민아','한소희','박민영','김지원',
  '콘서트 메이크업','무대 메이크업','직캠 메이크업','무대룩',
  'concert makeup','stage makeup','idol makeup',
];

// 인플루언서/MUA 키워드
const INFLUENCER_KW = [
  '손민수','뷰티 크리에이터','뷰티크리에이터','메이크업 아티스트','메이크업아티스트',
  'mua','makeup artist','뷰티 유튜버','뷰티유튜버','뷰티 인플루언서',
  '메이크업 튜토리얼','메이크업튜토리얼','makeup tutorial','메이크업 정보','메이크업정보',
  '이 제품','이 립','이 파운데이션','이 쿠션','쓰는 제품','쓴 제품',
  '메이크업 공유','메이크업공유','makeup dupe','메이크업 추천','메이크업추천',
  '뷰티 정보','뷰티정보','제품 정보','제품정보',
];

// bullet 형식 감지: "블러셔:", "립:", "아이섀도우:" 등 제품 카테고리 뒤에 콜론
// → "제니 블러셔: 헤라 ..." 같은 게시물을 확실히 통과
const BULLET_PATTERN = /(?:블러셔|블러쉬|치크|립\s*:|틴트|파운데이션|쿠션|컨실러|섀도우|아이섀도|아이라이너|마스카라|하이라이터|베이스)\s*[:：]/i;

function hasBulletFormat(caption) {
  return BULLET_PATTERN.test(caption);
}

// 광고/협찬 제외 키워드
const AD_KW = [
  '#광고','#협찬','#유료광고','#ad ','#ad\n','#sponsored','#제품협찬',
  '#브랜드협찬','유료 광고','협찬을 받','원고료를 받','제품을 제공받',
];

// 미디어/매거진 계정 (기사 링크 유도 → 제외)
const MEDIA_ACCOUNTS = [
  'cosmokorea','cosmopolitan','allurekorea','voguekr','vogue','elle_korea','ellekorea',
  'marieclaire_kr','bazaarkorea','wkorea','glamour','instylekr','instyle',
  'hechokorea','dazedkorea','i_d_korea','nylon_korea','nylonkorea',
  'beautykorea','styler_kr','cosmetic_news','beautydiary','makeupnews',
];

// 외부 기사/뉴스 링크 도메인 (있으면 링크 유도 게시물로 판단)
const ARTICLE_DOMAINS = [
  'cosmopolitan.co.kr','allure.co.kr','vogue.co.kr','elle.co.kr',
  'marieclaire.co.kr','harpersbazaar.co.kr','instyle.co.kr',
  'naver.com/','naver.me/','me2.do/','bit.ly/','tinyurl.com/',
  'yna.co.kr','news.nate.com','daum.net/','huffingtonpost.kr',
  'beautydiary','styler.com','fashionseoul','fashionbiz',
];

// 구체적 제품명/브랜드 언급 여부 (필수 조건)
function hasBrand(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return BRAND_KW.some(k => lo.includes(k));
}
function hasSpecificProduct(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return PRODUCT_KW.some(k => lo.includes(k));
}
// 브랜드 OR 구체적 제품 타입이 반드시 있어야 함
function hasProductInfo(caption) {
  return hasBrand(caption) || hasSpecificProduct(caption);
}

function isIdolRelated(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return IDOL_KW.some(k => lo.includes(k));
}
function isInfluencerRelated(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return INFLUENCER_KW.some(k => lo.includes(k));
}
function isAdPost(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return AD_KW.some(k => lo.includes(k.toLowerCase()));
}

// 미디어/매거진 계정 여부
function isMediaAccount(username) {
  if (!username) return false;
  const lo = username.toLowerCase();
  return MEDIA_ACCOUNTS.some(m => lo.includes(m));
}

// 외부 기사 링크 유도 게시물 여부
function isArticleLinkPost(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  // URL 자체가 있고 그게 뉴스/기사 도메인이면 링크 유도로 판단
  const hasUrl = /https?:\/\//i.test(caption);
  if (!hasUrl) return false;
  return ARTICLE_DOMAINS.some(d => lo.includes(d));
}

// ── 최종 통과 조건 ────────────────────────────────────────────
// 반드시: 광고 아님 + 미디어 계정 아님 + 링크 유도 아님
//         + 본문에 구체적 제품 정보(브랜드명 또는 제품 종류) 있음
// 추가로: 아이돌/연예인 맥락 OR 인플루언서/MUA 맥락 OR bullet 제품 나열 형식
function shouldKeep(caption, sourceType, username, ownAccounts = []) {
  if (!caption || caption.length < 10) return false;
  if (isAdPost(caption)) return false;

  // 내 계정 게시물 제외 (자기 자신이 운영하는 계정)
  if (username && ownAccounts.some(a => a.toLowerCase() === username.toLowerCase())) {
    console.log(`  ⛔ 내 계정 제외 @${username}`);
    return false;
  }

  // 미디어/매거진 계정 제외
  if (isMediaAccount(username)) {
    console.log(`  ⛔ 미디어 계정 제외 @${username}`);
    return false;
  }

  // 외부 기사 링크 유도 게시물 제외
  if (isArticleLinkPost(caption)) {
    console.log(`  ⛔ 링크 유도 게시물 제외`);
    return false;
  }

  // 본문에 제품 정보 없으면 제외
  if (!hasProductInfo(caption)) return false;

  // 계정 팔로우 소스: 제품 정보만 있으면 통과
  if (sourceType === 'twitter-account') return true;

  // "블러셔: 헤라..." 같은 bullet 형식이면 맥락 체크 없이 통과
  if (hasBulletFormat(caption)) return true;

  // 해시태그/키워드 소스: 제품 정보 + (아이돌 OR 인플루언서 맥락) 필요
  return isIdolRelated(caption) || isInfluencerRelated(caption);
}

// 좋아요 수 파싱 (1.2K → 1200, 3.4M → 3400000)
function parseLikes(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  const m = t.match(/([\d.]+)\s*([km]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === 'k') return Math.round(n * 1000);
  if (m[2] === 'm') return Math.round(n * 1000000);
  return Math.round(n) || null;
}

// ── 타임라인 수집 ─────────────────────────────────────────────
async function collectFromSource(page, source, scrolls, ownAccounts = []) {
  console.log(`📥 수집: ${source.label} → ${source.url}`);
  try {
    await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    console.warn(`  ⚠️ 페이지 로드 실패: ${e.message}`);
    return [];
  }
  await page.waitForTimeout(4000);

  const found = new Map();
  let passCount = 0, skipCount = 0;

  for (let i = 0; i < scrolls; i++) {
    const tweets = await page.$$eval('article[data-testid="tweet"]', articles =>
      articles.map(a => {
        const statusLink = [...a.querySelectorAll('a[href*="/status/"]')]
          .find(el => /\/status\/\d+$/.test(el.pathname));
        if (!statusLink) return null;
        const tweetId  = statusLink.pathname.split('/status/')[1];
        const tweetUrl = `https://x.com${statusLink.pathname}`;

        const userHref = a.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href') || '';
        const username = userHref.replace(/^\//, '').split('/')[0] || '';

        const textEl  = a.querySelector('[data-testid="tweetText"]');
        const caption = textEl?.innerText?.trim() || '';

        const imgEl = a.querySelector('[data-testid="tweetPhoto"] img, [data-testid="videoComponent"] img');
        const image = imgEl?.src || '';

        const likeEl   = a.querySelector('[data-testid="like"] span[data-testid]') ||
                         a.querySelector('[data-testid="like"] span');
        const likeText = likeEl?.innerText?.trim() || '0';

        const timeEl   = a.querySelector('time[datetime]');
        const postedAt = timeEl?.getAttribute('datetime') || null;

        // 리트윗/인용 여부
        const socialCtx = a.querySelector('[data-testid="socialContext"]')?.innerText || '';
        const isRetweet = socialCtx.toLowerCase().includes('repost') || socialCtx.includes('리포스트');

        return { tweetId, tweetUrl, username, caption, image, likeText, postedAt, isRetweet };
      }).filter(Boolean)
    );

    for (const t of tweets) {
      if (t.isRetweet) continue;
      const id = `tw_${t.tweetId}`;
      if (found.has(id)) continue;

      // ── 필터 적용 ──
      if (!shouldKeep(t.caption, source.sourceType, t.username, ownAccounts)) {
        skipCount++;
        continue;
      }
      passCount++;
      found.set(id, t);
    }

    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(2000);
  }

  console.log(`  → 통과 ${passCount}개 / 필터 제외 ${skipCount}개`);

  return [...found.values()].map(t => ({
    id:          `tw_${t.tweetId}`,
    url:         t.tweetUrl,
    username:    t.username,
    caption:     t.caption,
    image:       t.image,
    likes:       parseLikes(t.likeText),
    postedAt:    t.postedAt,
    platform:    "twitter",
    sourceLabel: source.label,
    sourceUrl:   source.url,
    sourceType:  source.sourceType || "twitter-hashtag",
    collectedAt: nowIso(),
    enrichedAt:  nowIso(),
    status:      "enriched",   // 본문 있음 + 필터 통과 = enriched
  }));
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  const config = await readJson(configPath, null);
  if (!config) throw new Error(`설정 파일 없음: ${configPath}`);

  const hashtags    = config.twitterHashtags || [];
  const keywords    = config.twitterKeywords || [];
  const accounts    = config.twitterAccounts || [];
  const ownAccounts = config.ownTwitterAccounts || [];  // 내 계정 제외 목록

  if (!hashtags.length && !keywords.length && !accounts.length) {
    console.log('⚠️  twitter 설정이 없습니다. instagram_sources.json 에 twitterHashtags / twitterKeywords / twitterAccounts 를 추가해주세요.');
    return;
  }

  const SCROLLS    = Number(config.scrollsPerSource || 4);
  const profileDir = path.resolve(root, config.twitterProfileDir || ".twitter-profile");

  let pw;
  try { pw = await import("playwright"); }
  catch { throw new Error("Playwright 미설치. npm install 실행해주세요."); }

  const queue    = await readJson(queuePath, { generatedAt: null, items: [] });
  const existing = new Map((queue.items || []).map(item => [item.id || item.url, item]));

  const _launchOpts = {
    headless: Boolean(config.headless),
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--lang=ko-KR'],
    ignoreDefaultArgs: ['--enable-automation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ko-KR',
  };
  // 실제 Chrome 우선 사용 (X 봇 감지 우회)
  let context;
  try {
    context = await pw.chromium.launchPersistentContext(profileDir, { ..._launchOpts, channel: 'chrome' });
  } catch {
    context = await pw.chromium.launchPersistentContext(profileDir, _launchOpts);
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || await context.newPage();

  // 로그인 확인
  console.log('🐦 X(트위터) 로그인 상태 확인 중...');
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const isLoggedIn = await page.evaluate(() =>
    !location.href.includes('/login') &&
    !location.href.includes('/i/flow') &&
    !document.querySelector('input[autocomplete="username"]')
  );

  if (!isLoggedIn) {
    console.log('\n🔐 X(트위터) 로그인이 필요합니다! 브라우저에서 로그인해주세요. (최대 3분 대기)\n');
    try {
      await page.waitForFunction(
        () => location.href.includes('x.com') &&
              !location.href.includes('/login') &&
              !location.href.includes('/i/flow'),
        { timeout: 180000, polling: 2000 }
      );
      await page.waitForTimeout(2000);
      console.log('✅ 로그인 완료!\n');
    } catch {
      console.error('❌ 로그인 타임아웃. 다시 실행해주세요.');
      await context.close(); return;
    }
  } else {
    console.log('✅ 이미 로그인 상태입니다.\n');
  }

  // 중단 시 저장 보장
  let _shouldStop = false;
  const _onSig = () => {
    if (_shouldStop) process.exit(1);
    _shouldStop = true;
    console.log('\n⚠️  중단 — 수집된 데이터 저장 중...');
  };
  process.on('SIGINT', _onSig);
  process.on('SIGTERM', _onSig);

  let added = 0;
  try {
    // 해시태그 수집
    for (const tag of hashtags) {
      if (_shouldStop) break;
      const encoded = encodeURIComponent(`#${tag}`);
      const items = await collectFromSource(page, {
        label:      `#${tag}`,
        url:        `https://x.com/search?q=${encoded}&f=live`,
        sourceType: "twitter-hashtag",
      }, SCROLLS, ownAccounts);
      for (const item of items) {
        if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
      }
    }

    // 키워드 수집 (해시태그 없이 본문 검색 — "메이크업 정보", "아이돌 메이크업" 등)
    for (const kw of keywords) {
      if (_shouldStop) break;
      const encoded = encodeURIComponent(kw);
      const items = await collectFromSource(page, {
        label:      `🔍 ${kw}`,
        url:        `https://x.com/search?q=${encoded}&f=live`,
        sourceType: "twitter-keyword",
      }, SCROLLS, ownAccounts);
      for (const item of items) {
        if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
      }
    }

    // 계정 수집
    for (const account of accounts) {
      if (_shouldStop) break;
      const items = await collectFromSource(page, {
        label:      `@${account}`,
        url:        `https://x.com/${account}`,
        sourceType: "twitter-account",
      }, SCROLLS, ownAccounts);
      for (const item of items) {
        if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
      }
    }
  } catch (e) {
    console.error(`\n⚠️  오류 (데이터 저장): ${e.message}`);
    _shouldStop = true;
  } finally {
    process.off('SIGINT', _onSig);
    process.off('SIGTERM', _onSig);
    try { await context.close(); } catch {}
  }

  if (_shouldStop) console.log('💾 중단 지점까지 저장 중...');

  const items = [...existing.values()];
  const queueData = { generatedAt: nowIso(), items };
  await writeJson(queuePath, queueData);

  for (const extraDir of (config.additionalQueuePaths || [])) {
    const extraPath = path.resolve(root, extraDir, "instagram_queue.json");
    try { await writeJson(extraPath, queueData); console.log(`Synced → ${extraPath}`); }
    catch (e) { console.warn(`Sync 실패 (${extraPath}): ${e.message}`); }
  }

  const twCount = items.filter(i => i.platform === 'twitter').length;
  console.log(`✅ 완료. 새 트윗 ${added}개 추가. 트위터 전체: ${twCount}개 / 전체 큐: ${items.length}개`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
