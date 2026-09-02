# Pinkmo — Desktop Pet Application

You are assisting with **Pinkmo**, a cross-platform desktop pet app. The user is the solo developer ("黑鼠" / 🐭). Keep responses direct and simple; do not pad.

## Tech Stack
- **Tauri v2**: Rust backend (`src-tauri/`) + WebView frontend (`src/`, vanilla JS + Vite)
- Frontend builds to `../dist` (config: `root:"src"`, `build.outDir:"/dist"`) — must align with `frontendDist:"../dist"` in `tauri.conf.json`
- Local dev requires node on PATH:
  `export PATH="/Users/a754/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH"`
- Windows testing is done by the user via remote desktop; you cannot test Win yourself.

## Product Basics
- Transparent desktop pets that walk on the desktop with real click-through.
- Public signature/brand: **黑鼠 (🐭)**. Public-facing copy, easter eggs, and dialogue text must NOT contain the developer's private life (work, real pets' names as personal references, hometown, divination, etc.). Keep copy generic and warm ("romantic, with warmth" tone).
- Version numbers are bare (e.g. `v1.10`), no feature text suffix.

## 🔴 Critical Gotchas — DO NOT re-break these
- **Transparent window**: `transparent:true` + `decorations:false` + `app.macOSPrivateApi:true` + Cargo `macos-private-api` feature. (Semi-transparent cards act as visual anchors so the pet isn't invisible.)
- **WHITE BACKGROUND BUG (unresolved)**: Only the **sprite canvas mode** shows white background; the **image single-picture mode** is transparent fine. The root cause lives in the sprite render layer (canvas/drawImage or a container div white bg), NOT the window level. **Real verification = the user's full-screen screenshot — never self-certify from pixel numbers or claim "fixed" without a screenshot from the user.** (Pixel analysis has produced false positives before.)
- **Multi-window store sync**: Every window's local `pets` array MUST be the FULL array before `persist`. The panel window must first load saved pets from the store, then `ensureOfficialPets`. Otherwise a partial array overwrites the store and wipes the user's pets. Panel listens to `store-changed` and refreshes its local array (not just UI). Pet DOM only mounts on the main window (`spawnPet` guarded by `!IS_PANEL`).
- **Persistence**: `@tauri-apps/plugin-store`, permission name `store:default` (NOT `core:store:default`).
- **CI (`release.yml`)**: `bundle.targets = ["nsis","dmg","app"]`. DO NOT use `installerTypes` (illegal field in Tauri v2). DO NOT click "Re-run" (pins the old commit) — push a tag `v*` to trigger a fresh run.
- **Real click-through (macOS)**: global event tap; `CGEvent.location()` origin is top-left, do NOT flip y; `outer_position()` is physical pixels and must be divided by `scale_factor()`.
- **Drag interaction**: while dragging, report a full-screen hot zone, or macOS dragging out of the pet bounds flips back to click-through and stalls the drag.

## Working Preferences
- **Verify by running**, not by asserting. After changes, run `npm run tauri dev` / `cargo build` (with node on PATH) and report real output.
- **Image/visual changes**: ask the user for a screenshot to confirm. Never self-certify based on pixel numbers or "I think it works."
- **Don't change product direction on your own** — propose first, let the user decide.
- Keep changes minimal and targeted; don't refactor unrelated code.

## Roadmap (by difficulty)
archive → 2D sprite animation → AI talk → social → emotional bonding
- v1.8 archive done. 2D sprite (Q-version/flat cute) is the next animation milestone; sprite sheet + JSON config driven.
- Asset generation for sprites: use 即梦 (jimeng.jianying.com) for character-consistent images, NOT积分-burning tools. User handles asset generation; you handle code.

## Scope Boundary
This project is code/UX only. Personal life, finances, divination, and non-Pinkmo topics are handled by a different assistant ("黑鼠" chat) — do not mix them into this repo.
