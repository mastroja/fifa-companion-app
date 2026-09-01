# EA FC Career Companion

A companion app for EA Sports FC 26 Career Mode. It reads data out of your save via a Live Editor Lua script bound to a hotkey, and turns it into a Home dashboard, season history, transfer tracking, league stats, and an end-of-season summary — all local, all offline, nothing sent anywhere.

This app depends on a specific combination of game version + Live Editor version, because Live Editor works by reading the game's memory at fixed offsets that change with every game patch. **If the versions below don't match, none of this will work**, so read the version-pinning section before installing anything.

## Versions this build was made against

| Component | Version |
|---|---|
| EA Sports FC 26 (Steam) | Build `1.0.139.20381` |
| FC 26 Live Editor | `v26.3.6` |
| Companion App | `1.0.0` |
| Node.js (only needed if building from source) | 18+ |

If you're picking this up later and the numbers above don't match what you're on, update this table once you've confirmed the new combination actually works together.

---

## 1. Pin your game version (do this FIRST)

Live Editor's ability to read the game's memory depends on exact byte offsets for the specific game build it was compiled against (`1.0.139.20381` above). A routine Steam update to FC 26 will silently break Live Editor — it may fail to load, crash the game, or worse, read the wrong offsets and corrupt data without any error at all.

**Before installing anything else:**

1. Open Steam → right-click **EA Sports FC 26** → **Properties** → **Updates** tab.
2. Set **Automatic Updates** to **"Only update this game when I launch it."** This stops Steam from silently patching the game in the background.
3. From now on, **launch the game through Live Editor's launcher, not directly through Steam** (see step 3 below) — Steam only checks for/applies an update when *it* launches the game, so routing your launch through Live Editor's launcher instead avoids triggering that check.
4. As an extra safeguard before any session, you can put Steam in **Offline Mode** (Steam menu → "Go Offline") — this guarantees no update check happens at all for that session, at the cost of Steam's other online features being unavailable while offline.

If your game has *already* auto-updated past `1.0.139.20381`, Steam's client doesn't offer a simple built-in way to roll back to an older build for most titles. The FC 26 modding community generally handles this with a depot-download tool (e.g. DepotDownloader) pointed at the specific old manifest ID for build `1.0.139.20381`, using your own Steam credentials — that's beyond the scope of this README; search the Live Editor community's own docs/Discord for the current recommended method, since manifest IDs and tooling change over time.

---

## 2. Install Live Editor

