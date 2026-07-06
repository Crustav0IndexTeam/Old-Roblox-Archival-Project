console.log("🚀 Roblox Archive Scanner started");

import { chromium } from "playwright";
import fs from "fs-extra";

const OUTPUT_FILE = "games.txt";
const CHECKED_FILE = "checked.txt";

const MIN_YEAR = 2007;
const MAX_YEAR = 2013;

const BATCH_SIZE = 18000;
const DELAY = 350; // faster but still safe-ish

let checked = new Set();

if (await fs.pathExists(CHECKED_FILE)) {
  const data = await fs.readFile(CHECKED_FILE, "utf-8");
  data.split("\n").forEach(id => checked.add(id.trim()));
}

async function append(file, text) {
  await fs.appendFile(file, text + "\n");
}

function randomId() {
  // better distribution than pure random
  const base = 10000000;
  return String(base + Math.floor(Math.random() * 20000000));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

async function extractYear(text) {
  // Roblox often shows dates like "Created: Jan 1, 2012"
  const match = text.match(/(20\d{2})/);
  if (!match) return null;
  return parseInt(match[1]);
}

async function checkGame(id) {
  const url = `https://www.roblox.com/games/${id}`;

  console.log(`\n🔍 Checking ${id}`);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    const finalUrl = page.url();

    // ❌ Deleted
    if (finalUrl.includes("request-error?code=404")) {
      console.log("❌ Deleted");
      return { status: "deleted" };
    }

    // ❌ Invalid redirect bug
    if (finalUrl.includes("Play%20on%20Roblox")) {
      console.log("⚠️ Invalid redirect");
      return { status: "invalid" };
    }

    const text = await page.evaluate(() =>
      document.body ? document.body.innerText : ""
    );

    const title = (await page.title())?.trim();

    console.log("📄 Title:", title || "none");

    // 🔞 unrated
    if (text.includes("not accessible because it is unrated")) {
      console.log("🔞 Unrated experience");
      return { status: "unrated" };
    }

    // 🚫 unavailable
    if (text.includes("experience cannot be visited") ||
        text.includes("This experience is unavailable")) {
      console.log("🚫 Unavailable");
      return { status: "unavailable" };
    }

    if (!title || title === "Roblox") {
      console.log("⚠️ Empty page");
      return { status: "empty" };
    }

    if (title.toLowerCase().includes("play on roblox")) {
      console.log("⚠️ Fake title");
      return { status: "invalid" };
    }

    // 📅 attempt year detection
    const year = await extractYear(text);
    console.log("📅 Year detected:", year || "unknown");

    if (year && (year < MIN_YEAR || year > MAX_YEAR)) {
      console.log("⏭ Outside target range (2007–2013)");
      return { status: "out_of_range", year };
    }

    // 🎮 valid candidate
    console.log("✅ VALID CANDIDATE FOUND");

    return {
      status: "valid",
      title,
      id,
      year: year || "unknown"
    };

  } catch (e) {
    console.log("❌ Error loading page");
    return { status: "error" };
  }
}

async function run() {
  for (let i = 0; i < BATCH_SIZE; i++) {
    const id = randomId();

    if (checked.has(id)) continue;

    const result = await checkGame(id);

    checked.add(id);
    await append(CHECKED_FILE, id);

    if (result.status === "valid") {
      await append(
        OUTPUT_FILE,
        `VALID | ${result.title} | ${result.id} | YEAR:${result.year}`
      );
    } else {
      await append(
        OUTPUT_FILE,
        `${result.status.toUpperCase()} | ${id} | YEAR:${result.year || "?"}`
      );
    }

    await sleep(DELAY);
  }

  await browser.close();
}

run();
