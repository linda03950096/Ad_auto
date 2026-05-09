// 포맷 시뮬레이션 - index.html 로직을 Node에서 재현
import fs from 'node:fs/promises';

const queue = JSON.parse(await fs.readFile('./instagram_queue.json', 'utf8'));

// ── 브랜드 DB ─────────────────────────────────────────────
const BRANDS = [
  '롬앤','rom&nd','3CE','쓰리컨셉아이즈',
  '클리오','clio','에뛰드','etude','이니스프리','innisfree','라네즈','laneige',
  '헤라','hera','설화수','숨37','아모레퍼시픽','미샤','missha',
  '토니모리','tonymoly','홀리카홀리카','holika','페리페라','peripera',
  '조선미녀','토리든','닥터지','달바','아누아','코스알엑스','cosrx',
  '더페이스샵','네이처리퍼블릭','스킨푸드','바닐라코','어퓨',
  '에스쁘아','espoir','투쿨포스쿨','웨이크메이크','wakemake',
  '데이지크','dasique','아임미미','가히','kahi',
  '메디힐','닥터자르트','마녀공장','라운드랩','파파레서피',
  '비디비치','vdl','오페라','opera','글린트','필리밀리',
  '정샘물','아이소이','isoi','메디큐브','medicube','스킨1004','skin1004','구달','goodal',
  '오휘','ohui','후','숨','맥','mac','샤넬','chanel','디올','dior','나스','nars',
  '랑콤','lancome','이브생로랑','ysl','조르지오아르마니','armani','샬롯틸버리','charlotte tilbury',
  '메이크업포에버','mufe','베네피트','benefit','어반디케이','urban decay','타르트','tarte',
  '모르피','morphe','nyx','닉스','메이블린','maybelline','로레알','loreal',
  '케이트','kate','캔메이크','canmake','세자느','cezanne','바비브라운','bobbi brown',
  '로라메르시에','laura mercier','레브론','revlon','밀라니','milani',
  // INSTA_ACCOUNT_BRANDS 값들 (치환 후 감지 가능하도록)
  '무드','입큰','네이밍','에이치아이','모우모우',
];

const INSTA_ACCOUNT_BRANDS = {
  'mude_official': '무드',
  'holikaholika_official': '홀리카홀리카',
  'ipknofficial': '입큰',
  'naming.cosmetic': '네이밍',
  'peripera_official': '페리페라',
  'a.chicosmetics': '에이치아이',
  'romand_official': '롬앤',
  'clio_cosmetics': '클리오',
  'etudehouse': '에뛰드',
  'innisfree_official': '이니스프리',
  'laneige_official': '라네즈',
  'moumou_official_': '모우모우',
  '2an_official': '투안',
};

const CATEGORY_KW = {
  '파운데이션':'파운데이션','foundation':'파운데이션','쿠션':'쿠션','cushion':'쿠션',
  '컨실러':'컨실러','concealer':'컨실러','프라이머':'베이스/프라이머','primer':'베이스/프라이머',
  '베이스':'베이스/프라이머','세팅파우더':'세팅파우더/픽서','파우더':'세팅파우더/픽서',
  '블러셔':'블러셔','블러쉬':'블러셔','치크':'블러셔','blush':'블러셔','blusher':'블러셔',
  '하이라이터':'하이라이터','highlighter':'하이라이터','highlight':'하이라이터',
  '컨투어':'컨투어/쉐딩','쉐딩':'컨투어/쉐딩','쉐이딩':'컨투어/쉐딩',
  '아이브로우':'아이브로우','브로우':'아이브로우','눈썹':'아이브로우','brow':'아이브로우',
  '아이섀도우':'아이섀도우','섀도우':'아이섀도우','팔레트':'아이섀도우','shadow':'아이섀도우','eyeshadow':'아이섀도우',
  '아이라이너':'아이라이너','라이너':'아이라이너','liner':'아이라이너',
  '마스카라':'마스카라','mascara':'마스카라',
  '틴트':'립','립틴트':'립','립스틱':'립','립글로스':'립','립밤':'립','립':'립',
  'tint':'립','lipstick':'립','lip':'립','gloss':'립',
};

const CATEGORY_ORDER = ['아이섀도우','블러셔','하이라이터','립'];

const AD_KEYWORDS = [
  '#광고','#협찬','#유료광고','#광고포함','#ad ','#ad\n','#sponsored','#제품협찬',
  '#브랜드협찬','#ppaid','#paidpartnership','유료 광고','이 포스팅은 광고',
  '브랜드로부터 제품을 제공','제품을 제공받아','원고료를 받','협찬을 받',
];

function preprocessInstagramCaption(text) {
  return text.replace(/@([\w.]+)/g, (match, handle) => {
    const brand = INSTA_ACCOUNT_BRANDS[handle.toLowerCase()];
    return brand ? brand : match;
  });
}

// 캡션 메타 앞부분("652 likes, 21 comments - bm_jjin - April...") 에서 유저명 추출
function extractUsernameFromCaption(caption) {
  const m = caption.match(/^\d[\d,]* likes.*?-\s*([\w.]+)\s*-/);
  return m ? m[1] : null;
}

