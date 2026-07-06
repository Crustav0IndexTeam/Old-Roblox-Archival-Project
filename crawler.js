console.log("🚀 optimized crawler started");

import { chromium } from "playwright";
import fs from "fs-extra";

const OUTPUT_FILE = "games.txt";
const CHECKED_FILE = "checked.txt";

const MAX_ITERATIONS = 18000; // adjust safely (don’t go insane at first)
const DELAY_MS = 500;

// ---------- LOAD CHECKED IDS ----------
let checked = new Set();

if (await fs.pathExists(CHECKED_FILE)) {
  const data = await fs.readFile(CHECKED_FILE, "utf-8");
  data.split("\n").forEach(id => {
    const clean = id.trim();
    if (clean) checked.add(clean);
  });
}

// ---------- HELPERS ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function randomId() {
  return Math.floor(Math.random() * (25000000 - 100000 + 1)) + 100000;
}

async function markChecked(id) {
  checked.add(id);
  await fs.appendFile(CHECKED_FILE, id + "\n");
}

async function logResult(type, id, title = "") {
  const line = `${type} | ${title} | ${id}`;
  console.log(line);
  await fs.appendFile(OUTPUT_FILE, line + "\n");
}

// ---------- DETECTION CORE ----------
async function checkGame(page, id) {
  const url = `https://www.roblox.com/games/${id}`;

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    const finalUrl = page.url();

    // 1. Deleted / 404 detection
    if (finalUrl.includes("request-error?code=404")) {
      return { type: "DELETED" };
    }

    const title = (await page.title() || "").trim();

    // 2. Fast reject: empty / placeholder
    if (!title || title === "Roblox") {
      return { type: "INVALID" };
    }

    // 3. Unrated / age restricted
    const bodyText = await page.evaluate(() => document.body.innerText);

    if (
      bodyText.includes("not accessible because it is unrated") ||
      bodyText.includes("This experience is not accessible because it is unrated")
    ) {
      return { type: "UNRATED" };
    }

    // 4. Unavailable / private / broken
    if (
      bodyText.includes("experience cannot be visited") ||
      bodyText.includes("This experience is unavailable") ||
      bodyText.includes("content is not available")
    ) {
      return { type: "UNAVAILABLE" };
    }

    // 5. Fake titles
    if (
      title.toLowerCase().includes("play on roblox") ||
      title.length < 3
    ) {
      return { type: "INVALID" };
    }

    // 6. IMPORTANT FIX: kill "Loading..." false positives
    if (title.toLowerCase().includes("loading")) {
      return { type: "INVALID" };
    }

    // 7. VALID GAME
    return {
      type: "VALID",
      title
    };

  } catch (e) {
    return { type: "ERROR" };
  }
}

// ---------- MAIN ----------
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

for (let i = 0; i < MAX_ITERATIONS; i++) {
  const id = String(randomId());

  if (checked.has(id)) continue;

  console.log("Checking:", id);

  const result = await checkGame(page, id);

  await markChecked(id);

  if (result.type === "VALID") {
    await logResult("VALID", id, result.title);
  } else {
    // optional logging (keeps dataset useful)
    await logResult(result.type, id);
  }

  await sleep(DELAY_MS);
}

await browser.close();
console.log("✅ crawler finished");
