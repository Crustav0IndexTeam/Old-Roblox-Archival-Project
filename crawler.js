console.log("🚀 crawler started");

import { chromium } from "playwright";
import fs from "fs-extra";

const OUTPUT_FILE = "games.txt";
const CHECKED_FILE = "checked.txt";

// -------------------- LOAD CHECKED IDS --------------------
let checked = new Set();

if (await fs.pathExists(CHECKED_FILE)) {
  const data = await fs.readFile(CHECKED_FILE, "utf-8");
  data.split("\n").forEach((id) => {
    const clean = id.trim();
    if (clean) checked.add(clean);
  });
}

// -------------------- HELPERS --------------------
const append = (file, text) =>
  fs.appendFile(file, text + "\n");

const markChecked = async (id) => {
  const str = String(id);
  checked.add(str);
  await append(CHECKED_FILE, str);
};

function randomId() {
  return Math.floor(Math.random() * (25000000 - 100000 + 1)) + 100000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------- BROWSER --------------------
const browser = await chromium.launch({
  headless: true,
});

const page = await browser.newPage();

// Block images/fonts for speed
await page.route("**/*", (route) => {
  const type = route.request().resourceType();
  if (type === "image" || type === "font") {
    return route.abort();
  }
  route.continue();
});

// -------------------- GAME CHECK --------------------
async function checkGame(id) {
  const url = `https://www.roblox.com/games/${id}`;

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    const finalUrl = page.url();
    const status = response?.status?.() || 0;

    // 🔴 404 detection (fastest check)
    if (
      status === 404 ||
      finalUrl.includes("request-error?code=404")
    ) {
      console.log(`❌ Deleted: ${id}`);
      return null;
    }

    const title = (await page.title())?.trim() || "";

    // 🔴 empty / placeholder page
    if (!title || title === "Roblox") {
      console.log(`⚠️ Empty: ${id}`);
      return null;
    }

    // Only get HTML if needed (performance boost)
    const content = await page.content();

    // 🔞 Unrated / age blocked
    if (content.includes("not accessible because it is unrated")) {
      console.log(`🔞 Unrated: ${id}`);
      return null;
    }

    // 🚫 unavailable / private / broken
    if (
      content.includes("experience cannot be visited") ||
      content.includes("unavailable") ||
      content.includes("content is not available")
    ) {
      console.log(`🚫 Unavailable: ${id}`);
      return null;
    }

    // ❌ fake titles
    if (
      title.toLowerCase().includes("play on roblox") ||
      title.length < 3
    ) {
      console.log(`⚠️ Invalid: ${id}`);
      return null;
    }

    console.log(`✅ FOUND: ${title} | ${id}`);
    return { id, title };

  } catch (err) {
    console.log(`❌ Error: ${id}`);
    return null;
  }
}

// -------------------- MAIN LOOP --------------------
async function run() {
  for (let i = 0; i < 200; i++) {
    const id = String(randomId());

    if (checked.has(id)) continue;

    console.log("Checking:", id);

    const result = await checkGame(id);

    await markChecked(id);

    if (result) {
      await append(OUTPUT_FILE, `${result.title} | ${result.id}`);
    }

    await sleep(500); // faster but still safe
  }

  await browser.close();
}

run();