function isAdPost(caption) {
  if (!caption) return false;
  const lo = caption.toLowerCase();
  return AD_KEYWORDS.some(kw => lo.includes(kw.toLowerCase()));
}

function detectBrand(text) {
  const lo = text.toLowerCase();
  return BRANDS.slice().sort((a,b) => b.length - a.length)
    .find(b => lo.includes(b.toLowerCase())) || null;
}

function detectCategory(text) {
  const lo = text.toLowerCase();
  for (const [kw, cat] of Object.entries(CATEGORY_KW)) {
    if (lo.includes(kw)) return cat;
  }
  return '기타';
}

function detectShade(text) {
  const patterns = [
    /\b[Nn]\s*\d{1,2}[A-Za-z]?\b/, /\bW\d{2}\b/, /\bC\d{2}\b/,
    /#\s*\d{1,3}\b/, /\b\d{1,2}\s*호\b/, /\b\d{1,2}\s*번\b/,
    /\b[A-Z]{1,3}\d{2,3}\b/, /\b\d{2,3}[A-Z]\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

function detectPrice(text) {
  const m = text.match(/[\d,]+\s*원/);
  return m ? m[0].trim() : null;
}

function cleanProductName(candidate, brand, shade, price) {
  let name = candidate;
  try { name = name.replace(new RegExp(brand, 'gi'), ''); } catch {}
  if (shade) name = name.replace(shade, '');
  if (price) name = name.replace(price, '');
  return name.replace(/\d{1,2}(호|번)/, '').replace(/#\d+/, '')
    .replace(/[|/\\,_.]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractProducts(caption) {
  const processed = preprocessInstagramCaption(caption);
  const lines = processed.split(/[\n。]+/)
    .map(l => l.replace(/[✔✅☑◆▶•·\-*①②③④⑤⑥⑦⑧⑨⑩✨🍑🫧🤍👍🏻]/g,'').trim())
    .filter(Boolean);

  const results = [];
  const seen = new Set();

  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    candidates.push(lines[i]);
    if (i+1 < lines.length) candidates.push(lines[i] + ' ' + lines[i+1]);
  }

  for (const line of candidates) {
    if (line.length < 4 || line.length > 200) continue;
    const rawBrand = detectBrand(line);
    if (!rawBrand) continue;

    const category = detectCategory(line);
    const shade    = detectShade(line);
    const price    = detectPrice(line);
    const name     = cleanProductName(line, rawBrand, shade, price);
    if (!name || name.length < 2) continue;
    if (name.toLowerCase() === rawBrand.toLowerCase()) continue;

    const key = `${rawBrand.toLowerCase()}-${name.slice(0,20)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ category, brand: rawBrand, name, shade: shade||null, price: price||null });
  }
  return results;
}

function buildInstaPost(products, authorId) {
  const header = (authorId && authorId !== '크리에이터' && authorId !== 'Instagram')
    ? `✺ @${authorId}님 메이크업 손민수`
    : '✺ Instagram 메이크업 손민수';

  const seen = new Set();
  const unique = products.filter(p => {
    const k = `${(p.brand||'').toLowerCase()}-${(p.name||'').toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const byCategory = {};
  for (const p of unique) {
    (byCategory[p.category] = byCategory[p.category] || []).push(p);
  }

  const orderedCats = [
    ...CATEGORY_ORDER.filter(c => byCategory[c]),
    ...Object.keys(byCategory).filter(c => !CATEGORY_ORDER.includes(c)),
  ];

  let out = `링크를 통해 구매 시 일정 수수료를 지급 받을 수 있습니다.\n${header}\n`;
  for (const cat of orderedCats) {
    out += `\n♡ ${cat}\n`;
    for (const p of byCategory[cat]) {
      const name  = [p.brand, p.name].filter(Boolean).join(' ');
      const shade = p.shade ? ` #${p.shade.replace(/^#/, '')}` : '';
      const price = p.price ? `/ ${p.price}` : '/ 원';
      out += `${name}${shade} ${price}\n🔗\n\n`;
    }
  }
  return out.trimEnd();
}

// ── 실행 ────────────────────────────────────────────────────
for (const item of queue.items) {
  const caption = item.caption || '';
  const isAd = isAdPost(caption);
  const authorId = extractUsernameFromCaption(caption) || item.username || '크리에이터';
  const products = extractProducts(caption);

  console.log('═'.repeat(60));
  console.log(`📸 ${item.url}`);
  console.log(`👤 username 필드: "${item.username}" | 캡션 추출: "${extractUsernameFromCaption(caption) || '없음'}"`);
  if (isAd) { console.log('❌ 광고 게시물 → 스킵\n'); continue; }
  console.log(`🛍 제품 추출 (${products.length}개):`, JSON.stringify(products, null, 2));
  console.log('\n📋 최종 포맷:');
  console.log(buildInstaPost(products, authorId));
  console.log();
}
