import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "instagram_sources.json");
const queuePath  = path.join(root, "instagram_queue.json");
const shouldPublish = process.argv.includes("--publish");

const nowIso = () => new Date().toISOString();

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

// ── 포스트 상세 스크랩 (캡션 + 이미지) ─────────────────────
async function enrichPost(page, item) {
  try {
    console.log(`  Enriching: ${item.url}`);
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(3000);

    const details = await page.evaluate(() => {
      const meta = (prop) =>
        document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute("content") || "";

      // 캡션: h1 → article span → og:description 순으로 시도
      let caption = "";
      const selectors = ["h1", "article div > span > span", "article span"];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim().length > 15) { caption = el.textContent.trim(); break; }
      }
      if (!caption) caption = meta("og:description");

      // @username 추출
      const titleMeta = meta("og:title");
      const username  = titleMeta.match(/@?([\w.]+)/)?.[1] || "";

      return {
        caption:   caption.slice(0, 4000),
        image:     meta("og:image"),
        username,
      };
    });

    return { ...item, ...details, status: "enriched", enrichedAt: nowIso() };
  } catch (e) {
    console.error(`  Enrich failed (${item.url}): ${e.message}`);
    return { ...item, status: "enrich-failed" };
  }
}

// ── 피드 수집 (URL만) ──────────────────────────────────────
async function collectFromSource(page, source, scrolls) {
  console.log(`Collecting: ${source.label} → ${source.url}`);
  await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

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
    ...item, sourceLabel: source.label, sourceUrl: source.url,
    collectedAt: nowIso(), status: "new", caption: "", image: "", username: "", note: "",
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

  let pw;
  try { pw = await import("playwright"); }
  catch { throw new Error("Playwright not installed. Run: npm install"); }

  const queue    = await readJson(queuePath, { generatedAt: null, items: [] });
  const existing = new Map((queue.items || []).map(item => [item.id || item.url, item]));
  const profileDir = path.resolve(root, config.chromeProfileDir || ".instagram-profile");

  const context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: Boolean(config.headless),
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();

  let added = 0;
  try {
    // 1단계: 피드에서 새 URL 수집
    for (const source of config.sources) {
      const items = await collectFromSource(page, source, Number(config.scrollsPerSource || 6));
      for (const item of items) {
        if (!existing.has(item.id)) { existing.set(item.id, item); added++; }
      }
    }
    console.log(`\nFound ${added} new post(s). Enriching with captions...`);

    // 2단계: 새 포스트만 상세 스크랩 (캡션 + 이미지)
    for (const [key, item] of existing) {
      if (item.status === "new") {
        const enriched = await enrichPost(page, item);
        existing.set(key, enriched);
        await new Promise(r => setTimeout(r, 1500)); // 속도 제한
      }
    }
  } finally {
    await context.close();
  }

  const items = [...existing.values()]
    .sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || "")));
  await writeJson(queuePath, { generatedAt: nowIso(), items });
  console.log(`Done. Queue size: ${items.length}`);

  if (shouldPublish || config.publishToGit) {
    const s = publishQueue();
    if (s !== 0) process.exit(s);
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
