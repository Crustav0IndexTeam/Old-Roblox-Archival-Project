/**
 * 🚀 Old Roblox Archival Project - Crawler v2
 * * Architecture: Headless Chromium (Playwright) Worker Pool
 * Focus: Reliability, Speed, Historical Preservation (2007-2013)
 */

import { chromium } from 'playwright';
import fs from 'fs-extra';
import { execSync } from 'child_process';

/* ============================================================
   CONFIGURATION & TUNING
   ============================================================ */

const CONFIG = {
    // Worker and Performance Settings
    WORKER_COUNT: 4,                  // Number of concurrent Chromium tabs
    PAGE_TIMEOUT: 15000,              // 15 seconds max per page navigation
    MAX_RETRIES: 2,                   // How many times to retry a failed page load
    
    // Archival Target Years
    MIN_YEAR: 2007,
    MAX_YEAR: 2013,

    // File Paths
    FILES: {
        GAMES: 'games.txt',
        DELETED: 'deleted.txt',
        PRIVATE: 'private.txt',
        UNRATED: 'unrated.txt',
        ERRORS: 'errors.txt',
        OUT_OF_RANGE: 'out_of_range.txt',
        STATE: 'scan_state.json',
        STATS: 'stats.json'
    },

    // Checkpointing
    CHECKPOINT_INTERVAL: 500,         // Commit and push every N IDs processed
};

// Sequential ID ranges to scan
const RANGES = [
    { start: 1000, end: 2_000_000 },
    { start: 2_000_000, end: 15_000_000 },
    { start: 15_000_000, end: 40_000_000 },
    { start: 40_000_000, end: 135_000_000 }
];

// Adaptive step sizes based on consecutive deletions
const ADAPTIVE_STEPS = [1, 2, 5, 10, 25, 50, 100];

/* ============================================================
   GLOBAL STATE MANAGEMENT
   ============================================================ */

let state = {
    rangeIndex: 0,
    currentId: RANGES[0].start,
    consecutiveDeleted: 0,
    idsProcessedSinceCommit: 0
};

let stats = {
    checked: 0,
    valid: 0,
    deleted: 0,
    private: 0,
    unrated: 0,
    errors: 0,
    outOfRange: 0,
    startTime: Date.now()
};

// Thread-safe(ish) ID generator for the worker pool
function getNextId() {
    if (state.rangeIndex >= RANGES.length) return null;

    const idToReturn = state.currentId;
    
    // Determine current step based on how many consecutive deletes we've seen
    let stepIndex = Math.floor(state.consecutiveDeleted / 50); // Increase step every 50 deletes
    if (stepIndex >= ADAPTIVE_STEPS.length) stepIndex = ADAPTIVE_STEPS.length - 1;
    const currentStep = ADAPTIVE_STEPS[stepIndex];

    state.currentId += currentStep;

    // Move to next range if we exceed the current one
    if (state.currentId > RANGES[state.rangeIndex].end) {
        state.rangeIndex++;
        if (state.rangeIndex < RANGES.length) {
            state.currentId = RANGES[state.rangeIndex].start;
        }
    }

    return idToReturn;
}

/* ============================================================
   INITIALIZATION & FILE I/O
   ============================================================ */

async function initializeFiles() {
    // Load existing state if resuming from a previous GH Action run
    if (await fs.pathExists(CONFIG.FILES.STATE)) {
        try {
            const savedState = await fs.readJSON(CONFIG.FILES.STATE);
            state = { ...state, ...savedState };
            console.log(`[STATE] Resuming from Range ${state.rangeIndex}, ID: ${state.currentId}`);
        } catch (e) {
            console.warn("⚠️ Failed to parse scan_state.json, starting fresh.");
        }
    }

    if (await fs.pathExists(CONFIG.FILES.STATS)) {
        try {
            const savedStats = await fs.readJSON(CONFIG.FILES.STATS);
            stats = { ...stats, ...savedStats };
            stats.startTime = Date.now(); // Reset start time for current session ETA calculation
        } catch (e) {
            // Ignore stats parse error
        }
    }
}

async function writeResult(file, id, status, reason, metadata = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(metadata).length ? JSON.stringify(metadata) : '';
    const line = `[${timestamp}] ${status} | ID: ${id} | REASON: ${reason} | META: ${metaStr}\n`;
    
    await fs.appendFile(file, line);
    
    // Save immediate state to prevent data loss on sudden crash
    await fs.writeJSON(CONFIG.FILES.STATE, state, { spaces: 2 });
    await fs.writeJSON(CONFIG.FILES.STATS, stats, { spaces: 2 });
}

/* ============================================================
   GITHUB ACTIONS CHECKPOINTING
   ============================================================ */

