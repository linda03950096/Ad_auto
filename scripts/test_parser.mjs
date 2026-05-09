import fs from 'node:fs/promises';

const queue = JSON.parse(await fs.readFile('./instagram_queue.json', 'utf8'));

const INSTA_ACCOUNT_BRANDS = {
  // 국내 브랜드
  'banilaco_official': '바닐라코',
  'clio_official': '클리오', 'clio_cosmetics': '클리오',
  'peripera_official': '페리페라',
  'etudeofficial': '에뛰드', 'etudehouse': '에뛰드',
  'romandyou': '롬앤', 'romand_official': '롬앤',
  'herabeauty_official': '헤라',
  'laneige_kr': '라네즈', 'laneige_official': '라네즈',
  'innisfreeofficial': '이니스프리', 'innisfree_official': '이니스프리',
  'espiox_official': '에스쁘아',
  'holikaholika_official': '홀리카홀리카',
  'vdl_cosmetics': 'VDL',
  'luna_makeup_official': '루나',
  'naming.cosmetic': '네이밍',
  'hince_official': '힌스',
  'mude_official': '무드',
  'fwee_makeup': '퓌',
  'aoucosmetics': '에이오유',
  'dasique_official': '데이지크',
  'wakemake_official': '웨이크메이크',
  '3ce_official': '3CE', 'threeconcepteyes': '3CE',
  'missha.official': '미샤',
  'apieu_official': '어퓨',
  'too_cool_for_school_official': '투쿨포스쿨',
  'thesaem.official': '더샘',
  'muzigae_mansion': '무지개맨션',
  'glint__official': '글린트',
  'heartpercent': '하트퍼센트',
  'colorgram.official': '컬러그램',
  'alternativestereo': '얼터너티브스테레오',
  'a.chicosmetics': '에이치아이',
  'lummir_makeup': '루미르',
  'riskybeauty_official': '리스키',
  'tooc_official': '투크',
  'be_of_official': '비오브',
  'iam_amuse': '어뮤즈',
  // 해외 브랜드
  'yslbeauty': '입생로랑',
  'diormakeup': '디올', 'diorbeauty': '디올',
  'chanel.beauty': '샤넬',
  'narsissist': '나스', 'nars_cosmetics': '나스',
  'maccosmeticskorea': '맥', 'maccosmetics': '맥',
  'giorgioarmani_beauty': '아르마니', 'armanibeauty': '아르마니',
  'bobbibrownkorea': '바비브라운',
  'charlottetilbury': '샬롯 틸버리',
  'lauramercier': '로라 메르시에',
  'makeupforever': '메이크업포에버',
  'shiseido': '시세이도',
  'tomfordbeauty': '톰포드',
  'givenchybeauty': '지방시',
  'valentino.beauty': '발렌티노',
  'hourglasscosmetics': '아워글래스',
};

const INSTA_CAT_KW = {
  '아이섀도우':'아이섀도우','섀도우':'아이섀도우','쉐도우':'아이섀도우','팔레트':'아이섀도우',
  '블러셔':'블러셔','블러쉬':'블러셔','치크':'블러셔','볼터치':'블러셔','볼블러셔':'블러셔',
  '하이라이터':'하이라이터',
  '립스틱':'립','립틴트':'립','립글로스':'립','립밤':'립','립':'립','틴트':'립',
  '아이라이너':'아이라이너','라이너':'아이라이너',
  '마스카라':'마스카라',
  '아이브로우':'아이브로우','브로우':'아이브로우','눈썹':'아이브로우',
  '파운데이션':'파운데이션','쿠션':'쿠션','컨실러':'컨실러',
  '세팅파우더':'세팅파우더/픽서','파우더':'세팅파우더/픽서','픽서':'세팅파우더/픽서',
  '컨투어':'컨투어/쉐딩','쉐딩':'컨투어/쉐딩','쉐이딩':'컨투어/쉐딩',
  '노즈':'기타','애교살':'기타','프라이머':'베이스/프라이머',
};

const INSTA_CAT_NAME = {
  '아이섀도우':'아이섀도우','블러셔':'블러셔','하이라이터':'하이라이터',
  '립':'틴트','아이라이너':'아이라이너','마스카라':'마스카라',
  '아이브로우':'아이브로우','파운데이션':'파운데이션','쿠션':'쿠션',
  '컨실러':'컨실러','세팅파우더/픽서':'세팅파우더','컨투어/쉐딩':'쉐딩',
  '기타':'기타','베이스/프라이머':'프라이머',
};

