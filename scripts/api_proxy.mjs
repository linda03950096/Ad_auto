/**
 * Gemini API 로컬 프록시 서버
 * API 키를 브라우저에 노출하지 않고 서버 측에서 안전하게 보관합니다.
 *
 * 실행: npm run proxy
 * 포트: http://localhost:3001
 */
import http  from 'node:http';
import https from 'node:https';
import fs    from 'node:fs/promises';
import path  from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const PORT      = 3001;

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

server.listen(PORT, '127.0.0.1', async () => {
  const key = await getGeminiKey();
  console.log(`\n🔑 Gemini 프록시 서버 실행 중`);
  console.log(`   주소: http://localhost:${PORT}`);
  console.log(`   키:   ${key ? '✅ 로드됨' : '❌ 없음 (instagram_sources.json에 geminiKey 추가 필요)'}`);
  console.log(`   종료: Ctrl+C\n`);
});
