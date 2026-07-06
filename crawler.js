console.log("🚀 Roblox Archive Scanner (API mode) started");

import fs from "fs-extra";
import { execSync } from "child_process";

/* ============================================================
   CONFIG
   ============================================================ */

const OUTPUT_FILE = "games.txt";
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

const BATCH_IDS = 50;        // Roblox multiget endpoints accept batches (keep conservative)
const BATCHES_PER_RUN = 60;  // ~3000 IDs checked per workflow run
const REQUEST_DELAY_MS = 250;
const COMMIT_EVERY_N_BATCHES = 1; // checkpoint commit so cancelled runs don't lose progress

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

async function append(file, text) {
  await fs.appendFile(file, text + "\n");
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

    console.log(`💾 Saved progress (${label})`);
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

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (RobloxArchiveProject/1.0)" }
  });
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
   MAIN LOOP
   ============================================================ */

async function run() {
  let batchesDone = 0;

  for (let b = 0; b < BATCHES_PER_RUN; b++) {
    const ids = nextIdBatch();
    if (ids.length === 0) {
      console.log("✅ All configured ID ranges have been fully scanned.");
      break;
    }

    console.log(`\n🔍 Batch ${b + 1}/${BATCHES_PER_RUN}: IDs ${ids[0]}–${ids[ids.length - 1]}`);

    let places = [];
    try {
      const details = await getPlaceDetails(ids);
      places = details.length ? details : (details.PlaceDetails || details.placeDetails || []);
      if (!Array.isArray(places)) places = [];
    } catch (e) {
      console.log("❌ multiget-place-details failed:", e.message);
      await sleep(REQUEST_DELAY_MS * 4);
      continue;
    }

    const placeById = new Map(places.map(p => [p.placeId, p]));
    const universeIds = [...new Set(places.map(p => p.universeId).filter(Boolean))];

    let gamesByUniverse = new Map();
    try {
      const games = await getGameDetails(universeIds);
      gamesByUniverse = new Map(games.map(g => [g.id, g]));
    } catch (e) {
      console.log("⚠️ /v1/games batch failed (will mark those as unavailable):", e.message);
    }

    for (const id of ids) {
      const place = placeById.get(id);
      const gameInfo = place ? gamesByUniverse.get(place.universeId) : undefined;
      const result = classify(place, gameInfo);

      const title = (result.title || place?.name || "").replace(/\|/g, "/").trim();
      const year = result.year || "?";
      const line = `${result.status} | ${id} | ${title || "(untitled)"} | YEAR:${year} | REASON:${result.reason}`;

      console.log(`  ${id}: ${result.status}${result.year ? " (" + result.year + ")" : ""}`);
      await append(OUTPUT_FILE, line);
    }

    await saveState();
    batchesDone++;

    if (batchesDone % COMMIT_EVERY_N_BATCHES === 0) {
      commitCheckpoint(`batch ${b + 1}, cursor ${state.cursor}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await saveState();
  commitCheckpoint("end of run");
  console.log("\n🏁 Run complete.");
}

run().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
