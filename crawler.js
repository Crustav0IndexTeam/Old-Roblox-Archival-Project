console.log("🚀 Roblox Archive Scanner (API mode) started");

import fs from "fs-extra";
import { execSync } from "child_process";

/* ============================================================
   CONFIG
   ============================================================ */

const OUTPUT_FILE = "games.txt";     // only VALID/interesting results (or all — see WRITE_ALL_TO_GAMES below)
const CHECKED_FILE = "checked.txt";  // every single ID that was checked, regardless of status
const STATE_FILE = "scan_state.json"; // tracks resume position per range

const MIN_YEAR = 2007;
const MAX_YEAR = 2013;

// Sequential ID ranges to scan. Old-Roblox IDs are broadly chronological,
// so scanning sequential windows finds far more 2007-2013 games than
// random sampling across the entire (mostly modern) ID space.
// Adjust/extend these as you discover better boundaries (e.g. from
// known IDs like Robloxity=12468179, Darkness I=131403963).
const RANGES = [
  { start: 1000, end: 2_000_000 },        // 2007-ish territory
  { start: 2_000_000, end: 15_000_000 },  // 2008-2010ish
  { start: 15_000_000, end: 40_000_000 }, // 2010-2011ish
  { start: 40_000_000, end: 135_000_000 } // 2012-2013ish
];

const BATCH_IDS = 100;       // IDs grouped per "batch" for the /v1/games lookup step
const BATCHES_PER_RUN = 300; // ~30,000 IDs checked per workflow run
const CONCURRENCY = 3;       // how many batches to process in parallel per "wave"
const INNER_CONCURRENCY = 20; // how many per-ID universe lookups run in parallel within a batch
const WAVE_DELAY_MS = 300;   // pause between waves (not between every request) — keeps bursts spaced out
const COMMIT_EVERY_N_WAVES = 2; // checkpoint commit so cancelled runs don't lose progress
const FLUSH_EVERY_N_ITEMS = 100;  // write buffered lines to disk every N processed IDs

// Backoff settings for when Roblox responds with 429 (rate limited) or 5xx
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500; // doubles each retry: 500ms, 1s, 2s, 4s

// If true, every checked ID's line goes into games.txt too (not just checked.txt).
// If false, games.txt only gets lines worth keeping (VALID/UNRATED/etc — you decide below).
const WRITE_ALL_TO_GAMES = true;

console.log(`Scanning ${BATCHES_PER_RUN * BATCH_IDS} IDs this run.`);

/* ============================================================
   STATE
   ============================================================ */

let state = { rangeIndex: 0, cursor: RANGES[0].start };
if (await fs.pathExists(STATE_FILE)) {
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, "utf-8"));
  } catch {
    console.log("⚠️ Could not parse state file, starting fresh");
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Run `worker` over `items` with at most `limit` in flight at once.
async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(workers);
}

async function saveState() {
  await fs.writeFile(STATE_FILE, JSON.stringify(state));
}

function commitCheckpoint(label) {
  try {
    execSync(`git config user.name "github-actions"`, { stdio: "ignore" });
    execSync(`git config user.email "github-actions@github.com"`, { stdio: "ignore" });

    // Stage everything that may have changed
    execSync(`git add .`, { stdio: "ignore" });

    // Commit if needed
    try {
      execSync(`git commit -m "checkpoint: ${label}"`, {
        stdio: "ignore"
      });
    } catch {
      console.log("📁 No new changes to commit.");
      return;
    }

    // Pull remote changes first in case another commit happened
    try {
      execSync(`git pull --rebase`, { stdio: "inherit" });
    } catch {
      console.log("⚠️ Could not rebase, continuing...");
    }

    // Push
    execSync(`git push`, { stdio: "inherit" });

    console.log(`💾 Git checkpoint pushed (${label})`);
  } catch (e) {
    console.log("⚠️ Save failed:", e.message);
  }
}

