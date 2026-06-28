# Tabulon

A cross-platform desktop app for playing board games, built with **Tauri 2** and the **Jocly** JS library. A migration of [JoclyBoard](https://github.com/mi-g/joclyboard) (Electron) to Tauri.

For the internal architecture (Rust ⇄ SharedWorker split, communication protocol, known gaps), see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Prerequisites

- **Rust** (stable) + Cargo — via [rustup](https://www.rust-lang.org/tools/install)
- **Node.js ≥ 20** (npm)
- **Tauri CLI**: `cargo install tauri-cli --version "^2"`
- **ffmpeg** (only needed for the in-app video recording feature)
- **Linux only** — system packages for Tauri's WebView (Debian/Ubuntu):

  ```bash
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  See the [official Tauri prerequisites page](https://v2.tauri.app/start/prerequisites/) for other distros / macOS / Windows.

---

## Building Jocly

Tabulon does not depend on Jocly through npm. Jocly is built separately from
[jocly2](https://github.com/fhoudebert/jocly2), then its `dist/` output is
copied as-is to the root of this repo (`tabulon/dist/`, **not**
`node_modules/`):

```bash
git clone https://github.com/fhoudebert/jocly2.git
cd jocly2
npm install
npm run build          # runs `gulp build --prod`, produces jocly2/dist/

# copy the result into this repo, next to app/ and src-tauri/
cp -r dist /path/to/tabulon/dist
```

Expected result:

```
tabulon/
├── app/
├── dist/                 ← copied from jocly2/dist/
│   └── browser/jocly.js, jocly.core.js, jquery.js, games/, ...
└── src-tauri/
```

Rebuild and re-copy `dist/` whenever you update jocly2.

---

## Building Tabulon

From the `tabulon/` root, once `dist/` is in place:

```bash
# 1. Root dependencies (Tauri CLI, gulp, the PJN parser build chain)
npm install

# 2. Frontend dependencies (@tauri-apps/*, jquery, js-yaml, photonkit)
npm --prefix app install

# 3. Compile the PJN parser (Jison grammar → app/PJNParser.js)
#    NOTE: pjn-parser/*.jison is currently missing from this repo — this step
#    will fail until that source file is restored. Everything except
#    book-history.html works without it. See ARCHITECTURE.md for details.
npm run build:parser

# 4. Run in development mode
npm run dev
# equivalent to: cargo tauri dev

# 5. Production build
npm run build
# bundles end up in src-tauri/target/release/bundle/
```

### Useful commands

```bash
# Type/borrow-check the Rust backend without a full build
cargo check --manifest-path src-tauri/Cargo.toml

# Regenerate app icons from a source PNG (square, ≥1024×1024).
# The icons currently in src-tauri/icons/ were generated manually with
# Pillow (no Rust toolchain was available in the session that produced
# them), from the original griffin artwork. Re-running this is the
# cleaner way to regenerate them once you have tauri-cli on a real
# machine — it also produces a correctly-formatted icon.icns/icon.ico pair.
cargo tauri icon path/to/source.png
# (writes into src-tauri/icons/, matching tauri.conf.json's bundle.icon list)

# List which Tauri commands are registered in lib.rs vs implemented
# in src-tauri/src/commands/*.rs (handy after editing commands)
python3 -c "
import re
def cmds(p):
    return set(re.findall(r'#\[tauri::command\]\s*pub(?:\s+async)?\s+fn\s+(\w+)', open(p).read()))
base = 'src-tauri/src/commands/'
for m in ['engine_cmds','fs_cmds','hub_cmds','match_cmds','template_cmds','video_cmds','window_cmds']:
    print(m, sorted(cmds(base+m+'.rs')))
"
```

---

## Project layout

```
tabulon/
├── app/            Frontend: HTML/JS windows (hub, play, history, ...) + the
│                   SharedWorker holding all game logic (app/worker/)
├── dist/           Jocly build output — see "Building Jocly" above
├── src-tauri/      Rust backend: window management, store, external engine
│                   processes, video recording — no game logic
├── gulpfile.js     PJN parser compilation (Jison → app/PJNParser.js)
└── package.json    Root npm scripts (dev/build/build:parser)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for what each piece does, the
Rust ⇄ JS communication protocol, and the current list of known gaps.

## License

AGPL-3.0 (see `package.json`).
