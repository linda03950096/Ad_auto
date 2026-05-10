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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=ko-KR'],
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

async function _scrapeOliveYoung(query) {
  const browser = await _getOyBrowser();
  const page    = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });
    await page.setViewportSize({ width: 1280, height: 800 });

    const searchUrl =
      `https://www.oliveyoung.co.kr/store/search/getSearchMain.do` +
      `?query=${encodeURIComponent(query)}&page=1&rowsPerPage=8`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // 제품 목록이 뜰 때까지 최대 8초 대기
    const listSel = '#prd-list .li_good, .prd-list .li_good';
    await page.waitForSelector(listSel, { timeout: 8000 }).catch(() => {});

    const result = await page.evaluate(() => {
      // 선택자 우선순위: id → class
      const item =
        document.querySelector('#prd-list .li_good') ||
        document.querySelector('.prd-list .li_good');
      if (!item) return null;

      // 제품명
      const nameEl =
        item.querySelector('.prd-name a') ||
        item.querySelector('.prd-name')   ||
        item.querySelector('a[class*="name"]');

      // 가격 — 여러 패턴 시도
      const priceEl =
        item.querySelector('.prd-price .price strong') ||
        item.querySelector('.prd-price strong')        ||
        item.querySelector('.price strong')            ||
        item.querySelector('.tx-num')                  ||
        item.querySelector('.prd-price');

      if (!priceEl) return null;

      // "12,000" 형태에서 숫자+쉼표만 추출 후 "원" 붙이기
      const raw    = priceEl.textContent.replace(/\s+/g, '');
      const digits = raw.match(/[\d,]+/)?.[0];
      if (!digits) return null;

      // 상품 링크
      const linkEl = item.querySelector('a[href*="goodsNo"]') || item.querySelector('a');

      return {
        productName : (nameEl?.textContent || '').trim(),
        price       : digits + '원',
        url         : linkEl?.href || '',
      };
    });

    return result;   // null 이면 "결과 없음"

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