function nextIdBatch() {
  const ids = [];
  while (ids.length < BATCH_IDS) {
    if (state.rangeIndex >= RANGES.length) return ids; // all ranges exhausted
    const range = RANGES[state.rangeIndex];
    if (state.cursor > range.end) {
      state.rangeIndex++;
      if (state.rangeIndex < RANGES.length) state.cursor = RANGES[state.rangeIndex].start;
      continue;
    }
    ids.push(state.cursor);
    state.cursor++;
  }
  return ids;
}

/* ============================================================
   ROBLOX API HELPERS
   ============================================================ */

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (RobloxArchiveProject/1.0)" }
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`HTTP ${res.status} for ${url} (out of retries)`);
    }
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
    console.log(`  ⏳ HTTP ${res.status}, backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return fetchJson(url, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

// Batch place details: name, universeId, isPlayable, reasonProhibited
async function getPlaceDetails(ids) {
  const url = `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${ids.join(",")}`;
  return fetchJson(url);
}

// Batch universe/game details: created date, visits, etc.
async function getGameDetails(universeIds) {
  if (universeIds.length === 0) return [];
  const url = `https://games.roblox.com/v1/games?universeIds=${universeIds.join(",")}`;
  const data = await fetchJson(url);
  return data.data || [];
}

function classify(place, gameInfo) {
  // place: entry from multiget-place-details (may be undefined -> id doesn't exist at all)
  // gameInfo: matching entry from /v1/games (may be undefined -> universe data unavailable)

  if (!place) {
    return { status: "DELETED", reason: "No place data returned by Roblox (place does not exist or was deleted)" };
  }

  const reasonProhibited = place.reasonProhibited || "None";

  if (reasonProhibited === "Unrated") {
    return { status: "UNRATED", reason: "Roblox reports this experience as unrated (reasonProhibited=Unrated)" };
  }
  if (reasonProhibited !== "None") {
    return { status: "UNAVAILABLE", reason: `Roblox reports reasonProhibited=${reasonProhibited}` };
  }
  if (place.isPlayable === false) {
    return { status: "UNAVAILABLE", reason: "isPlayable=false returned by Roblox API" };
  }
  if (!place.name || place.name.trim() === "") {
    return { status: "EMPTY", reason: "Place exists but has no name/title data" };
  }

  if (!gameInfo) {
    return { status: "UNAVAILABLE", reason: "Place exists but universe/game data could not be retrieved (likely private or restricted)" };
  }

  const created = gameInfo.created ? new Date(gameInfo.created) : null;
  const year = created ? created.getFullYear() : null;

  if (year && (year < MIN_YEAR || year > MAX_YEAR)) {
    return { status: "OUT_OF_RANGE", reason: `Created ${created.toISOString().slice(0, 10)}, outside target range`, year };
  }

  return {
    status: "VALID",
    reason: "Confirmed playable via Roblox Games API with creation date in target range",
    title: gameInfo.name || place.name,
    year: year || "unknown"
  };
}

/* ============================================================
   BUFFERED WRITER
   ============================================================ */

// Every checked line always goes in checkedBuffer -> checked.txt.
// gamesBuffer only gets a line if WRITE_ALL_TO_GAMES is true, or you
// can tighten this to e.g. status !== "DELETED" to keep games.txt leaner.
let checkedBuffer = [];
let gamesBuffer = [];
let itemsSinceFlush = 0;

async function flushBuffers(force = false) {
  if (!force && itemsSinceFlush < FLUSH_EVERY_N_ITEMS) return;
  if (checkedBuffer.length === 0 && gamesBuffer.length === 0) return;

  if (checkedBuffer.length) {
    await fs.appendFile(CHECKED_FILE, checkedBuffer.join("\n") + "\n");
    checkedBuffer = [];
  }
  if (gamesBuffer.length) {
    await fs.appendFile(OUTPUT_FILE, gamesBuffer.join("\n") + "\n");
    gamesBuffer = [];
  }
  itemsSinceFlush = 0;
}

