// Gemini가 반환해야 할 결과를 직접 시뮬레이션
// (bm_jjin 캡션 수동 파싱 결과)

const CATEGORY_ORDER = ['아이섀도우', '블러셔', '하이라이터', '립'];

function buildInstaPost(products, authorId) {
  const header = (authorId && authorId !== '크리에이터' && authorId !== 'Instagram')
    ? `✺ @${authorId}님 메이크업 손민수`
    : '✺ Instagram 메이크업 손민수';

  const seen = new Set();
  const unique = products.filter(p => {
    const k = `${(p.brand||'').toLowerCase()}-${(p.name||'').toLowerCase()}-${(p.shade||'').toLowerCase()}`;
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

// ── 테스트 케이스 ──────────────────────────────────────────
const tests = [
  {
    label: '@bm_jjin 게시물 (핵심 예시 - @계정 다수)',
    authorId: 'bm_jjin',
    // Gemini가 반환해야 할 결과 (캡션: 섀도우@holika 시나몬롤 / 블러셔@입큰 뮤티드베이지 등)
    products: [
      { category: '아이섀도우', brand: '홀리카홀리카', name: '아이섀도우',  shade: '시나몬롤',   price: null, link: null },
      { category: '블러셔',    brand: '입큰',        name: '블러셔',      shade: '뮤티드 베이지', price: null, link: null },
      { category: '블러셔',    brand: '네이밍',      name: '블러셔',      shade: '피이그',      price: null, link: null },
      { category: '블러셔',    brand: '홀리카홀리카', name: '블러셔',      shade: '그릴드 피치', price: null, link: null },
      { category: '하이라이터', brand: '무드',        name: '하이라이터',  shade: '세레나데',    price: null, link: null },
      { category: '하이라이터', brand: '에이치아이',  name: '하이라이터',  shade: '하트베리',    price: null, link: null },
      { category: '립',        brand: '페리페라',    name: '틴트',        shade: '13 분위기 여신', price: null, link: null },
      { category: '립',        brand: '페리페라',    name: '틴트',        shade: '12 개강여신', price: null, link: null },
    ],
  },
  {
    label: '@bm_yyun 게시물 (@2an_official 원브랜드)',
    authorId: 'bm_yyun',
    products: [
      { category: '아이섀도우', brand: '투안', name: '섀도우',     shade: '22 로브포엠',  price: null, link: null },
      { category: '블러셔',    brand: '투안', name: '치크',       shade: '19 크리미로지', price: null, link: null },
      { category: '블러셔',    brand: '투안', name: '치크',       shade: '2 러브,로지',  price: null, link: null },
      { category: '하이라이터', brand: '투안', name: '하이라이터', shade: '러브빔',       price: null, link: null },
      { category: '립',        brand: '투안', name: '립',         shade: '01 누디 코코', price: null, link: null },
      { category: '립',        brand: '투안', name: '립',         shade: '09 러브 듀',  price: null, link: null },
    ],
  },
  {
    label: '가격/링크 입력 후 포맷 확인',
    authorId: 'bm_jjin',
    products: [
      { category: '아이섀도우', brand: '홀리카홀리카', name: '아이섀도우', shade: '시나몬롤',   price: '16,000원', link: 'https://example.com/1' },
      { category: '블러셔',    brand: '입큰',        name: '블러셔',    shade: '뮤티드 베이지', price: '18,000원', link: 'https://example.com/2' },
      { category: '립',        brand: '페리페라',    name: '틴트',      shade: '13 분위기 여신', price: '9,900원',  link: 'https://example.com/3' },
    ],
  },
];

for (const t of tests) {
  console.log('═'.repeat(60));
  console.log(`📋 ${t.label}`);
  console.log('─'.repeat(60));
  console.log(buildInstaPost(t.products, t.authorId));
  console.log();
}
