#!/usr/bin/env node
/**
 * MindSpark Launcher — entry point for the standalone executable.
 *
 * This wrapper:
 *  1. Starts the MindSpark HTTP server (server.js)
 *  2. Automatically opens the user's default browser to the app URL
 *  3. Handles graceful shutdown on Ctrl+C / SIGTERM
 *
 * When packaged with `pkg`, static assets in public/ are bundled inside the
 * executable via the snapshot filesystem. The database file (data/mindspark.db)
 * is created in the working directory at runtime.
 */
'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

// ---- Configuration -------------------------------------------------------
const PORT = process.env.PORT || 3000;
const OPEN_BROWSER = process.env.NO_BROWSER !== '1';

// ---- Open browser (cross-platform) --------------------------------------
function openBrowser(url) {
  try {
    const platform = os.platform();
    if (platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore', shell: true });
    } else if (platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      // Linux / other — try xdg-open, then sensible-browser
      try {
        execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
      } catch {
        execSync(`sensible-browser "${url}"`, { stdio: 'ignore' });
      }
    }
  } catch {
    // Silently ignore if we can't open a browser (headless server, etc.)
  }
}

// ---- Start the server ----------------------------------------------------
console.log(`
  ╔══════════════════════════════════════════════════╗
  ║           MindSpark — Desktop Edition            ║
  ╚══════════════════════════════════════════════════╝
`);

// When running as a pkg executable, __dirname points to the snapshot.
// server.js uses __dirname to find PUBLIC and DB_PATH, which works correctly
// for PUBLIC (inside snapshot). For DB_PATH we override to use real filesystem.
const isPkg = typeof process.pkg !== 'undefined';

if (isPkg) {
  // Inside pkg, __dirname is the snapshot path (e.g. /snapshot/mindspark/)
  // PUBLIC should resolve inside the snapshot (where assets are bundled).
  process.env.PUBLIC = process.env.PUBLIC || path.join(__dirname, 'public');

  // Database should be in the real filesystem (next to the exe), not inside the snapshot.
  if (!process.env.DB_PATH) {
    const exeDir = path.dirname(process.execPath);
    process.env.DB_PATH = path.join(exeDir, 'data', 'mindspark.db');
  }
}

process.env.PORT = String(PORT);

// Start the server by requiring it (this triggers server.listen())
const serverUrl = `http://localhost:${PORT}`;

// Give the server a moment to bind, then open the browser
const startDelay = 500; // ms

try {
  require('./server.js');

  if (OPEN_BROWSER) {
    setTimeout(() => {
      console.log(`  Opening browser → ${serverUrl}\n`);
      openBrowser(serverUrl);
    }, startDelay);
  }
} catch (err) {
  console.error('\n  Failed to start MindSpark server:\n');
  console.error(' ', err.message || err);
  console.error('\n  If you see a "node:sqlite" error, make sure this executable');
  console.error('  was built with Node.js >= 22 which includes built-in SQLite.\n');
  process.exit(1);
}

// ---- Graceful shutdown ---------------------------------------------------
function shutdown() {
  console.log('\n  Shutting down MindSpark...');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
