/**
 * Gemini API 로컬 프록시 서버 + 큐 데이터 동기화 + 올리브영 가격 검색
 * 실행: npm run proxy
 * 포트: http://0.0.0.0:3001 (같은 Wi-Fi의 다른 기기에서도 접속 가능)
 */
import http         from 'node:http';
import https        from 'node:https';
import fs           from 'node:fs/promises';
import path         from 'node:path';
import os           from 'node:os';
import { spawn }    from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const PORT      = 3001;
const QUEUE_DATA_PATH    = path.join(root, 'queue_data.json');
const INSTAGRAM_QUEUE_PATH = path.join(root, 'instagram_queue.json');

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

async function getGeminiKey() {
  try {
    const config = JSON.parse(await fs.readFile(path.join(root, 'instagram_sources.json'), 'utf8'));
    if (config.geminiKey) return config.geminiKey;
  } catch {}
  try {
    const env = await fs.readFile(path.join(root, '.env'), 'utf8');
    const m   = env.match(/^GEMINI_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

// ── 크롤링 상태 ──────────────────────────────────────────────────
let _crawlRunning  = false;
let _crawlLogs     = [];
let _crawlDoneAt   = null;

function _crawlLog(line) {
  _crawlLogs.push(line);
  if (_crawlLogs.length > 200) _crawlLogs.shift();
}

function startCrawl(enrichOnly = false, platform = 'instagram') {
  if (_crawlRunning) return false;
  _crawlRunning = true;
  _crawlDoneAt  = null;

  let script, label;
  if (platform === 'twitter') {
    script = 'scripts/twitter_collect.mjs';
    label  = '🐦 X(트위터) 크롤링 시작...';
  } else if (enrichOnly) {
    script = 'scripts/instagram_collect.mjs';
    label  = '🔍 미분석 항목 일괄 분석 시작...';
  } else {
    script = 'scripts/instagram_collect.mjs';
    label  = '🕷 인스타그램 크롤링 시작...';
  }

  const args = ['node', script];
  if (enrichOnly && platform !== 'twitter') args.push('--enrich-only');
  _crawlLogs = [label];

  const proc = spawn(args[0], args.slice(1), {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', d =>
    d.toString().split('\n').filter(Boolean).forEach(l => { _crawlLog(l); console.log('[crawl]', l); })
  );
  proc.stderr.on('data', d =>
    d.toString().split('\n').filter(Boolean).forEach(l => { _crawlLog('⚠ ' + l); })
  );
  proc.on('close', code => {
    _crawlRunning = false;
    _crawlDoneAt  = new Date().toISOString();
    _crawlLog(code === 0 ? '✅ 크롤링 완료!' : `❌ 크롤링 종료 (exit ${code})`);
    console.log(`[crawl] 완료 exit=${code}`);
  });
  return true;
}

// ── 올리브영 Playwright 스크래퍼 ────────────────────────────────
let _browser    = null;   // 재사용 브라우저 인스턴스
let _oyBusy     = false;  // 동시 요청 직렬화 (올리브영 봇 감지 방지)
const _oyQueue  = [];     // 대기 중인 요청

async function _getOyBrowser() {
  if (_browser) return _browser;
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--lang=ko-KR',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  _browser.on('disconnected', () => { _browser = null; });
  console.log('🎭 Playwright 브라우저 시작됨');
  return _browser;
}

async function _runNextOy() {
  if (_oyBusy || _oyQueue.length === 0) return;
  _oyBusy = true;
  const { query, resolve, reject } = _oyQueue.shift();
  try {
    resolve(await _scrapeOliveYoung(query));
  } catch (e) {
    reject(e);
  } finally {
    _oyBusy = false;
    _runNextOy();   // 다음 대기 요청 처리
  }
}

function searchOliveYoung(query) {
  return new Promise((resolve, reject) => {
    _oyQueue.push({ query, resolve, reject });
    _runNextOy();
  });
}

// Cloudflare/봇 감지 우회용 스텔스 스크립트 (외부 패키지 불필요)
async function _applyStealthToPage(page) {
  await page.addInitScript(() => {
    // webdriver 플래그 제거
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Chrome 객체 모킹
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    // 플러그인 배열 모킹
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // 언어 설정
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ko-KR', 'ko', 'en-US', 'en'],
    });
    // permissions API 패치
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery.call(window.navigator.permissions, params);
    }
  });
}

async function _scrapeOliveYoung(query) {
  const browser = await _getOyBrowser();
  const page    = await browser.newPage();

  try {
    await _applyStealthToPage(page);   // Cloudflare 봇 감지 우회
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    await page.setViewportSize({ width: 1280, height: 800 });

    const searchUrl =
      `https://www.oliveyoung.co.kr/store/search/getSearchMain.do` +
      `?query=${encodeURIComponent(query)}&page=1&rowsPerPage=8`;

    await page.goto(searchUrl, { waitUntil: 'load', timeout: 25000 });
    console.log(`   📄 페이지 URL: ${page.url()}`);

    // JS 렌더링 대기 — li_good 또는 prd_li 계열 모두 시도
    const listSel = [
      '#prd-list .li_good', '.prd-list .li_good',
      '#prd-list li', '.prd_wrap .prd_li',
      '.search_result_wrap li', 'ul.list_prd li',
    ].join(', ');
    await page.waitForSelector(listSel, { timeout: 10000 }).catch(() => {});

    const result = await page.evaluate(() => {
      const item =
        document.querySelector('#prd-list .li_good') ||
        document.querySelector('.prd-list .li_good')  ||
        document.querySelector('.prd_wrap .prd_li')   ||
        document.querySelector('ul.list_prd li')       ||
        document.querySelector('#Contents .li_good')   ||
        document.querySelector('[class*="prd_li"]')    ||
        document.querySelector('[class*="li_good"]');

      if (!item) return null;

      // 제품명
      const nameEl =
        item.querySelector('.prd-name a') ||
        item.querySelector('.prd-name')   ||
        item.querySelector('.prod_name')  ||
        item.querySelector('.name')       ||
        item.querySelector('a[class*="name"]');

      // 현재가 추출 — tx-cur(할인가) 먼저, 없으면 단일가
      let priceDigits = null;

      // 1순위: .tx-cur 안의 숫자 (할인 적용된 현재가)
      const txCur = item.querySelector('.tx-cur');
      if (txCur) {
        const m = txCur.textContent.replace(/\s+/g, '').match(/[\d,]+/);
        if (m) priceDigits = m[0];
      }

      // 2순위: .price-cur, .sale-price 등 다른 현재가 패턴
      if (!priceDigits) {
        const altCur = item.querySelector('.price-cur') || item.querySelector('.sale-price') || item.querySelector('[class*="price-cur"]');
        if (altCur) {
          const m = altCur.textContent.replace(/\s+/g, '').match(/[\d,]+/);
          if (m) priceDigits = m[0];
        }
      }

      // 3순위: 단일가 상품 (할인 없음) — tx-org 는 제외하고 찾기
      if (!priceDigits) {
        const candidates = [
          '.tx-num', '.price strong', '.prd-price strong',
          '.prod_price strong', '[class*="price"] strong', '[class*="price"]',
        ];
        for (const sel of candidates) {
          const el = item.querySelector(sel);
          if (!el) continue;
          // tx-org(정가/취소선) 안에 있으면 건너뜀
          if (el.closest('.tx-org')) continue;
          const m = el.textContent.replace(/\s+/g, '').match(/[\d,]+/);
          if (m) { priceDigits = m[0]; break; }
        }
      }

      const linkEl = item.querySelector('a[href*="goodsNo"]') || item.querySelector('a');

      // 디버그: 가격 영역 HTML 반환 (Node에서 로깅)
      const _itemHtml = item.innerHTML.slice(0, 1000);

      if (!priceDigits) return { _debug: true, _itemHtml };

      return {
        productName : (nameEl?.textContent || '').trim(),
        price       : priceDigits + '원',
        url         : linkEl?.href || '',
        _itemHtml,
      };
    });

    // Node 콘솔에 아이템 HTML 출력
    if (result?._itemHtml) {
      console.log(`   [OY item HTML]\n${result._itemHtml}\n`);
    }

    if (!result) {
      // 페이지 소스 일부 로그 (셀렉터 디버깅용)
      const snippet = await page.evaluate(() =>
        document.body.innerHTML.slice(0, 800).replace(/\s+/g, ' ')
      );
      console.log(`   ⚠️ 결과 없음. 페이지 스니펫: ${snippet}`);
    }

    return result;

  } finally {
    await page.close();
  }
}

// ── 럭셔리 브랜드 공식 한국 사이트 매핑 ─────────────────────────
// 올리브영 미입점 시 이 URL을 프론트로 전달해 자동으로 탭을 열어줌
const LUXURY_BRAND_SEARCH = {
  '디올':       q => `https://www.dior.com/ko_kr/search#searchQuery=${encodeURIComponent(q)}&domain=beauty`,
  'dior':       q => `https://www.dior.com/ko_kr/search#searchQuery=${encodeURIComponent(q)}&domain=beauty`,
  '샤넬':       q => `https://www.chanel.com/ko_kr/fragrance-beauty/search/?q=${encodeURIComponent(q)}`,
  'chanel':     q => `https://www.chanel.com/ko_kr/fragrance-beauty/search/?q=${encodeURIComponent(q)}`,
  '이브생로랑': q => `https://www.yslbeauty.co.kr/search?q=${encodeURIComponent(q)}`,
  '입생로랑':   q => `https://www.yslbeauty.co.kr/search?q=${encodeURIComponent(q)}`,
  'ysl':        q => `https://www.yslbeauty.co.kr/search?q=${encodeURIComponent(q)}`,
  '나스':       q => `https://www.narscosmetics.co.kr/kr/search?q=${encodeURIComponent(q)}`,
  'nars':       q => `https://www.narscosmetics.co.kr/kr/search?q=${encodeURIComponent(q)}`,
  '맥':         q => `https://www.maccosmetics.co.kr/search?q=${encodeURIComponent(q.replace(/^맥\s*/,''))}&type=product`,
  'mac ':       q => `https://www.maccosmetics.co.kr/search?q=${encodeURIComponent(q.replace(/^mac\s*/i,''))}&type=product`,
  '랑콤':       q => `https://www.lancome.co.kr/search?q=${encodeURIComponent(q)}`,
  'lancome':    q => `https://www.lancome.co.kr/search?q=${encodeURIComponent(q)}`,
  '베네피트':   q => `https://www.benefitcosmetics.co.kr/search?q=${encodeURIComponent(q)}`,
  'benefit':    q => `https://www.benefitcosmetics.co.kr/search?q=${encodeURIComponent(q)}`,
  '클리니크':   q => `https://www.clinique.co.kr/search?q=${encodeURIComponent(q)}`,
  'clinique':   q => `https://www.clinique.co.kr/search?q=${encodeURIComponent(q)}`,
  '에스티로더': q => `https://www.esteelauder.co.kr/search?q=${encodeURIComponent(q)}`,
  '바비브라운':  q => `https://www.bobbibrown.co.kr/search?q=${encodeURIComponent(q)}`,
  'bobbi':      q => `https://www.bobbibrown.co.kr/search?q=${encodeURIComponent(q)}`,
  '샬롯틸버리':  q => `https://www.charlottetilbury.com/ko/search?q=${encodeURIComponent(q)}`,
  '아르마니':    q => `https://www.giorgioarmanibeauty.co.kr/search?q=${encodeURIComponent(q)}`,
  'armani':     q => `https://www.giorgioarmanibeauty.co.kr/search?q=${encodeURIComponent(q)}`,
  '지방시':     q => `https://www.givenchybeauty.co.kr/search?q=${encodeURIComponent(q)}`,
  '끌레드뽀':   q => `https://www.cledepeaubeaute.co.kr/search?q=${encodeURIComponent(q)}`,
  '톰포드':     q => `https://www.tomfordbeauty.com/ko/search/?q=${encodeURIComponent(q)}`,
  '로라메르시에': q => `https://www.lauramercier.co.kr/search?q=${encodeURIComponent(q)}`,
  '조르지오아르마니': q => `https://www.giorgioarmanibeauty.co.kr/search?q=${encodeURIComponent(q)}`,
};
const LUXURY_BRAND_LABELS = {
  '디올':'디올 뷰티 코리아', 'dior':'디올 뷰티 코리아',
  '샤넬':'샤넬 뷰티 코리아', 'chanel':'샤넬 뷰티 코리아',
  '이브생로랑':'YSL 뷰티', '입생로랑':'YSL 뷰티', 'ysl':'YSL 뷰티',
  '나스':'나스 코리아', 'nars':'나스 코리아',
  '맥':'맥 코스메틱스 코리아', 'mac ':'맥 코스메틱스 코리아',
  '랑콤':'랑콤 코리아', 'lancome':'랑콤 코리아',
  '베네피트':'베네피트 코리아', 'benefit':'베네피트 코리아',
  '클리니크':'클리니크 코리아', 'clinique':'클리니크 코리아',
  '에스티로더':'에스티로더 코리아', '바비브라운':'바비브라운 코리아', 'bobbi':'바비브라운 코리아',
  '샬롯틸버리':'샬롯틸버리', '아르마니':'아르마니 뷰티', 'armani':'아르마니 뷰티',
  '지방시':'지방시 뷰티', '끌레드뽀':'끌레드뽀보떼', '톰포드':'톰포드 뷰티',
  '로라메르시에':'로라메르시에 코리아', '조르지오아르마니':'아르마니 뷰티',
};

function detectLuxuryBrand(query) {
  const lo = query.toLowerCase();
  for (const key of Object.keys(LUXURY_BRAND_SEARCH)) {
    if (lo.includes(key.toLowerCase())) {
      return {
        name:      LUXURY_BRAND_LABELS[key] || key,
        searchUrl: LUXURY_BRAND_SEARCH[key](query),
      };
    }
  }
  return null;
}

// ── HTTP 서버 ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 헬스체크
  if (req.url === '/health') {
    const key = await getGeminiKey();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, keyLoaded: Boolean(key) }));
    return;
  }

  // ── 크롤링 시작 POST ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/crawl') {
    const started = startCrawl(false);
    res.writeHead(started ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(started
      ? { ok: true,  message: '크롤링 시작됨' }
      : { ok: false, message: '이미 크롤링 중입니다' }
    ));
    return;
  }

  // ── 미분석 항목 일괄 분석 POST ────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/enrich') {
    const started = startCrawl(true, 'instagram');
    res.writeHead(started ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(started
      ? { ok: true,  message: '일괄 분석 시작됨' }
      : { ok: false, message: '이미 실행 중입니다' }
    ));
    return;
  }

  // ── 트위터 크롤링 POST ────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/crawl/twitter') {
    const started = startCrawl(false, 'twitter');
    res.writeHead(started ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(started
      ? { ok: true,  message: 'X(트위터) 크롤링 시작됨' }
      : { ok: false, message: '이미 실행 중입니다' }
    ));
    return;
  }

  // ── 크롤링 상태 GET ───────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/crawl/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running : _crawlRunning,
      doneAt  : _crawlDoneAt,
      logs    : _crawlLogs.slice(-50),
    }));
    return;
  }

  // ── 인스타그램 큐 GET (로컬 instagram_queue.json 서빙) ────────
  if (req.method === 'GET' && req.url === '/api/instagram-queue') {
    try {
      const raw = await fs.readFile(INSTAGRAM_QUEUE_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"items":[]}');
    }
    return;
  }

  // ── 큐 데이터 GET ─────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/queue-data') {
    try {
      const raw = await fs.readFile(QUEUE_DATA_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
    return;
  }

  // ── 큐 데이터 POST ────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/queue-data') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        JSON.parse(body);
        await fs.writeFile(QUEUE_DATA_PATH, body, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 올리브영 가격 검색 POST ───────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/oliveyoung') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { query } = JSON.parse(body);
        if (!query?.trim()) throw new Error('query 필드가 비어있습니다');

        console.log(`🛒 올리브영 검색: "${query}"`);
        const result = await searchOliveYoung(query.trim());

        if (result) {
          console.log(`   → ${result.price}  (${result.productName})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...result, source: 'oliveyoung' }));
        } else {
          // 올리브영 미입점 → 럭셔리 브랜드 공식사이트 안내
          const lux = detectLuxuryBrand(query.trim());
          if (lux) {
            console.log(`   → 올리브영 없음 — 럭셔리 브랜드 감지 (${lux.name})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ price: null, source: 'luxury', brandName: lux.name, brandSearchUrl: lux.searchUrl }));
          } else {
            console.log(`   → 결과 없음`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ price: null, source: 'not_found' }));
          }
        }
      } catch (e) {
        console.error(`   ❌ 올리브영 검색 오류:`, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Gemini 프록시 ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/gemini') {
    const key = await getGeminiKey();
    if (!key) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Gemini API 키 없음. instagram_sources.json에 "geminiKey" 추가 또는 .env에 GEMINI_KEY=... 입력'
      }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path:     `/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        proxyRes.pipe(res);
      });

      proxyReq.on('error', e => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });

      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', async () => {
  const key     = await getGeminiKey();
  const localIp = getLocalIp();
  console.log(`\n🔑 Gemini 프록시 + 큐 동기화 + 올리브영 검색 서버 실행 중`);
  console.log(`   이 PC:      http://localhost:${PORT}`);
  console.log(`   다른 기기:  http://${localIp}:${PORT}  ← 같은 Wi-Fi에서 이 주소로 접속`);
  console.log(`   Gemini 키:  ${key ? '✅ 로드됨' : '❌ 없음 (instagram_sources.json에 geminiKey 추가 필요)'}`);
  console.log(`   올리브영:   🛒 Playwright 스크래퍼 준비 (첫 검색 시 브라우저 자동 실행)`);
  console.log(`   종료: Ctrl+C\n`);
});