const CATEGORY_ORDER = ['아이섀도우', '블러셔', '하이라이터', '립'];
const AD_KEYWORDS = ['#광고','#협찬','#유료광고','유료 광고','원고료를 받','협찬을 받','제품을 제공받아'];

function stripEmoji(str) {
  return str.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}✨✅🤍🍑👍💄💗🌸🌼🎉⭐🫧]/gu, '').trim();
}

function cleanInstagramCaption(caption) {
  return caption
    .replace(/^\d[\d,]*\s*likes?[^"]*?"/, '')
    .replace(/"\.?\s*$/, '')
    .trim();
}

function extractUsernameFromCaption(caption) {
  const m = caption.match(/^\d[\d,]*\s*likes?[^-]*-\s*([\w.]+)\s*-/);
  return m ? m[1] : null;
}

function isAdPost(caption) {
  const lo = caption.toLowerCase();
  return AD_KEYWORDS.some(kw => lo.includes(kw.toLowerCase()));
}

function parseInstagramCaption(rawCaption) {
  const caption = cleanInstagramCaption(rawCaption);
  const lines   = caption.split(/\n/).map(l => stripEmoji(l)).filter(Boolean);
  const results = [];
  let contextBrand = null;
  const catKws = Object.keys(INSTA_CAT_KW).sort((a, b) => b.length - a.length);

  for (const line of lines) {
    if (/^@[\w.]+/.test(line)) {
      const m = line.match(/^@([\w.]+)/);
      const b = m && INSTA_ACCOUNT_BRANDS[m[1].toLowerCase()];
      if (b) contextBrand = b;
      continue;
    }

    let category = null, rest = line;
    for (const kw of catKws) {
      if (line.toLowerCase().startsWith(kw)) {
        category = INSTA_CAT_KW[kw];
        rest     = line.slice(kw.length).trim();
        break;
      }
    }
    if (!category || !rest) continue;

    const productName = INSTA_CAT_NAME[category] || category;

    if (/@[\w.]+/.test(rest)) {
      const parts = rest.split(/@([\w.]+)/);
      for (let i = 1; i < parts.length; i += 2) {
        const handle    = parts[i];
        const colorText = (parts[i + 1] || '').replace(/[".]/g, '').trim();
        const brand     = INSTA_ACCOUNT_BRANDS[handle.toLowerCase()] || handle;
        if (!colorText) continue;

        const shades = colorText.includes('+')
          ? colorText.split(/\s*\+\s*/)
          : colorText.split(/\s+(?=\d+[\s가-힣])/);

        for (const shade of shades) {
          const s = shade.trim();
          if (s && s.length < 30)
            results.push({ category, brand, name: productName, shade: s, price: null, link: null });
        }
      }
    } else {
      if (!contextBrand) continue;
      const shades = rest.split(/\s*\+\s*/).map(s => s.replace(/[".]/g, '').trim()).filter(s => s && s.length < 30);
      for (const shade of shades)
        results.push({ category, brand: contextBrand, name: productName, shade: shade || null, price: null, link: null });
    }
  }

  const seen = new Set();
  return results.filter(p => {
    const k = `${p.brand}-${p.shade}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildInstaPost(products, authorId) {
  const header = (authorId && authorId !== '크리에이터' && authorId !== 'Instagram')
    ? `✺ @${authorId}님 메이크업 손민수`
    : '✺ Instagram 메이크업 손민수';

  const seen = new Set();
  const unique = products.filter(p => {
    const k = `${(p.brand||'').toLowerCase()}-${(p.shade||'').toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const byCategory = {};
  for (const p of unique) (byCategory[p.category] = byCategory[p.category] || []).push(p);

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
      const link  = p.link  ? `🔗 ${p.link}` : '🔗';
      out += `${name}${shade} ${price}\n${link}\n\n`;
    }
  }
  return out.trimEnd();
}

for (const item of queue.items) {
  const caption  = item.caption || '';
  const authorId = extractUsernameFromCaption(caption) || item.username || '크리에이터';

  console.log('═'.repeat(60));
  console.log(`📸 @${authorId}  ${item.url}`);

  if (isAdPost(caption)) { console.log('❌ 광고 → 스킵\n'); continue; }

  const products = parseInstagramCaption(caption);

  if (!products.length) { console.log('⚠️  제품 없음\n'); continue; }

  console.log(buildInstaPost(products, authorId));
  console.log();
}