1. Download **FC 26 Live Editor v26.3.6** from [(Patreon/official site — not linked here since it changes over time; get it from the current official source)](https://www.patreon.com/xAranaktu/posts/fc-26-live-v26-3-166271704).
2. Extract it to a folder **outside** `Program Files` (e.g. `D:\Mods\fc26\FC 26 LE v26.3.6\`) — Windows permission restrictions inside `Program Files` can interfere with how Live Editor patches the running game.
3. Confirm the extracted folder's `le_offsets.json` has `"GAME_VER": "1.0.139.20381"` — if it says a different build number, this Live Editor version doesn't match your game and you need a different LE build (or a different game build — see section 1).

## 3. Launch the game through Live Editor

Live Editor ships its own launcher (`Launcher.exe`) that starts the game through a stand-in EA Anti-Cheat service so external memory reads aren't blocked — this is required for Live Editor (and this companion app) to work at all, and is why you should always start your Career Mode session through this launcher rather than double-clicking the game directly in Steam.

1. Run `Launcher.exe` from the Live Editor folder.
2. Let it launch FC 26 and load into your save as normal.
3. Once you're in-game, open Live Editor's own overlay/UI (check its docs for the exact toggle key if you haven't set this up before) to confirm it's attached and reading the game correctly.

## 4. Bind the export script to F10

This companion app gets all its data from `assets/export_all.lua` in this repo — a single Lua script that exports your squad, calendar, transfers, youth academy, and league-wide stats to JSON files whenever you run it.

1. In Live Editor, find the **Lua Engine** / **Hotkeys** section (added in v26.3.6 — "Option to assign lua script to hotkey").
2. Point it at `export_all.lua`:
   - **Running from source**: wherever you cloned this repo, e.g. `C:\path\to\fifa-companion-app\assets\export_all.lua`.
   - **Installed via the packaged .exe**: the installer unpacks the Lua scripts to a real, plain path (not zipped inside the app) — `<install folder>\resources\app.asar.unpacked\assets\export_all.lua`. By default (unless you changed the install directory in the setup wizard) that's:
     ```
     C:\Users\<your username>\AppData\Local\Programs\EA FC Companion App\resources\app.asar.unpacked\assets\export_all.lua
     ```
     If you're not sure where you installed it, right-click the app's Desktop or Start Menu shortcut → **Open file location** to jump straight to the install folder.
3. Assign it to **F10**.
4. Test it once: press F10 in-game, then check that `C:\Users\Public\` now has `ea_fc_squad_export.json`, `ea_fc_calendar_export.json`, `ea_fc_transfers_export.json`, `ea_fc_youth_export.json`, and `ea_fc_league_stats_export.json`. Those five fixed paths are hardcoded on both sides (the Lua script and the companion app) — nothing to configure there.

**Before pressing F10 for the first time on a save, or after any change to `export_all.lua`:** read the safety note in the repo's memory/commit history about verifying new Live Editor reads in an isolated script first — a bad memory read from this script can crash the game. This particular script has already been exercised extensively, but treat any future edits to it with the same caution.

## 5. Install the Companion App

You have two options depending on who's using it.

### Option A — Packaged installer (recommended for anyone who isn't a developer)

From a machine with Node.js installed (this only needs to happen once, to produce the installer — the person running the installer doesn't need Node.js themselves):

```bash
npm install
npm run dist
```

This produces a Windows installer (`.exe`, via NSIS) in the `dist/` folder. Hand that installer file to whoever wants to run the app — they run it like any other Windows installer, no command line or Node.js required on their end.

### Option B — Run from source (for development / tinkering)

```bash
git clone https://github.com/mastroja/fifa-companion-app.git
cd fifa-companion-app
npm install
npm start
```

### Where things live

- **Database**: `%APPDATA%\fifa-career-companion\companion.sqlite` — this is where every save's full history lives. Back this file up before any risky experiment; it's a plain SQLite file you can copy/restore freely while the app is closed.
- **Export files**: `C:\Users\Public\ea_fc_*.json` — regenerated fresh each F10 press, safe to delete, the app will just wait for the next export.

---

## 6. Verifying a fresh setup works end to end

1. Launch the game via Live Editor's launcher (step 3).
2. Load into your Career Mode save.
3. Press F10.
4. Open the companion app (or restart it if it was already running).
5. Confirm your club name and current squad show up on the Home tab. If they don't, check the app's console/logs for which export file failed to parse — that'll point at whether it's a Live Editor problem (wrong game version, script not bound to F10) or an app problem.

## Troubleshooting

- **Game crashes or won't load after pressing F10** — almost always a game-version mismatch (section 1). Confirm `le_offsets.json`'s `GAME_VER` matches your actual game build before doing anything else.
- **App shows no data at all** — confirm the five export JSON files actually exist and have recent timestamps in `C:\Users\Public\`. If they're missing, F10 isn't reaching the script (check the hotkey binding in Live Editor).
- **App was working, then a Steam update landed and it broke** — see section 1; you'll need to either pin an older manifest or wait for a matching Live Editor update, then update the versions table at the top of this file once confirmed.
- **Data looks wrong right around a promotion/relegation or season rollover** — restart the companion app fully (not just close the window — confirm no `electron.exe` processes are left) before syncing again. The app self-heals some season-labeling data on every full startup, but a still-running old session can otherwise overwrite a fix with stale in-memory data.
