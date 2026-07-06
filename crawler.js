console.log("🚀 optimized crawler started");

import { chromium } from "playwright";
import fs from "fs-extra";

const OUTPUT_FILE = "games.txt";
const CHECKED_FILE = "checked.txt";

const MIN_ID = 100000;
const MAX_ID = 25000000;

const CONCURRENCY = 3; // safe for Roblox (don’t go crazy)
const BATCH_SIZE = 60; // per cycle

// -------------------- LOAD CHECKED --------------------
let checked = new Set();

if (await fs.pathExists(CHECKED_FILE)) {
  const data = await fs.readFile(CHECKED_FILE, "utf-8");
  data.split("\n").forEach(id => {
    if (id.trim()) checked.add(id.trim());
  });
}

// -------------------- HELPERS --------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function randomId() {
  return Math.floor(Math.random() * (MAX_ID - MIN_ID + 1)) + MIN_ID;
}

async function markChecked(id) {
  checked.add(id);
  await fs.appendFile(CHECKED_FILE, id + "\n");
}

async function append(file, text) {
  await fs.appendFile(file, text + "\n");
}

// -------------------- BROWSER --------------------
const browser = await chromium.launch({
  headless: true
});

// block heavy resources (MAJOR speed boost)
const context = await browser.newContext();

await context.route("**/*", (route) => {
  const r = route.request().resourceType();

  // block heavy stuff
  if (["image", "font", "media"].includes(r)) {
    return route.abort();
  }

  route.continue();
});

const page = await context.newPage();

// -------------------- CHECK GAME --------------------
async function checkGame(id) {
  const url = `https://www.roblox.com/games/${id}`;

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });

    const finalUrl = page.url();

    // FAST reject: 404 redirect
    if (finalUrl.includes("request-error?code=404")) {
      return null;
    }

    // FAST page check (no full HTML dump)
    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (!bodyText) return null;

    // ❌ Deleted / not found
    if (
      bodyText.includes("Page not found") ||
      bodyText.includes("does not exist")
    ) return null;

    // 🔞 Unrated / age blocked
    if (
      bodyText.includes("not accessible because it is unrated")
    ) return null;

    // 🚫 unavailable / private
    if (
      bodyText.includes("experience cannot be visited") ||
      bodyText.includes("unavailable")
    ) return null;

    const title = (await page.title()).trim();

    // ❌ garbage titles
    if (!title || title === "Roblox") return null;
    if (title.toLowerCase().includes("play on roblox")) return null;

    console.log(`✅ FOUND: ${title} | ${id}`);
    return { id, title };

  } catch {
    return null;
  }
}

// -------------------- WORKER --------------------
async function worker() {
  while (true) {
    const id = String(randomId());

    if (checked.has(id)) continue;

    await markChecked(id);

    const result = await checkGame(id);

    if (result) {
      await append(OUTPUT_FILE, `${result.title} | ${result.id}`);
    }

    // small random delay prevents bans
    await sleep(150 + Math.random() * 300);
  }
}

// -------------------- RUN --------------------
for (let i = 0; i < CONCURRENCY; i++) {
  worker();
}