function commitCheckpoint() {
    try {
        console.log("\n💾 Saving Checkpoint to GitHub...");
        execSync(`git config user.name "github-actions[bot]"`, { stdio: "ignore" });
        execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`, { stdio: "ignore" });
        
        execSync(`git add *.txt *.json`, { stdio: "ignore" });
        execSync(`git commit -m "chore: Crawler checkpoint ID ${state.currentId}" || echo "No changes to commit"`, { stdio: "ignore" });
        execSync(`git push`, { stdio: "ignore" });
        
        console.log("✅ Checkpoint successfully pushed.");
        state.idsProcessedSinceCommit = 0;
    } catch (e) {
        console.log("⚠️ Checkpoint push failed (Network issue or permissions). Crawler will continue.", e.message);
    }
}

/* ============================================================
   PLAYWRIGHT LOGIC & DOM ANALYSIS
   ============================================================ */

async function setupBrowser() {
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    });
    return browser;
}

// Blocks heavy resources to ensure Playwright flies through pages at maximum speed
async function optimizePage(page) {
    await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        const blockedTypes = ['image', 'stylesheet', 'font', 'media', 'other'];
        const url = route.request().url();

        if (blockedTypes.includes(type) || url.includes('google-analytics') || url.includes('tracker')) {
            route.abort();
        } else {
            route.continue();
        }
    });
}

// Analyzes the loaded DOM to classify the experience and extract metadata
async function analyzePage(page, id) {
    // 1. Check for immediate redirects to /games (Standard Roblox behavior for deleted/invalid games)
    if (page.url().endsWith('/games') || page.url().endsWith('/discover')) {
        return { status: 'DELETED', reason: 'Redirected to games/discover page' };
    }

    // 2. Extract DOM data. We execute this block inside the browser context.
    const data = await page.evaluate(() => {
        const titleEl = document.querySelector('.game-name, h1');
        const creatorEl = document.querySelector('.game-creator a');
        const errorEl = document.querySelector('.error-message');
        const privateBadge = document.querySelector('.icon-private, [text*="unavailable"]');
        const unratedBadge = document.querySelector('.age-rating-unrated');
        
        // Scraping stats from the game-stat-container
        const statsNodes = document.querySelectorAll('.game-stat');
        let createdYear = null;
        let visits = null;
        let maxPlayers = null;

        statsNodes.forEach(node => {
            const text = node.innerText.toLowerCase();
            if (text.includes('created')) {
                const dateMatch = text.match(/\d{4}/);
                if (dateMatch) createdYear = parseInt(dateMatch[0], 10);
            }
            if (text.includes('visits')) {
                visits = node.innerText.replace(/\D/g, '');
            }
            if (text.includes('max players')) {
                maxPlayers = node.innerText.replace(/\D/g, '');
            }
        });

        return {
            title: titleEl ? titleEl.innerText.trim() : null,
            creator: creatorEl ? creatorEl.innerText.trim() : null,
            errorText: errorEl ? errorEl.innerText.trim() : null,
            isPrivate: !!privateBadge,
            isUnrated: !!unratedBadge,
            createdYear,
            visits,
            maxPlayers,
            bodyText: document.body.innerText.substring(0, 500) // snippet for fallback analysis
        };
    });

    // 3. Classification Logic based on extracted DOM data
    if (data.errorText || data.bodyText.includes('Page cannot be found')) {
        return { status: 'DELETED', reason: data.errorText || 'Page not found text detected' };
    }
    
    if (data.bodyText.includes('Content Deleted') || data.title === '[ Content Deleted ]') {
        return { status: 'CONTENT_DELETED', reason: 'Content deleted placeholder found' };
    }

    if (data.bodyText.includes('under review')) {
        return { status: 'UNDER_REVIEW', reason: 'Moderation review text found' };
    }

    if (data.isUnrated || data.bodyText.includes('unrated')) {
        return { status: 'UNRATED', reason: 'Unrated UI badge or text detected' };
    }

    if (data.isPrivate || data.bodyText.includes('experience is unavailable')) {
        return { status: 'PRIVATE', reason: 'Private icon or unavailable text detected' };
    }

    if (!data.title) {
        return { status: 'EMPTY', reason: 'No title or discernible game data loaded' };
    }

    // 4. Historical Range Verification
    if (data.createdYear) {
        if (data.createdYear < CONFIG.MIN_YEAR || data.createdYear > CONFIG.MAX_YEAR) {
            return { 
                status: 'OUT_OF_RANGE', 
                reason: `Created in ${data.createdYear}, outside target ${CONFIG.MIN_YEAR}-${CONFIG.MAX_YEAR}`,
                metadata: data
            };
        }
    } else {
        // If we can't find a year but it has a title, we log it as UNKNOWN year to be safe, but treat as VALID.
        data.createdYear = 'UNKNOWN';
    }

    // 5. Valid Game Passed all checks
    return { 
        status: 'VALID', 
        reason: 'Successfully scraped metadata and verified year',
        metadata: {
            title: data.title,
            creator: data.creator,
            year: data.createdYear,
            visits: data.visits,
            maxPlayers: data.maxPlayers
        }
    };
}

/* ============================================================
   WORKER LOOP & EXECUTION
   ============================================================ */

async function runWorker(browser, workerId) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await optimizePage(page);

    while (true) {
        const id = getNextId();
        if (id === null) break; // All ranges exhausted

        let attempt = 0;
        let success = false;
        let result = null;

        while (attempt < CONFIG.MAX_RETRIES && !success) {
            attempt++;
            try {
                const targetUrl = `https://www.roblox.com/games/${id}/-`;
                
                // domcontentloaded is faster than networkidle. We don't need heavy assets.
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.PAGE_TIMEOUT });
                
                result = await analyzePage(page, id);
                success = true;

            } catch (error) {
                if (attempt === CONFIG.MAX_RETRIES) {
                    result = { status: 'ERROR', reason: `Navigation failed after ${CONFIG.MAX_RETRIES} attempts: ${error.message}` };
                }
            }
        }

        // Process Result & Update Counters
        stats.checked++;
        state.idsProcessedSinceCommit++;

        const fileMap = {
            'VALID': CONFIG.FILES.GAMES,
            'DELETED': CONFIG.FILES.DELETED,
            'CONTENT_DELETED': CONFIG.FILES.DELETED,
            'PRIVATE': CONFIG.FILES.PRIVATE,
            'UNAVAILABLE': CONFIG.FILES.PRIVATE,
            'UNRATED': CONFIG.FILES.UNRATED,
            'OUT_OF_RANGE': CONFIG.FILES.OUT_OF_RANGE,
            'ERROR': CONFIG.FILES.ERRORS,
            'EMPTY': CONFIG.FILES.ERRORS,
            'UNDER_REVIEW': CONFIG.FILES.PRIVATE
        };

        const targetFile = fileMap[result.status] || CONFIG.FILES.ERRORS;
        await writeResult(targetFile, id, result.status, result.reason, result.metadata);

        // Adaptive Scanning Logic Adjustment
        if (result.status === 'DELETED' || result.status === 'ERROR' || result.status === 'EMPTY') {
            state.consecutiveDeleted++;
        } else {
            state.consecutiveDeleted = 0; // Reset step size when we hit something tangible
        }

        // Update Stats for Logging
        if (result.status === 'VALID') stats.valid++;
        else if (result.status === 'DELETED') stats.deleted++;
        else if (result.status === 'PRIVATE' || result.status === 'UNAVAILABLE') stats.private++;
        else if (result.status === 'UNRATED') stats.unrated++;
        else if (result.status === 'OUT_OF_RANGE') stats.outOfRange++;
        else stats.errors++;

        // Live Console Output
        const icon = result.status === 'VALID' ? '✅' : 
                     result.status === 'DELETED' ? '❌' : 
                     result.status === 'OUT_OF_RANGE' ? '⏭️ ' :
                     result.status === 'UNRATED' ? '🔞' :
                     result.status === 'PRIVATE' ? '🚫' : '⚠️';
        
        const titleText = result.metadata?.title ? ` | ${result.metadata.title}` : '';
        const yearText = result.metadata?.year ? ` | YEAR ${result.metadata.year}` : '';
        
        console.log(`${icon} ${result.status.padEnd(12)} | ID ${String(id).padEnd(9)}${titleText}${yearText} | ${result.reason}`);

        // Checkpoint logic
        if (state.idsProcessedSinceCommit >= CONFIG.CHECKPOINT_INTERVAL) {
            commitCheckpoint();
        }
    }

    await context.close();
}

