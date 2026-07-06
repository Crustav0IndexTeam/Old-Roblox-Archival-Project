console.log("🚀 crawler started");

import { chromium } from "playwright";
import fs from "fs-extra";

const OUTPUT_FILE = "games.txt";
const CHECKED_FILE = "checked.txt";

// Load already checked IDs
let checked = new Set();

if (await fs.pathExists(CHECKED_FILE)) {
  const data = await fs.readFile(CHECKED_FILE, "utf-8");
  data.split("\n").forEach((id) => {
    if (id.trim()) checked.add(id.trim());
  });
}

// Append helper
async function append(file, text) {
  await fs.appendFile(file, text + "\n");
}

// Save checked ID helper
async function markChecked(id) {
  checked.add(String(id));
  await append(CHECKED_FILE, String(id));
}

// Random Roblox-like ID generator
function randomId() {
  return Math.floor(Math.random() * (25000000 - 100000 + 1)) + 100000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

async function checkGame(id) {
  const url = `https://www.roblox.com/games/${id}`;

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    const finalUrl = page.url();
    const title = await page.title();
    const content = await page.content();

    // 404 redirect
    if (finalUrl.includes("request-error?code=404")) return null;

    // Missing pages
    if (
      content.includes("Page not found") ||
      content.includes("does not exist") ||
      content.includes("Error 404")
    ) {
      return null;
    }

    // Unavailable experiences
    if (
      content.includes("not accessible because it is unrated") ||
      content.includes("experience cannot be visited")
    ) {
      return null;
    }

    // Invalid titles
    if (!title || title === "Roblox") return null;

    if (title.toLowerCase().includes("play on roblox")) return null;

    console.log(`FOUND: ${title} | ${id}`);

    return { id, title };
  } catch (e) {
    return null;
  }
}

async function run() {
  for (let i = 0; i < 200; i++) {
    const id = String(randomId());

    console.log("Checking ID:", id);

    // skip already checked IDs
    if (checked.has(id)) continue;

    const result = await checkGame(id);

    await markChecked(id);

    if (result) {
      await append(OUTPUT_FILE, `${result.title} | ${result.id}`);
    }

    await sleep(800);
  }

  await browser.close();
}

run();
