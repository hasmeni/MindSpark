# Building MindSpark as a Standalone Executable

This guide explains how to package MindSpark into a standalone executable (`.exe` for Windows, or native binaries for macOS/Linux) that can be distributed and run without requiring Node.js to be installed.

## Prerequisites

- **Node.js >= 22** (required for built-in `node:sqlite`)
- **npm** (comes with Node.js)

## Quick Build

```bash
# Install dev dependencies (just pkg + wrangler)
npm install

# Build for Windows (cross-compile works from any OS)
npm run build:win

# Build for macOS
npm run build:mac

# Build for Linux
npm run build:linux

# Build for current platform (auto-detect)
npm run build:exe
```

The output binary will be in the `dist/` directory.

## What Gets Packaged

The executable bundles:
- The Node.js 22 runtime (with built-in SQLite support)
- `server.js` — the zero-dependency HTTP + SQLite API server
- `launcher.js` — entry point that starts the server and opens your browser
- `public/` — all frontend assets (index.html, app.js, styles.css, demo-map.json, etc.)

The SQLite **database file** (`data/mindspark.db`) is NOT bundled — it's created at runtime in a `data/` folder next to wherever the executable is placed.

## Running the Executable

### Windows
```
mindspark.exe
```

### macOS / Linux
```bash
chmod +x mindspark-macos   # or mindspark-linux
./mindspark-macos
```

On first launch:
1. The app starts a local HTTP server on port 3000
2. Your default browser opens automatically to `http://localhost:3000`
3. A `data/` folder is created next to the executable containing your SQLite database

### Configuration

Set environment variables before running:

| Variable     | Default                        | Description                          |
|--------------|--------------------------------|--------------------------------------|
| `PORT`       | `3000`                         | HTTP port for the server             |
| `DB_PATH`    | `<exe_dir>/data/mindspark.db`  | Path to the SQLite database file     |
| `NO_BROWSER` | *(unset)*                      | Set to `1` to skip auto-opening browser |

Example (Windows):
```cmd
set PORT=8080
set NO_BROWSER=1
mindspark.exe
```

Example (Linux/macOS):
```bash
PORT=8080 NO_BROWSER=1 ./mindspark-linux
```

## Build Targets

The `pkg` configuration supports cross-compilation. You can build for any platform from any platform:

| Script            | Target                  | Output File          |
|-------------------|-------------------------|----------------------|
| `npm run build:win`   | Windows x64        | `dist/mindspark.exe`   |
| `npm run build:mac`   | macOS x64          | `dist/mindspark-macos` |
| `npm run build:linux` | Linux x64          | `dist/mindspark-linux` |
| `npm run build:exe`   | Current platform   | `dist/mindspark`       |

## File Structure After Build

```
dist/
└── mindspark.exe          # The standalone executable (~80-100 MB)

# When the user runs it, this appears next to the exe:
data/
└── mindspark.db           # SQLite database (created at runtime)
```

## How It Works

[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) packages the Node.js runtime, your JavaScript source files, and static assets into a single executable. The key points:

1. **Entry point:** `launcher.js` is the `"bin"` field in `package.json` — pkg uses this as the main entry.
2. **Assets:** The `"pkg.assets"` field tells pkg to bundle everything in `public/` into the executable's virtual filesystem (snapshot).
3. **Runtime paths:** Inside the exe, `__dirname` resolves to the snapshot path. `launcher.js` sets `PUBLIC` to point inside the snapshot and `DB_PATH` to point to the real filesystem (next to the exe).
4. **SQLite:** Since Node 22's `node:sqlite` is compiled into the Node binary itself (not a native addon), it works seamlessly inside the pkg executable.

## Troubleshooting

### "ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite"
This means the pkg-fetched Node binary doesn't include `node:sqlite`. Ensure you're targeting Node 22+:
```bash
pkg . --target node22-win-x64 --output dist/mindspark.exe
```

### Port already in use
Another instance is running, or another app is using port 3000. Set a different port:
```cmd
set PORT=3001
mindspark.exe
```

### Database permission errors
Make sure the executable has write permissions in its directory (to create the `data/` folder). On Windows, avoid running from `C:\Program Files\` — place it in a user-writable location.

### Browser doesn't open automatically
Set `NO_BROWSER=1` and manually navigate to `http://localhost:3000` (or your configured port).

## Alternative: Node.js Single Executable Application (SEA)

Node.js 22+ also has a built-in [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) feature. This is more experimental but doesn't require `pkg`:

```bash
# 1. Create SEA config
echo '{"main":"launcher.js","output":"sea-prep.blob"}' > sea-config.json

# 2. Generate the blob
node --experimental-sea-config sea-config.json

# 3. Copy the Node binary (on Windows)
copy "C:\Program Files\nodejs\node.exe" mindspark.exe

# 4. Remove the signature (Windows only)
signtool remove /s mindspark.exe

# 5. Inject the blob
npx postject mindspark.exe NODE_SEA_BLOB sea-prep.blob ^
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 6. Re-sign (optional, Windows only)
signtool sign /fd SHA256 mindspark.exe
```

**Limitation:** SEA bundles only a single JS file. You would need to inline the `public/` assets into the JS or use SEA's asset blob feature. The `pkg` approach is simpler for this project.

## Distribution

To distribute the built executable:

1. Build with `npm run build:win`
2. Zip the `dist/mindspark.exe` file
3. Share the zip — recipients just extract and double-click

No Node.js installation required on the target machine. The entire runtime is self-contained.
