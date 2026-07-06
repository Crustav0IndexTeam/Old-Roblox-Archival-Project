console.log("🚀 crawler started");
import { chromium } from "playwright";
import fs from "fs-extra";

const OUTPUT_FILE = "games.txt";
const CHECKED_FILE = "checked.txt";

// Load already checked IDs
let checked = new Set();
if (await fs.pathExists(CHECKED_FILE)) {
  const data = await fs.readFile(CHECKED_FILE, "utf-8");
  data.split("\n").forEach(id => checked.add(id.trim()));
}

// Append helper
async function append(file, text) {
  await fs.appendFile(file, text + "\n");
}

// Random Roblox-like ID generator (you will later improve this)
function randomId() {
  return Math.floor(Math.random() * (25000000 - 100000 + 1)) + 100000;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

async function checkGame(id) {
  const url = `https://www.roblox.com/games/${id}`;

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });

    const finalUrl = page.url();
    const title = await page.title();
    const content = await page.content();

    // ❌ 1. Hard 404 redirect detection
    if (finalUrl.includes("request-error?code=404")) {
      return null;
    }

    // ❌ 2. Deleted / missing pages
    if (
      content.includes("Page not found") ||
      content.includes("does not exist") ||
      content.includes("Error 404")
    ) {
      return null;
    }

    // ❌ 3. Unrated / blocked experiences
    if (
      content.includes("not accessible because it is unrated") ||
      content.includes("unavailable") ||
      content.includes("experience cannot be visited")
    ) {
      return null;
    }

    // ❌ 4. Fake/empty Roblox title pages
    if (!title || title === "Roblox") {
      return null;
    }

    // ❌ 5. Very low-quality placeholder names
    if (title.toLowerCase().includes("play on roblox")) {
      return null;
    }

    console.log(`FOUND: ${title} | ${id}`);

    return { id, title };

  } catch (e) {
    return null;
  }
}

async function run() {
  for (let i = 0; i < 200; i++) {   // adjust batch size
    const id = randomId();

    console.log("Checking ID:", id);

    const result = await checkGame(id);

    if (result) {
      await append(OUTPUT_FILE, `${result.title} | ${result.id}`);
    }

    await sleep(800); // avoid rate limits
  }

  await browser.close();
}

run();
