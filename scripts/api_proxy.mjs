/**
 * Gemini API 로컬 프록시 서버 + 큐 데이터 동기화
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
  // .env 파일 fallback
  try {
    const env = await fs.readFile(path.join(root, '.env'), 'utf8');
    const m   = env.match(/^GEMINI_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

const server = http.createServer(async (req, res) => {
  // CORS — GitHub Pages 도메인 + localhost 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
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

  // ── 큐 데이터 GET ────────────────────────────────────────────
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

  // ── 큐 데이터 POST (전체 저장) ──────────────────────────────
  if (req.method === 'POST' && req.url === '/api/queue-data') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        JSON.parse(body); // 유효성 검사
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

  // Gemini 프록시
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
  console.log(`\n🔑 Gemini 프록시 + 큐 동기화 서버 실행 중`);
  console.log(`   이 PC:      http://localhost:${PORT}`);
  console.log(`   다른 기기:  http://${localIp}:${PORT}  ← 같은 Wi-Fi에서 이 주소로 접속`);
  console.log(`   Gemini 키:  ${key ? '✅ 로드됨' : '❌ 없음 (instagram_sources.json에 geminiKey 추가 필요)'}`);
  console.log(`   종료: Ctrl+C\n`);
});
