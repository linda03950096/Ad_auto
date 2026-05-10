/**
 * Gemini API 로컬 프록시 서버 + 큐 데이터 동기화 + 올리브영 가격 검색
 * 실행: npm run proxy
 * 포트: http://0.0.0.0:3001 (같은 Wi-Fi의 다른 기기에서도 접속 가능)
 */
import http  from 'node:http';
import https from 'node:https';
import fs    from 'node:fs/promises';
import path  from 'node:path';
import os    from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const PORT      = 3001;
const QUEUE_DATA_PATH = path.join(root, 'queue_data.json');

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
      // 실제 렌더된 HTML 구조 디버깅
      const body = document.body.innerHTML;
      const hasPrdList = body.includes('li_good') || body.includes('prd_li') || body.includes('list_prd');
      console.log('[OY debug] li_good/prd_li 존재:', hasPrdList);

      // 셀렉터 후보 (여러 패턴 시도)
      const item =
        document.querySelector('#prd-list .li_good') ||
        document.querySelector('.prd-list .li_good')  ||
        document.querySelector('.prd_wrap .prd_li')   ||
        document.querySelector('ul.list_prd li')       ||
        document.querySelector('#Contents .li_good')   ||
        document.querySelector('[class*="prd_li"]')    ||
        document.querySelector('[class*="li_good"]');

      if (!item) {
        // 못 찾았을 때 — 어떤 li 가 있는지 힌트 출력
        const lis = [...document.querySelectorAll('li')].slice(0, 5);
        console.log('[OY debug] li 없음, 샘플 li:', lis.map(l => l.className).join(' | '));
        return null;
      }
      console.log('[OY debug] item.className:', item.className);

      // 제품명
      const nameEl =
        item.querySelector('.prd-name a') ||
        item.querySelector('.prd-name')   ||
        item.querySelector('.prod_name')  ||
        item.querySelector('.name')       ||
        item.querySelector('a[class*="name"]');

      // 가격 — 여러 패턴 시도
      const priceEl =
        item.querySelector('.prd-price .price strong') ||
        item.querySelector('.prd-price strong')        ||
        item.querySelector('.price strong')            ||
        item.querySelector('.prod_price strong')       ||
        item.querySelector('.tx-num')                  ||
        item.querySelector('[class*="price"] strong')  ||
        item.querySelector('[class*="price"]');

      if (!priceEl) {
        console.log('[OY debug] priceEl 없음, item HTML:', item.outerHTML.slice(0, 300));
        return null;
      }

      const raw    = priceEl.textContent.replace(/\s+/g, '');
      const digits = raw.match(/[\d,]+/)?.[0];
      if (!digits) return null;

      const linkEl = item.querySelector('a[href*="goodsNo"]') || item.querySelector('a');

      return {
        productName : (nameEl?.textContent || '').trim(),
        price       : digits + '원',
        url         : linkEl?.href || '',
      };
    });

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
        } else {
          console.log(`   → 결과 없음`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result ?? { price: null }));
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
