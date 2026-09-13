# EA FC Career Companion

A companion app for EA Sports FC 26 Career Mode. It reads data out of your save via a Live Editor Lua script bound to a hotkey, and turns it into a Home dashboard, season history, transfer tracking, league stats, and an end-of-season summary — all local, all offline, nothing sent anywhere.

This app depends on a specific combination of game version + Live Editor version, because Live Editor works by reading the game's memory at fixed offsets that change with every game patch. **If the versions below don't match, none of this will work**, so read the version-pinning section before installing anything.

## Versions this build was made against

| Component | Version |
|---|---|
| EA Sports FC 26 (Steam) | Build `1.0.139.20381` |
| FC 26 Live Editor | `v26.3.6` |
| Companion App | `1.6.0` |


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
2. Extract it to a folder (e.g. `D:\Mods\fc26\FC 26 LE v26.3.6\`) 
3. Confirm the extracted folder's `le_offsets.json` has `"GAME_VER": "1.0.139.20381"` — if it says a different build number, this Live Editor version doesn't match your game and you need a different LE build (or a different game build — see section 1).

## 5. Install the Companion App
1. Navigate to the releases page and download the .exe from the latest release. You will only need to do this once, future updated will auto sycn to your app.
2. During installation, select "for me (user)" when prompted.

### Where things live

- **Database**: `%APPDATA%\fifa-career-companion\companion.sqlite` — this is where every save's full history lives.
- **Export files**: `C:\Users\Public\ea_fc_*.json` — regenerated fresh each F10 press.

## 3. Launch the game through Live Editor

Live Editor ships its own launcher (`Launcher.exe`) that starts the game through a stand-in EA Anti-Cheat service so external memory reads aren't blocked — this is required for Live Editor (and this companion app) to work at all, and is why you should always start your Career Mode session through this launcher rather than double-clicking the game directly in Steam.

1. Run `Launcher.exe` from the Live Editor folder.
2. Let it launch FC 26 and load into your save as normal.
3. Once you're in-game, open Live Editor's own overlay/UI by pressing F9.

## 4. Bind the export script to F10

This companion app gets all its data from `assets/export_all.lua`

1. In Live Editor, find the **Lua Engine** / **Hotkeys** section
2. Point it at `export_all.lua`:
     ```
     C:\Users\<your username>\AppData\Local\Programs\EA FC Companion App\resources\app.asar.unpacked\assets\export_all.lua
     ```
3. Assign it to **F10**.

## 5. Verifying a fresh setup works end to end

1. Launch the game via Live Editor's launcher (step 3).
2. Load into your Career Mode save.
3. Hit refresh button on companion app
4. Open the companion app (or restart it if it was already running).
5. Confirm your club name and current squad show up on the Home tab. If they don't, check the app's console/logs for which export file failed to parse — that'll point at whether it's a Live Editor problem (wrong game version, script not bound to F10) or an app problem.

## Troubleshooting

- **Game crashes or won't load after pressing F10** — almost always a game-version mismatch (section 1). Confirm `le_offsets.json`'s `GAME_VER` matches your actual game build before doing anything else.
- **App shows no data at all** — confirm the five export JSON files actually exist and have recent timestamps in `C:\Users\Public\`. If they're missing, F10 isn't reaching the script (check the hotkey binding in Live Editor).
- **App was working, then a Steam update landed and it broke** — see section 1; you'll need to either pin an older manifest or wait for a matching Live Editor update, then update the versions table at the top of this file once confirmed.
- **Data looks wrong right around a promotion/relegation or season rollover** — restart the companion app fully (not just close the window — confirm no `electron.exe` processes are left) before syncing again. The app self-heals some season-labeling data on every full startup, but a still-running old session can otherwise overwrite a fix with stale in-memory data.