/* ============================================================
   MAIN ORCHESTRATOR
   ============================================================ */

async function main() {
    console.log("🚀 Starting Old Roblox Archival Project Crawler (Playwright V2)");
    
    await initializeFiles();
    
    // Status logging interval
    const logInterval = setInterval(() => {
        const elapsedMinutes = (Date.now() - stats.startTime) / 60000;
        const speed = (stats.checked / (elapsedMinutes * 60)).toFixed(2);
        
        console.log(`\n=========================================`);
        console.log(`📊 LIVE STATS`);
        console.log(`Workers: ${CONFIG.WORKER_COUNT} | Speed: ${speed} IDs/sec`);
        console.log(`Checked: ${stats.checked} | Valid: ${stats.valid} | Deleted: ${stats.deleted}`);
        console.log(`Private: ${stats.private} | Unrated: ${stats.unrated} | Errors: ${stats.errors}`);
        console.log(`Current ID: ${state.currentId} | Step Size: ${ADAPTIVE_STEPS[Math.min(Math.floor(state.consecutiveDeleted / 50), ADAPTIVE_STEPS.length - 1)]}`);
        console.log(`=========================================\n`);
    }, 30000); // Print stats every 30 seconds

    let browser;
    try {
        browser = await setupBrowser();
        
        // Spawn Workers
        const workers = [];
        for (let i = 0; i < CONFIG.WORKER_COUNT; i++) {
            workers.push(runWorker(browser, i));
        }

        // Wait for all workers to complete (which theoretically takes months based on ranges)
        await Promise.all(workers);

    } catch (e) {
        console.error("💥 Fatal Error in Main Thread:", e);
    } finally {
        if (browser) await browser.close();
        clearInterval(logInterval);
        commitCheckpoint();
        console.log("🏁 Crawler Shutdown Complete.");
    }
}

// Execute
main();
