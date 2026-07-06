console.log("🚀 ultra crawler started");

import { chromium } from "playwright";
import fs from "fs-extra";

const OUTPUT_FILE = "games.txt";
const CHECKED_FILE = "checked.txt";

const MIN_ID = 100000;
const MAX_ID = 25000000;

const BATCH_SIZE = 200;       // how many IDs per run
const CONCURRENCY = 4;       // safe speed
const DELAY_MIN = 120;
const DELAY_MAX = 350;

// ---------------- LOAD CHECKED ----------------
let checked = new Set();

if (await fs.pathExists(CHECKED_FILE)) {
  const data = await fs.readFile(CHECKED_FILE, "utf-8");
  data.split("\n").forEach(id => {
    if (id.trim()) checked.add(id.trim());
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function randomId() {
  return String(Math.floor(Math.random() * (MAX_ID - MIN_ID + 1)) + MIN_ID);
}

async function markChecked(id) {
  checked.add(id);
  await fs.appendFile(CHECKED_FILE, id + "\n");
}

async function append(file, text) {
  await fs.appendFile(file, text + "\n");
}

// ---------------- BROWSER ----------------
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

// block heavy assets = HUGE speed boost
await context.route("**/*", (route) => {
  const type = route.request().resourceType();
  if (["image", "font", "media"].includes(type)) return route.abort();
  route.continue();
});

const page = await context.newPage();

// ---------------- CORE CHECK ----------------
async function checkGame(id) {
  const url = `https://www.roblox.com/games/${id}`;

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });

    const finalUrl = page.url();

    // ❌ 404 detection
    if (finalUrl.includes("request-error?code=404")) {
      return null;
    }

    const title = (await page.title())?.trim() || "";
    const body = await page.locator("body").innerText().catch(() => "");

    // ❌ loading / fake pages
    if (
      !title ||
      title === "Roblox" ||
      title.toLowerCase().includes("loading") ||
      title.toLowerCase().includes("error")
    ) {
      return null;
    }

    // ❌ unrated / blocked
    if (body.includes("not accessible because it is unrated")) {
      return null;
    }

    // ❌ unavailable / private / deleted
    if (
      body.includes("experience cannot be visited") ||
      body.includes("unavailable") ||
      body.includes("does not exist") ||
      body.includes("Page not found")
    ) {
      return null;
    }

    // ❌ garbage titles
    if (title.toLowerCase().includes("play on roblox")) {
      return null;
    }

    console.log(`✅ FOUND: ${title} | ${id}`);

    return { id, title };

  } catch {
    return null;
  }
}

// ---------------- WORKER ----------------
async function worker(batch) {
  for (const id of batch) {
    if (checked.has(id)) continue;

    await markChecked(id);

    const result = await checkGame(id);

    if (result) {
      await append(OUTPUT_FILE, `${result.title} | ${result.id}`);
    }

    const delay =
      DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

    await sleep(delay);
  }
}

// ---------------- MAIN RUN ----------------
async function run() {
  console.log("📦 generating batch...");

  const batch = Array.from({ length: BATCH_SIZE }, () => randomId());

  const chunks = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    chunks.push(batch.filter((_, idx) => idx % CONCURRENCY === i));
  }

  console.log("⚙️ workers starting:", CONCURRENCY);

  await Promise.all(chunks.map(worker));

  await browser.close();

  console.log("✅ crawler finished cleanly");
}

await run();
