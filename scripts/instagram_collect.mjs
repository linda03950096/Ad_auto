import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "instagram_sources.json");
const queuePath = path.join(root, "instagram_queue.json");
const shouldPublish = process.argv.includes("--publish");

function nowIso() {
  return new Date().toISOString();
}

function normalizeInstagramUrl(url) {
  try {
    const u = new URL(url, "https://www.instagram.com");
    if (!/instagram\.com$/.test(u.hostname.replace(/^www\./, ""))) return null;
    const match = u.pathname.match(/^\/(p|reel|reels)\/([^/]+)/);
    if (!match) return null;
    const type = match[1] === "p" ? "post" : "reel";
    return {
      id: `${type}:${match[2]}`,
      type,
      url: `https://www.instagram.com/${match[1]}/${match[2]}/`,
    };
  } catch {
    return null;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function publishQueue() {
  const add = spawnSync("git", ["add", "instagram_queue.json"], { cwd: root, stdio: "inherit" });
  if (add.status !== 0) return add.status;

  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root });
  if (diff.status === 0) {
    console.log("No queue changes to publish.");
    return 0;
  }

  const commit = spawnSync("git", ["commit", "-m", `chore: update instagram queue ${new Date().toISOString().slice(0, 10)}`], { cwd: root, stdio: "inherit" });
  if (commit.status !== 0) return commit.status;

  const push = spawnSync("git", ["push", "origin", "master"], { cwd: root, stdio: "inherit" });
  return push.status ?? 1;
}

async function collectFromSource(page, source, scrollsPerSource) {
  console.log(`Collecting: ${source.label} -> ${source.url}`);
  await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  const found = new Map();
  for (let i = 0; i < scrollsPerSource; i++) {
    const links = await page.$$eval("a[href]", anchors => anchors.map(a => a.href));
    for (const href of links) {
      const item = normalizeInstagramUrl(href);
      if (item) found.set(item.id, item);
    }
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1800);
  }

  return [...found.values()].map(item => ({
    ...item,
    sourceLabel: source.label,
    sourceUrl: source.url,
    collectedAt: nowIso(),
    status: "new",
    note: "",
  }));
}

async function main() {
  const config = await readJson(configPath, null);
  if (!config?.sources?.length) {
    throw new Error(`No sources configured. Edit ${configPath} first.`);
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run `npm install` in this project, then try again.");
  }

  const queue = await readJson(queuePath, { generatedAt: null, items: [] });
  const existing = new Map((queue.items || []).map(item => [item.id || item.url, item]));
  const profileDir = path.resolve(root, config.chromeProfileDir || ".instagram-profile");

  const context = await playwright.chromium.launchPersistentContext(profileDir, {
    headless: Boolean(config.headless),
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();

  let added = 0;
  try {
    for (const source of config.sources) {
      const items = await collectFromSource(page, source, Number(config.scrollsPerSource || 6));
      for (const item of items) {
        const key = item.id || item.url;
        if (existing.has(key)) continue;
        existing.set(key, item);
        added++;
      }
    }
  } finally {
    await context.close();
  }

  const items = [...existing.values()].sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || "")));
  await writeJson(queuePath, { generatedAt: nowIso(), items });
  console.log(`Collected ${added} new item(s). Queue size: ${items.length}`);

  if (shouldPublish || config.publishToGit) {
    const status = publishQueue();
    if (status !== 0) process.exit(status);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