/* ============================================================
   MAIN LOOP
   ============================================================ */

// Fetch + classify + buffer a single batch of IDs. Safe to run concurrently
// with other calls to this function since it only touches shared buffers
// via push (no read-modify-write races) and flushBuffers() is only ever
// awaited from the single-threaded main loop between waves.
async function processBatch(ids, batchLabel) {
  console.log(`\n🔍 Batch ${batchLabel}: IDs ${ids[0]}–${ids[ids.length - 1]}`);

  let places = [];
  try {
    const details = await getPlaceDetails(ids);
    places = details.length ? details : (details.PlaceDetails || details.placeDetails || []);
    if (!Array.isArray(places)) places = [];
  } catch (e) {
    console.log(`❌ Batch ${batchLabel} multiget-place-details failed:`, e.message);
    return; // this batch's IDs are simply skipped this run; cursor already moved past them
  }

  const placeById = new Map(places.map(p => [p.placeId, p]));
  const universeIds = [...new Set(places.map(p => p.universeId).filter(Boolean))];

  let gamesByUniverse = new Map();
  try {
    const games = await getGameDetails(universeIds);
    gamesByUniverse = new Map(games.map(g => [g.id, g]));
  } catch (e) {
    console.log(`⚠️ Batch ${batchLabel} /v1/games failed (marking those as unavailable):`, e.message);
  }

  for (const id of ids) {
    const place = placeById.get(id);
    const gameInfo = place ? gamesByUniverse.get(place.universeId) : undefined;
    const result = classify(place, gameInfo);

    const title = (result.title || place?.name || "").replace(/\|/g, "/").trim();
    const year = result.year || "?";
    const line = `${result.status} | ${id} | ${title || "(untitled)"} | YEAR:${year} | REASON:${result.reason}`;

    console.log(`💾 Saved: ${line}`);

    checkedBuffer.push(line);
    if (WRITE_ALL_TO_GAMES) gamesBuffer.push(line);
    itemsSinceFlush++;
  }
}

async function run() {
  // Pre-plan all the ID batches for this run up front (this is what advances
  // state.cursor). We do this synchronously/sequentially so resume position
  // stays deterministic even though the actual fetching below runs concurrently.
  const plannedBatches = [];
  for (let b = 0; b < BATCHES_PER_RUN; b++) {
    const ids = nextIdBatch();
    if (ids.length === 0) break;
    plannedBatches.push(ids);
  }

  if (plannedBatches.length === 0) {
    console.log("✅ All configured ID ranges have been fully scanned.");
    await flushBuffers(true);
    commitCheckpoint("end of run (nothing left to scan)");
    return;
  }

  let wave = 0;
  for (let i = 0; i < plannedBatches.length; i += CONCURRENCY) {
    const group = plannedBatches.slice(i, i + CONCURRENCY);

    await Promise.all(
      group.map((ids, idx) => processBatch(ids, `${i + idx + 1}/${plannedBatches.length}`))
    );

    await flushBuffers(); // no-op unless itemsSinceFlush hit FLUSH_EVERY_N_ITEMS
    await saveState();
    wave++;

    if (wave % COMMIT_EVERY_N_WAVES === 0) {
      await flushBuffers(true); // make sure disk is up to date before committing
      commitCheckpoint(`wave ${wave}, cursor ${state.cursor}`);
    }

    await sleep(WAVE_DELAY_MS); // brief pause between waves, not between every request
  }

  await flushBuffers(true); // final flush so nothing buffered gets lost
  await saveState();
  commitCheckpoint("end of run");
  console.log("\n🏁 Run complete.");
}

run().catch(async e => {
  console.error("Fatal error:", e);
  await flushBuffers(true); // don't lose buffered progress on crash
  process.exit(1);
});
