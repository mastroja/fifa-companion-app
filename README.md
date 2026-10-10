# FIFA Analytics

A companion app for EA Sports FC 27 Career Mode. It reads data out of your save via a Live Editor Lua script bound to a hotkey, and turns it into a Home dashboard, season history, transfer tracking, league stats, and an end-of-season summary — all local, all offline, nothing sent anywhere.

**What you get:** a Home dashboard, squad list with filters, player profiles, a depth chart (Starting XI, Reserves, custom lineups, All-Time XI), an academy tracker with a regen watchlist, Youth Squad Career Mode tools (rules, transfer ban, challenge dashboard), contract and injury tracking, and an in-app player editor.

This app depends on a specific combination of game version + Live Editor version, because Live Editor works by reading the game's memory at fixed offsets that change with every game patch. **If the versions below don't match, none of this will work**, so read the version-pinning section before installing anything.

## Versions this build was made against

| Component | Version |
|---|---|
| EA Sports FC 27 (Steam) | Build `1.0.141.12554` |
| FC 27 Live Editor | `v27.1.3` |
| FIFA Analytics | `27.0.4` |


## 1. Pin your game version (do this FIRST)

Live Editor's ability to read the game's memory depends on exact byte offsets for the specific game build it was compiled against. A routine Steam update to FC 27 will silently break Live Editor — it may fail to load, crash the game, or worse, read the wrong offsets and corrupt data without any error at all.

**Before installing anything else:**

1. Open Steam → right-click **EA Sports FC 27** → **Properties** → **Updates** tab.
2. Set **Automatic Updates** to **"Only update this game when I launch it."** This stops Steam from silently patching the game in the background.
3. From now on, **launch the game through Live Editor's launcher, not directly through Steam** (see step 4 below) — Steam only checks for/applies an update when *it* launches the game, so routing your launch through Live Editor's launcher instead avoids triggering that check.
4. As an extra safeguard before any session, you can put Steam in **Offline Mode** (Steam menu → "Go Offline") — this guarantees no update check happens at all for that session, at the cost of Steam's other online features being unavailable while offline.

If your game has *already* auto-updated past the pinned build, Steam's client doesn't offer a simple built-in way to roll back to an older build for most titles. The FC 27 modding community generally handles this with a depot-download tool (e.g. DepotDownloader) pointed at the specific old manifest ID, using your own Steam credentials — that's beyond the scope of this README; search the Live Editor community's own docs/Discord for the current recommended method, since manifest IDs and tooling change over time.

---

## 2. Install Live Editor

1. Download **FC 27 Live Editor v27.1.3** from [(Patreon/official site — not linked here since it changes over time; get it from the current official source)](https://www.patreon.com/xAranaktu/posts/fc-26-live-v26-3-166271704).
2. Extract it to a folder (e.g. `D:\Mods\fc27\FC 27 LE v27.1.3\`)
3. Confirm the extracted folder's `le_offsets.json` has a `GAME_VER` matching your actual installed game build — if it says a different build number, this Live Editor version doesn't match your game and you need a different LE build (or a different game build — see section 1).

## 3. Install FIFA Analytics
1. Go to the releases page and download the `.exe` from the latest release. You only do this once; later updates install automatically from inside the app.
2. During installation, select "for me (user)" when prompted.

### Where things live

- **Database**: `%APPDATA%\fifa-analytics\companion.sqlite`. (Older versions kept it in `%APPDATA%\fifa-career-companion`; the first launch of this version copies those saves across and leaves the old folder as a backup.) — this is where every save's full history lives.
- **Export files**: `C:\Users\Public\ea_fc_*.json` — regenerated fresh each F10 press.

## 4. Launch the game through Live Editor

Live Editor ships its own launcher (`Launcher.exe`) that starts the game through a stand-in EA Anti-Cheat service so external memory reads aren't blocked — this is required for Live Editor (and this companion app) to work at all, and is why you should always start your Career Mode session through this launcher rather than double-clicking the game directly in Steam.

1. Run `Launcher.exe` from the Live Editor folder.
2. Let it launch FC 27 and load into your save as normal.
3. Once you're in-game, open Live Editor's own overlay/UI by pressing F9.

## 5. Bind the export script to F10

This companion app gets all its data from `assets/lua/export_all.lua`

1. In Live Editor, find the **Lua Engine** / **Hotkeys** section
2. Point it at `export_all.lua`:
     ```
     C:\Users\<your username>\AppData\Local\Programs\FIFA Analytics\resources\app.asar.unpacked\assets\lua\export_all.lua
     ```
3. Assign it to **F10**.

## 5b. Player editor hotkey (optional): bind F11

The in-app **Edit player** feature (generic / regen / academy players) talks to the game through a second Live Editor script, `assets/lua/player_editor_sync.lua`. The app presses its hotkey when you open the editor (refresh values) and when you press Save (write your edits to the game).

1. In Live Editor's Lua Engine / Hotkeys, add `assets/lua/player_editor_sync.lua` (same folder as `export_all.lua`, `assets/lua/`).
2. Assign it to **F11**. Keep `export_all.lua` on F10; F10 stays read-only, F11 is the only hotkey that writes.
3. That's all: you never run the Lua by hand. Edit player, Save and the Transfer Hub's Release button all go through this hotkey.

## 6. Verifying a fresh setup works end to end

1. Launch the game via Live Editor's launcher (step 4).
2. Load into your Career Mode save.
3. Open the companion app (or restart it if it was already running) and press **Refresh**.
4. Confirm your club name and current squad show up on the Home tab. If they don't, check the app's console/logs for which export file failed to parse — that'll point at whether it's a Live Editor problem (wrong game version, script not bound to F10) or an app problem.

## Troubleshooting

- **Game crashes or won't load after pressing F10** — almost always a game-version mismatch (section 1). Confirm `le_offsets.json`'s `GAME_VER` matches your actual game build before doing anything else.
- **App shows no data at all** — confirm the five export JSON files actually exist and have recent timestamps in `C:\Users\Public\`. If they're missing, F10 isn't reaching the script (check the hotkey binding in Live Editor).
- **App was working, then a Steam update landed and it broke** — see section 1; you'll need to either pin an older manifest or wait for a matching Live Editor update, then update the versions table at the top of this file once confirmed.
- **FC 27 limitations (Live Editor v27.1.3)** — squad, attributes, PlayStyles, loans, contracts (wage and end year), youth academy, manager data and the player editor all work. **Not available yet:** goals / assists / clean sheets / cards, league standings, fixtures and results, transfers, trophies won, league-wide stats and the in-game dynamic overall (the `overall` shown is the player's **base** overall). Live Editor's `GetPlayersStats` and competition-name functions return nothing in FC 27 and the FC 26 memory offsets for standings, fixtures and transfers are wrong, so those Home widgets say "Not available in FC 27 yet". Appearances and an approximate average rating are rebuilt from the game's per-match rating table. See `assets/design_docs/fc27_port_status.md` for the full table and `assets/lua/fc27_probes/README.md` for the test findings and how to re-test after a Live Editor update.
- **Data looks wrong right around a promotion/relegation or season rollover** — restart the companion app fully (not just close the window — confirm no `electron.exe` processes are left) before syncing again. The app self-heals some season-labeling data on every full startup, but a still-running old session can otherwise overwrite a fix with stale in-memory data.
