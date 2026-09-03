const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const initSqlJs = require('sql.js');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let db = null;
const dbPath = path.join(app.getPath('userData'), 'companion.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

const squadExportPath = 'C:\\Users\\Public\\ea_fc_squad_export.json';
const calendarExportPath = 'C:\\Users\\Public\\ea_fc_calendar_export.json';
const transferExportPath = 'C:\\Users\\Public\\ea_fc_transfers_export.json';
const watchlistInputPath = 'C:\\Users\\Public\\ea_fc_watchlist_input.json';
const watchlistStatusPath = 'C:\\Users\\Public\\ea_fc_watchlist_status.json';
const youthExportPath = 'C:\\Users\\Public\\ea_fc_youth_export.json';
const leagueStatsExportPath = 'C:\\Users\\Public\\ea_fc_league_stats_export.json';

// activeSaveId/currentSeasonId track whichever save/season the app is
// currently pointed at — auto-updated on every sync (see
// getOrCreateSaveByUID), and switchable on demand via the Save selector
// (see selectSave). Read functions default to these when no explicit
// saveId/seasonId is passed, mirroring getSquadFromDB's existing
// `seasonId = currentSeasonId` pattern.
let activeSaveId = null;
// Whichever save Live Editor most recently actually synced data for —
// distinct from activeSaveId, which the Save selector can point
// elsewhere for browsing. Lets the UI tell the difference between "this
// is live" and "this is a stored snapshot" (see selectSave).
let liveSyncedSaveId = null;
let currentSeasonId = null;
let leagueTeamNames = new Set();
let userClubName = null;
// Most recently synced ea_fc_league_stats_export.json payload (see the
// LEAGUE STATS EXPORT block in export_all.lua) — not persisted to the DB,
// just kept here so a season-rollover mid-sync (see
// generateSeasonAwardsIfNeeded) can check whether any of our own players
// were the league's statistical leader at that moment. May be slightly
// stale relative to the exact rollover tick since this file syncs
// independently of the squad/calendar files that trigger rollover
// detection — same best-effort-from-whatever-just-synced approach as the
// rest of this app's live-only data.
let latestLeagueStatsPayload = null;

// ------------------------------------------------------------------
// DB bootstrap
// ------------------------------------------------------------------

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log('[DB] Loaded existing SQLite database from disk.');
  } else {
    db = new SQL.Database();
    console.log('[DB] Created brand new SQLite database instance.');
  }

  // IMPORTANT: schema.sql only ever does CREATE TABLE IF NOT EXISTS.
  // Never DROP TABLE here — that was wiping season history on every launch.
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.run(schemaSql);

  // Columns added to player_season_stats after some users already had a DB
  // on disk — CREATE TABLE IF NOT EXISTS won't backfill those, so ALTER them
  // in one at a time and ignore the "already exists" failure.
  const seasonStatsMigrations = [
    ['loan_team_from', 'INTEGER'],
    ['loan_club_name', 'TEXT'],
    ['loan_date_end', 'TEXT'],
    ['is_loan_to_buy', 'INTEGER DEFAULT 0'],
    ['club_name', 'TEXT'],
    ['traits_json', 'TEXT'],
    ['play_styles_json', 'TEXT'],
    ['overall_delta', 'INTEGER DEFAULT 0'],
    ['attribute_deltas_json', 'TEXT'],
    ['season_start_overall', 'INTEGER'],
    ['season_start_attributes_json', 'TEXT'],
    ['jersey_number', 'INTEGER'],
    ['injury', 'INTEGER DEFAULT 0']
  ];
  seasonStatsMigrations.forEach(([column, type]) => {
    try {
      db.run(`ALTER TABLE player_season_stats ADD COLUMN ${column} ${type};`);
    } catch (e) {
      // column already exists, safe to ignore
    }
  });

  // One-time backfill for rows that predate season_start_overall/
  // season_start_attributes_json (added above) — a season already in
  // progress at the moment of this upgrade has no real "start of season"
  // snapshot to recover, so this treats "right now" as the baseline going
  // forward. Idempotent (only touches rows that still have no baseline),
  // safe to run on every launch.
  try {
    db.run(`
      UPDATE player_season_stats
      SET season_start_overall = overall, season_start_attributes_json = attributes_json
      WHERE season_start_overall IS NULL;
    `);
  } catch (e) {
    console.error('[DB] Failed to backfill season_start_overall/attributes:', e);
  }

  // One-time cleanup for season_competition_results rows already
  // persisted for a preseason/exhibition competition (see
  // isExhibitionCompetitionName below) BEFORE persistSeasonCompetition
  // Results started skipping them — without this, an old sync's rows for
  // "European International Cup" (or a randomized code like "COBJ1924")
  // would keep showing up in Trophies/Team Record forever, since those
  // tables are only ever upserted, never re-derived from scratch. Reads
  // every distinct comp_name and tests each in JS (isExhibitionCompeti
  // tionName covers the pattern-matched codes too, which a plain SQL IN
  // list can't) rather than a single DELETE...IN. Idempotent (a no-op
  // once cleaned), safe to run on every launch.
  try {
    const distinctRes = db.exec(`SELECT DISTINCT comp_name FROM season_competition_results;`);
    const toDelete = (distinctRes.length > 0 ? distinctRes[0].values : [])
      .map(row => row[0])
      .filter(isExhibitionCompetitionName);
    if (toDelete.length > 0) {
      const list = toDelete.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
      db.run(`DELETE FROM season_competition_results WHERE comp_name IN (${list});`);
      console.log('[DB] Cleaned up exhibition competition results:', toDelete);
    }
  } catch (e) {
    console.error('[DB] Failed to clean up exhibition competition results:', e);
  }

  // Multi-save support, added after some users already had a DB on disk —
  // same ignore-already-exists migration pattern as above. The unique
  // index has to be created separately since SQLite can't add a UNIQUE
  // constraint via ALTER TABLE ADD COLUMN.
  try {
    db.run(`ALTER TABLE saves ADD COLUMN save_uid TEXT;`);
  } catch (e) {
    // column already exists, safe to ignore
  }
  try {
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saves_save_uid ON saves(save_uid);`);
  } catch (e) {
    // index already exists, safe to ignore
  }

  // Youth Squad Career Mode, added after some users already had a DB on
  // disk — same ignore-already-exists migration pattern as above.
  try {
    db.run(`ALTER TABLE saves ADD COLUMN youth_mode_enabled INTEGER DEFAULT 0;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // See former_players_cleared_before in schema.sql / clearFormerPlayers
  // below — same ignore-already-exists migration pattern as above.
  try {
    db.run(`ALTER TABLE saves ADD COLUMN former_players_cleared_before DATETIME;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // Added when the flat YOUTH_MODE_OVERALL_MARGIN constant was replaced by
  // a per-tier/per-band margin — existing season_end_reviews rows predate
  // this column and just come back NULL, same ignore-already-exists pattern.
  try {
    db.run(`ALTER TABLE season_end_reviews ADD COLUMN league_average_margin INTEGER;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // League Stats season selector, added after some users already had a DB
  // on disk — same ignore-already-exists migration pattern as above.
  try {
    db.run(`ALTER TABLE seasons ADD COLUMN league_name TEXT;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // End of Season Overview splash, added after some users already had a
  // DB on disk — same ignore-already-exists migration pattern as above.
  try {
    db.run(`ALTER TABLE seasons ADD COLUMN overview_acknowledged INTEGER DEFAULT 0;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // Alternate positions, added after some users already had a DB on disk —
  // same ignore-already-exists migration pattern as above.
  try {
    db.run(`ALTER TABLE players ADD COLUMN alt_positions TEXT;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // Youth Mode potential-reveal tier lock, added after some users already
  // had a DB on disk — same ignore-already-exists migration pattern as
  // above.
  try {
    db.run(`ALTER TABLE players ADD COLUMN youth_reveal_tier INTEGER;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // Final Save Point (see checkSeasonFinalSavePoint) — added after some
  // users already had a DB on disk, same ignore-already-exists migration
  // pattern as above.
  try {
    db.run(`ALTER TABLE seasons ADD COLUMN last_known_date TEXT;`);
  } catch (e) {
    // column already exists, safe to ignore
  }
  try {
    db.run(`ALTER TABLE seasons ADD COLUMN final_save_point_at DATETIME;`);
  } catch (e) {
    // column already exists, safe to ignore
  }
  try {
    db.run(`ALTER TABLE seasons ADD COLUMN final_save_point_overview_json TEXT;`);
  } catch (e) {
    // column already exists, safe to ignore
  }
  try {
    db.run(`ALTER TABLE seasons ADD COLUMN final_reminder_may_shown_at DATETIME;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  // Manual injury-type classification (see player_injury_history in
  // schema.sql), added after some users already had a DB on disk — same
  // ignore-already-exists migration pattern as above.
  try {
    db.run(`ALTER TABLE player_injury_history ADD COLUMN injury_type_id INTEGER;`);
  } catch (e) {
    // column already exists, safe to ignore
  }

  saveDatabaseToDisk();
  console.log('[DB] Schema verified/created (existing data preserved).');
}

function saveDatabaseToDisk() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// ------------------------------------------------------------------
// Save / season resolution
// ------------------------------------------------------------------

// Resolves a save row from Live Editor's GetSaveUID() (a persistent,
// per-career identifier — see export_all.lua). This is what makes
// multi-save support possible: each synced UID gets its own save row,
// so an Arsenal save and a second save with a different team accumulate
// separate histories instead of overwriting each other.
//
// uid can be missing (older exports before this was added, or a
// standalone script that hasn't been updated) — falls back to the
// original single-save behavior so nothing breaks mid-transition.
//
// Migration safety: the first sync after this feature shipped will see
// an existing save row with save_uid IS NULL (the pre-multi-save
// default). That row must be backfilled with the real UID rather than
// creating a second row, or the existing save's history gets orphaned
// under a duplicate.
function getOrCreateSaveByUID(uid, managerName, clubName) {
  // The squad-triggered resolution path (see importFifaData) calls this
  // with no names available yet — must NOT overwrite an already-known
  // manager/club name with generic placeholders in that case, or every
  // squad-only sync would briefly clobber it before the calendar sync
  // (moments later, same F10 run) corrects it back.
  const hasRealNames = !!(managerName || clubName);
  const mgrName = managerName || 'Manager';
  const club = clubName || 'My Club';

  if (!uid) {
    const res = db.exec('SELECT id FROM saves LIMIT 1;');
    if (res.length > 0 && res[0].values.length > 0) return res[0].values[0][0];
    db.run(`INSERT INTO saves (manager_name, club_name) VALUES (?, ?);`, [mgrName, club]);
    return db.exec('SELECT id FROM saves ORDER BY id DESC LIMIT 1;')[0].values[0][0];
  }

  const byUid = db.exec(`SELECT id FROM saves WHERE save_uid = '${uid}' LIMIT 1;`);
  if (byUid.length > 0 && byUid[0].values.length > 0) {
    const id = byUid[0].values[0][0];
    if (hasRealNames) {
      db.run(`UPDATE saves SET manager_name = ?, club_name = ? WHERE id = ?;`, [mgrName, club, id]);
    }
    return id;
  }

  const legacyRes = db.exec(`SELECT id FROM saves WHERE save_uid IS NULL;`);
  const legacyRows = legacyRes.length > 0 ? legacyRes[0].values : [];
  if (legacyRows.length === 1) {
    const id = legacyRows[0][0];
    db.run(`UPDATE saves SET save_uid = ?, manager_name = ?, club_name = ? WHERE id = ?;`, [uid, mgrName, club, id]);
    console.log(`[Save] Backfilled existing save (id ${id}) with UID from Live Editor.`);
    return id;
  }

  db.run(`INSERT INTO saves (save_uid, manager_name, club_name) VALUES (?, ?, ?);`, [uid, mgrName, club]);
  const inserted = db.exec('SELECT id FROM saves ORDER BY id DESC LIMIT 1;')[0].values[0][0];
  console.log(`[Save] New save detected (id ${inserted}, "${club}").`);
  return inserted;
}

// Turns a calendar date into a season label. EA FC seasons run
// roughly July -> June, so anything Jan-Jun belongs to the season
// that started the previous July.
function computeSeasonLabel(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}/${startYear + 1}`;
}

// Per-attribute difference between two attribute snapshots. Only includes
// attributes that actually moved, so the UI can show e.g. "+3 sprint
// speed -4 jumping" without listing every unchanged stat. Cumulative for
// the whole season when called with the season's frozen starting snapshot
// (see season_start_attributes_json / importFifaData below) rather than
// the previous sync's values.
function computeAttributeDeltas(oldAttrs, newAttrs) {
  const deltas = {};
  Object.keys(newAttrs || {}).forEach(key => {
    const oldVal = Number((oldAttrs || {})[key]);
    const newVal = Number(newAttrs[key]);
    if (!isNaN(oldVal) && !isNaN(newVal) && oldVal !== newVal) {
      deltas[key] = newVal - oldVal;
    }
  });
  return deltas;
}

function getOrCreateSeason(saveId, yearLabel) {
  const res = db.exec(
    `SELECT id FROM seasons WHERE save_id = ${saveId} AND year_label = '${yearLabel}';`
  );
  if (res.length > 0 && res[0].values.length > 0) {
    return res[0].values[0][0];
  }

  db.run('UPDATE seasons SET is_current = 0 WHERE save_id = ?;', [saveId]);
  db.run(
    `INSERT INTO seasons (save_id, year_label, is_current) VALUES (?, ?, 1);`,
    [saveId, yearLabel]
  );
  const inserted = db.exec('SELECT id FROM seasons ORDER BY id DESC LIMIT 1;');
  return inserted[0].values[0][0];
}

function refreshLeagueTeamsFromCalendar(calendarPayload) {
  if (!calendarPayload || !Array.isArray(calendarPayload.calendar)) return;

  // Anchor on whichever competition looks like the primary domestic league:
  // the one with the most fixtures (cup competitions have far fewer games).
  const compCounts = {};
  calendarPayload.calendar.forEach(f => {
    if (!f.competition) return;
    compCounts[f.competition] = (compCounts[f.competition] || 0) + 1;
  });

  let primaryLeague = null;
  let maxCount = 0;
  for (const [comp, count] of Object.entries(compCounts)) {
    if (count > maxCount) {
      maxCount = count;
      primaryLeague = comp;
    }
  }

  if (!primaryLeague) return;

  const opponents = calendarPayload.calendar
    .filter(f => f.competition === primaryLeague)
    .map(f => f.opponent)
    .filter(Boolean);

  leagueTeamNames = new Set(opponents);
  if (userClubName) leagueTeamNames.add(userClubName);

  console.log(`[League] Resolved "${primaryLeague}" as primary league with ${leagueTeamNames.size} known clubs.`);
}

// Persists completed fixtures from the calendar export into `matches`,
// tied to the currently-resolved season. The export only ever contains
// the *current* season's fixtures, so this is what makes multi-season
// match history (Manager PPG) possible — INSERT OR IGNORE plus the
// table's UNIQUE key means re-syncing the same season's export never
// duplicates a row.
function importCalendarMatches(calendarPayload) {
  if (!db || !currentSeasonId || !calendarPayload || !Array.isArray(calendarPayload.calendar)) return;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO matches
      (season_id, match_date, competition, opponent, is_home, user_score, opponent_score, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `);

  try {
    calendarPayload.calendar.forEach(match => {
      if (!match.played || !match.score) return;
      const parts = String(match.score).split('-');
      if (parts.length !== 2) return;

      const homeScore = parseInt(parts[0].trim(), 10);
      const awayScore = parseInt(parts[1].trim(), 10);
      if (isNaN(homeScore) || isNaN(awayScore)) return;

      const userScore = match.is_home ? homeScore : awayScore;
      const opponentScore = match.is_home ? awayScore : homeScore;
      const result = userScore > opponentScore ? 'W' : (userScore === opponentScore ? 'D' : 'L');

      stmt.run([
        currentSeasonId,
        match.date || '',
        match.competition || '',
        match.opponent || '',
        match.is_home ? 1 : 0,
        userScore,
        opponentScore,
        result
      ]);
    });
  } finally {
    stmt.free();
  }

  saveDatabaseToDisk();
}

// Preseason/exhibition competitions that are real enough to show up in
// EA's competitions data but aren't real competitions the club actually
// competed in — never worth a "place finished" or a trophy. Unlike
// "World's Game" (filtered client-side in index.html, fully excluded
// from a player's stats too), these should still count toward a
// player's own goals/assists/appearances — see bucketExhibitionCompetitions
// in index.html — just never appear as club-level records. Keep this in
// sync with index.html's copy of the same lists/function.
//
// "COBk1924" turned out to be "COBJ1924" in a later sync — EA generates
// this one with a varying single letter, not a fixed string, so it's
// matched by pattern (COB + one letter + digits) instead of an exact
// name. Add new one-off real names to EXHIBITION_COMPETITION_NAMES; add
// new randomized-code FORMATS to EXHIBITION_COMPETITION_PATTERNS.
const EXHIBITION_COMPETITION_NAMES = new Set([
  'European International Cup'
]);
const EXHIBITION_COMPETITION_PATTERNS = [
  /^COB[A-Za-z]\d+$/
];
function isExhibitionCompetitionName(name) {
  if (!name) return false;
  return EXHIBITION_COMPETITION_NAMES.has(name) || EXHIBITION_COMPETITION_PATTERNS.some(p => p.test(name));
}

// Persists each competition's current standing/progress (from the
// calendar export's "competitions" array — see export_all.lua) into
// season_competition_results, upserted per (season, comp_name). Same
// call sites as importCalendarMatches — this is what lets Team Record
// show "place finished" per competition for past seasons, not just the
// currently-loaded one.
function persistSeasonCompetitionResults(calendarPayload) {
  if (!db || !currentSeasonId || !calendarPayload || !Array.isArray(calendarPayload.competitions)) return;

  const stmt = db.prepare(`
    INSERT INTO season_competition_results (season_id, comp_name, standing, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(season_id, comp_name) DO UPDATE SET
      standing = excluded.standing,
      updated_at = CURRENT_TIMESTAMP;
  `);

  try {
    calendarPayload.competitions.forEach(comp => {
      if (!comp.name || isExhibitionCompetitionName(comp.name)) return;
      stmt.run([currentSeasonId, comp.name, comp.standing || '']);
    });
  } finally {
    stmt.free();
  }

  saveDatabaseToDisk();
}

// Persists every team's row in the calendar export's "standings" array
// into season_standings, upserted per (season, team) — same continuous-
// accumulation pattern as season_league_stats, so a season's full table
// is already captured by the time it ends. Raw payload fields are
// gf/ga (not goals_for/goals_against) — see processIncomingCalendar in
// index.html for the same raw shape.
function persistSeasonStandings(seasonId, standingsArray) {
  if (!db || !seasonId || !Array.isArray(standingsArray) || standingsArray.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO season_standings (season_id, team_id, team_name, played, wins, draws, losses, goals_for, goals_against, points, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(season_id, team_id) DO UPDATE SET
      team_name = excluded.team_name,
      played = excluded.played,
      wins = excluded.wins,
      draws = excluded.draws,
      losses = excluded.losses,
      goals_for = excluded.goals_for,
      goals_against = excluded.goals_against,
      points = excluded.points,
      updated_at = CURRENT_TIMESTAMP;
  `);
  try {
    standingsArray.forEach(t => {
      if (t.team_id === undefined || t.team_id === null) return;
      stmt.run([seasonId, t.team_id, t.team_name || '', t.played || 0, t.wins || 0, t.draws || 0, t.losses || 0, t.gf || 0, t.ga || 0, t.points || 0]);
    });
  } finally {
    stmt.free();
  }
  saveDatabaseToDisk();
}

// Every team's row for a season, ranked by points/GD/GF (the standard
// league tiebreaker order) — rank is computed here rather than stored,
// since it shifts as more fixtures complete within the season.
function getSeasonStandings(seasonId) {
  if (!db || !seasonId) return [];
  const res = db.exec(`
    SELECT team_id, team_name, played, wins, draws, losses, goals_for, goals_against, points
    FROM season_standings WHERE season_id = ${seasonId};
  `);
  if (res.length === 0) return [];
  const rows = res[0].values.map(([team_id, team_name, played, wins, draws, losses, goals_for, goals_against, points]) =>
    ({ team_id, team_name, played, wins, draws, losses, goals_for, goals_against, points }));
  rows.sort((a, b) => (b.points - a.points) || ((b.goals_for - b.goals_against) - (a.goals_for - a.goals_against)) || (b.goals_for - a.goals_for));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// Persists the league-wide (not just our own squad) per-player stats
// from a league-stats sync (see export_all.lua's LEAGUE STATS EXPORT)
// into season_league_stats, upserted per (season, player) — same
// continuous-accumulation pattern as player_season_stats, so a season's
// leaderboard is already fully captured by the time it ends rather than
// needing a separate snapshot exactly at the rollover moment (which could
// race against — or miss — the actual season change, same staleness risk
// noted on latestLeagueStatsPayload above). Also keeps seasons.league_name
// current for whichever season is still being written to, since a save
// can change league across seasons via promotion/relegation.
// The league-stats file is watched independently from the calendar file
// (see the chokidar watcher below), so right at a season rollover the two
// can be picked up in either order — persistLeagueStats used to just
// trust whatever currentSeasonId happened to be globally at that instant,
// which could silently attribute an ending season's league name/stats to
// the new season's row (or vice versa) depending on which file's watcher
// event fired first. Same fix already applied to importFifaData (see its
// "FIXED 2026-08-27" comment): resolve fresh from this payload's OWN
// save_uid/current_date (added to export_all.lua's LEAGUE STATS EXPORT
// block alongside this) instead. Falls back to the old currentSeasonId
// behavior when current_date isn't present yet — an export written before
// that Lua change shipped — so this doesn't regress anyone mid-update.
function resolveLeagueStatsSeasonId(leagueStatsPayload) {
  if (leagueStatsPayload && leagueStatsPayload.save_uid && leagueStatsPayload.current_date) {
    return resolveActiveSave(leagueStatsPayload.save_uid, null, null, leagueStatsPayload.current_date)
      ? currentSeasonId
      : null; // blank uid while a different save is active — skip, matches importFifaData's guard
  }
  return currentSeasonId;
}

// Keeps seasons.league_name authoritative and self-healing: derived from
// season_competition_results via getSeasonPrimaryLeagueResult (which
// already prefers a real result over a "Not Started" placeholder — see
// its own comment) instead of trusted directly from whatever competition
// the league-stats export's memory read currently considers "primary".
// That memory read can flip to next season's league before the season
// actually rolls over (a promoted/relegated club sees its new league's
// fixtures appear during the close season), which was overwriting an
// about-to-end season's league_name with the WRONG, not-yet-started
// league. Called after every calendar AND league-stats sync (see both
// below) so whichever runs last always leaves the correct value,
// regardless of which file's watcher fires first.
function syncSeasonLeagueNameFromResults(seasonId) {
  if (!db || !seasonId) return;
  const leagueResult = getSeasonPrimaryLeagueResult(seasonId);
  if (leagueResult) {
    db.run('UPDATE seasons SET league_name = ? WHERE id = ?;', [leagueResult.comp_name, seasonId]);
  }
}

// Re-derives EVERY season's league_name from its own season_competition_results
// on every app launch — a self-healing pass, not just a one-time repair.
// Without this, a season's league_name can only ever get corrected by a
// LIVE sync targeting that exact season; once a season ends and stops
// being synced, a bad value from the race described on
// syncSeasonLeagueNameFromResults would be stuck forever (and worse, an
// in-memory session that loaded the bad value before a fix landed on disk
// can silently flush it right back on its next unrelated write, undoing
// a manual correction). Running this against every season at startup
// means the correct value gets re-asserted every time, regardless of
// what any stale prior session left behind.
function backfillSeasonLeagueNames() {
  if (!db) return;
  const res = db.exec('SELECT id FROM seasons;');
  if (res.length === 0) return;
  res[0].values.forEach(([seasonId]) => syncSeasonLeagueNameFromResults(seasonId));
  saveDatabaseToDisk();
}

function persistLeagueStats(seasonId, leagueStatsPayload) {
  if (!db || !seasonId || !leagueStatsPayload || !Array.isArray(leagueStatsPayload.players)) return;

  // season_competition_results (populated by the calendar sync) is the
  // authoritative source once it has anything for this season — only
  // fall back to this payload's own league_name before that's happened
  // yet (e.g. a squad/league-stats sync that beat the first calendar
  // sync), and even then syncSeasonLeagueNameFromResults will correct it
  // as soon as calendar data arrives.
  if (!getSeasonPrimaryLeagueResult(seasonId) && leagueStatsPayload.league_name) {
    db.run('UPDATE seasons SET league_name = ? WHERE id = ?;', [leagueStatsPayload.league_name, seasonId]);
  } else {
    syncSeasonLeagueNameFromResults(seasonId);
  }

  const stmt = db.prepare(`
    INSERT INTO season_league_stats
      (season_id, player_id, name, team_name, overall, position_id, dob, appearances, goals, assists, clean_sheets, yellow_cards, red_cards, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(season_id, player_id) DO UPDATE SET
      name = excluded.name,
      team_name = excluded.team_name,
      overall = excluded.overall,
      position_id = excluded.position_id,
      dob = excluded.dob,
      appearances = excluded.appearances,
      goals = excluded.goals,
      assists = excluded.assists,
      clean_sheets = excluded.clean_sheets,
      yellow_cards = excluded.yellow_cards,
      red_cards = excluded.red_cards,
      updated_at = CURRENT_TIMESTAMP;
  `);

  try {
    leagueStatsPayload.players.forEach(p => {
      if (!p.player_id) return;
      stmt.run([
        seasonId, p.player_id, p.name || 'Unknown', p.team_name || '', p.overall || 0,
        p.position_id || 0, p.dob || '', p.appearances || 0, p.goals || 0, p.assists || 0,
        p.clean_sheets || 0, p.yellow_cards || 0, p.red_cards || 0
      ]);
    });
  } finally {
    stmt.free();
  }

  saveDatabaseToDisk();
}

// The league-wide leaderboard for one specific past (or current) season,
// for the League Stats tab's season selector — same row shape as the
// live league-stats-updated push, so the renderer can use one rendering
// path for both. Returns the season's league_name alongside the rows
// since a save can change league across seasons.
function getLeagueStatsForSeason(seasonId) {
  if (!db || !seasonId) return { league_name: null, players: [] };

  const seasonRes = db.exec(`SELECT league_name FROM seasons WHERE id = ${seasonId};`);
  const leagueName = (seasonRes.length > 0 && seasonRes[0].values.length > 0) ? seasonRes[0].values[0][0] : null;

  const res = db.exec(`
    SELECT player_id, name, team_name, overall, position_id, dob, appearances, goals, assists, clean_sheets, yellow_cards, red_cards
    FROM season_league_stats
    WHERE season_id = ${seasonId};
  `);
  const rows = res.length > 0 ? res[0].values : [];
  const players = rows.map(r => ({
    player_id: r[0], name: r[1], team_name: r[2], overall: r[3], position_id: r[4], dob: r[5],
    appearances: r[6], goals: r[7], assists: r[8], clean_sheets: r[9], yellow_cards: r[10], red_cards: r[11]
  }));

  return { league_name: leagueName, players };
}

// Per-season competition results (see persistSeasonCompetitionResults),
// for Team Record's "place finished" breakdown. seasonId is a specific
// season row (from getSeasonsList/getTeamRecordSeasons), not a save id
// — the caller already knows which season it wants to see.
function getSeasonCompetitionResults(seasonId) {
  if (!db || !seasonId) return [];
  const res = db.exec(`
    SELECT comp_name, standing FROM season_competition_results WHERE season_id = ${seasonId} ORDER BY comp_name ASC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({ comp_name: row[0], standing: row[1] }));
}

// ------------------------------------------------------------------
// End of Season Overview — the season-boundary splash screen
// ------------------------------------------------------------------
//
// Everything below is computed fresh from already-persisted tables
// (season_competition_results, player_season_stats, season_league_stats,
// matches) rather than snapshotted once at rollover — a past season's
// overview can always be regenerated on demand (see getSeasonOverview
// and the Preview button in index.html), and there's no risk of racing
// the exact rollover moment the way a point-in-time snapshot would.

// Whichever competition recorded for this season matches the English
// pyramid — same lookup used for Youth Squad Career Mode.
function getSeasonPrimaryLeagueResult(seasonId) {
  const compRes = db.exec(`SELECT comp_name, standing FROM season_competition_results WHERE season_id = ${seasonId};`);
  const compRows = compRes.length > 0 ? compRes[0].values : [];
  // A promotion/relegation can register BOTH the league actually being
  // played AND the incoming season's not-yet-started league under the
  // SAME season_id before rollover happens — the game's calendar starts
  // surfacing next season's fixtures/table early, and persistSeasonCompetitionResults
  // just writes whatever it's handed into whichever season is still
  // current. Row order here isn't guaranteed, so picking the first
  // tier-matching row could pick the "Not Started" placeholder for next
  // season instead of the real, finished result for the one actually
  // being reported on — prefer any tier match with a real standing.
  let notStartedFallback = null;
  for (const [comp_name, standing] of compRows) {
    const tier = findPyramidTierServer(comp_name);
    if (!tier) continue;
    if (standing !== 'Not Started') return { comp_name, standing, tier: tier.tier, tier_name: tier.name };
    if (!notStartedFallback) notStartedFallback = { comp_name, standing, tier: tier.tier, tier_name: tier.name };
  }
  return notStartedFallback;
}

function getSeasonTransfersForSeason(saveId, seasonId, yearLabel) {
  const signed = getSignedPlayers(saveId).filter(p => p.signed_season === yearLabel);
  const sold = getPastPlayers(saveId).filter(p => p.departed_season === yearLabel);

  // club_name (NOT loan_club_name — that's the player's parent/contract
  // club, correct for detecting a loan-in/loan-return in
  // getInferredTransfers below, but wrong here) is the real loan
  // DESTINATION for an on_loan=1 row — see the SQUAD EXPORT block's
  // loaned_out_destination resolution in export_all.lua.
  const loanRes = db.exec(`
    SELECT s.player_id, p.name, p.position_id, s.overall, s.club_name, s.loan_date_end
    FROM player_season_stats s
    JOIN players p ON p.player_id = s.player_id
    WHERE s.season_id = ${seasonId} AND s.on_loan = 1;
  `);
  const loaned = loanRes.length > 0 ? loanRes[0].values.map(
    ([player_id, name, position_id, overall, club_name, loan_date_end]) =>
      ({ player_id, name, position_id, overall, club_name, loan_date_end })
  ) : [];

  return { signed, sold, loaned };
}

// Every player_id currently under contract to the save's club — touched
// by the latest squad sync (whether out on loan or not). Shared by
// getSeasonPlayerProgression to keep a season review's highlights to
// players still actually with the club, not ones who've since departed.
//
// on_loan is NOT trusted on its own: a currently-active loan is
// re-detected from live game state every export cycle, so it's refreshed
// (fresh updated_at) right alongside everyone else. Only a player who's
// stopped being exported entirely — recalled and then released/sold
// before an in-between sync ever captured them back at the club — would
// have a stale row, and staleness alone must mean "no longer ours",
// regardless of what on_loan last said.
function getCurrentActivePlayerIds(saveId) {
  const currentSeasonForSave = getCurrentSeasonForSave(saveId);
  if (!currentSeasonForSave) return new Set();
  const res = db.exec(`SELECT player_id, on_loan, updated_at FROM player_season_stats WHERE season_id = ${currentSeasonForSave};`);
  const rows = res.length > 0 ? res[0].values : [];
  let maxUpdatedAt = null;
  rows.forEach(([, , updated_at]) => { if (updated_at && (!maxUpdatedAt || updated_at > maxUpdatedAt)) maxUpdatedAt = updated_at; });
  const ids = new Set();
  rows.forEach(([player_id, , updated_at]) => {
    if (!maxUpdatedAt || !updated_at || updated_at === maxUpdatedAt) ids.add(player_id);
  });
  return ids;
}

// Highest/lowest rated, biggest growth/regression, highest/lowest
// potential — growth is this season's overall minus the immediately
// preceding season's, null (excluded from the growth lists) for anyone
// with no prior-season row to compare against (their first season).
// Scoped to players still currently on the books — a departed player's
// growth isn't relevant to "at a glance" for a squad you no longer have.
function getSeasonPlayerProgression(saveId, seasonId) {
  const activeIds = getCurrentActivePlayerIds(saveId);
  const curRes = db.exec(`
    SELECT s.player_id, p.name, s.overall, s.potential
    FROM player_season_stats s JOIN players p ON p.player_id = s.player_id
    WHERE s.season_id = ${seasonId};
  `);
  const curRows = curRes.length > 0 ? curRes[0].values.filter(([player_id]) => activeIds.has(player_id)) : [];
  if (curRows.length === 0) return null;

  // Skips past any untracked season (see EARLIEST_TRACKED_SEASON_YEAR) —
  // if the season right before this one predates tracking, there's no
  // valid "previous" to compare against, same as if this were the save's
  // first season ever.
  const prevSeasonRes = db.exec(`SELECT id, year_label FROM seasons WHERE save_id = ${saveId} AND id < ${seasonId} ORDER BY id DESC;`);
  const prevSeasonRow = prevSeasonRes.length > 0 ? prevSeasonRes[0].values[0] : null;
  const prevSeasonId = (prevSeasonRow && isSeasonYearLabelTracked(prevSeasonRow[1])) ? prevSeasonRow[0] : null;

  const prevOverallByPlayer = new Map();
  if (prevSeasonId) {
    const prevRes = db.exec(`SELECT player_id, overall FROM player_season_stats WHERE season_id = ${prevSeasonId};`);
    if (prevRes.length > 0) prevRes[0].values.forEach(([pid, ovr]) => prevOverallByPlayer.set(pid, ovr));
  }

  const players = curRows.map(([player_id, name, overall, potential]) => {
    const prevOverall = prevOverallByPlayer.get(player_id);
    const growth = (prevOverall !== undefined) ? overall - prevOverall : null;
    return { player_id, name, overall, potential, growth };
  });

  const withGrowth = players.filter(p => p.growth !== null);
  const byDesc = field => [...players].sort((a, b) => b[field] - a[field]).slice(0, 5);
  const byAsc = field => [...players].sort((a, b) => a[field] - b[field]).slice(0, 5);

  return {
    highest_rated: byDesc('overall'),
    lowest_rated: byAsc('overall'),
    highest_potential: byDesc('potential'),
    lowest_potential: byAsc('potential'),
    biggest_growth: [...withGrowth].sort((a, b) => b.growth - a.growth).slice(0, 5),
    biggest_regression: [...withGrowth].sort((a, b) => a.growth - b.growth).slice(0, 5)
  };
}

// Each currently-active squad player's overall across every season with
// the club up to and including this one — feeds the progression page's
// line chart. Scoped to players still actually on the books now (not
// everyone who's ever passed through, and not anyone since departed).
function getSquadProgressionHistory(saveId, seasonId) {
  const activeIds = Array.from(getCurrentActivePlayerIds(saveId));
  if (activeIds.length === 0) return [];

  const res = db.exec(`
    SELECT s.player_id, p.name, se.year_label, s.overall
    FROM player_season_stats s
    JOIN players p ON p.player_id = s.player_id
    JOIN seasons se ON se.id = s.season_id
    WHERE se.save_id = ${saveId} AND s.player_id IN (${activeIds.join(',')}) AND se.id <= ${seasonId}
    ORDER BY se.id ASC;
  `);
  const byPlayer = new Map();
  if (res.length > 0) {
    res[0].values.forEach(([player_id, name, year_label, overall]) => {
      if (!isSeasonYearLabelTracked(year_label)) return; // see EARLIEST_TRACKED_SEASON_YEAR
      if (!byPlayer.has(player_id)) byPlayer.set(player_id, { player_id, name, points: [] });
      byPlayer.get(player_id).points.push({ year_label, overall });
    });
  }
  return Array.from(byPlayer.values());
}

function seasonTopN(seasonId, field, limit) {
  const res = db.exec(`
    SELECT p.player_id, p.name, s.overall, s.${field}
    FROM player_season_stats s JOIN players p ON p.player_id = s.player_id
    WHERE s.season_id = ${seasonId} AND s.${field} > 0
    ORDER BY s.${field} DESC LIMIT ${limit};
  `);
  if (res.length === 0) return [];
  return res[0].values.map(([player_id, name, overall, value]) => ({ player_id, name, overall, value }));
}

function seasonLeagueTopN(seasonId, field, limit) {
  const res = db.exec(`
    SELECT player_id, name, team_name, ${field}
    FROM season_league_stats
    WHERE season_id = ${seasonId} AND ${field} > 0
    ORDER BY ${field} DESC LIMIT ${limit};
  `);
  if (res.length === 0) return [];
  return res[0].values.map(([player_id, name, team_name, value]) => ({ player_id, name, team_name, value }));
}

// The full aggregate payload for one season's End of Season Overview —
// everything every page of the splash needs, in one round trip.
function getSeasonOverview(saveId, seasonId) {
  if (!db || !saveId || !seasonId) return null;

  const seasonRes = db.exec(`SELECT year_label FROM seasons WHERE id = ${seasonId} AND save_id = ${saveId};`);
  if (seasonRes.length === 0 || seasonRes[0].values.length === 0) return null;
  const yearLabel = seasonRes[0].values[0][0];

  const saveRes = db.exec(`SELECT club_name FROM saves WHERE id = ${saveId};`);
  const clubName = (saveRes.length > 0 && saveRes[0].values.length > 0 && saveRes[0].values[0][0]) ? saveRes[0].values[0][0] : 'My Club';

  const leagueResult = getSeasonPrimaryLeagueResult(seasonId);
  const leaguePosition = leagueResult ? parseStandingPositionServer(leagueResult.standing) : null;
  const wonLeague = !!leagueResult && leagueResult.standing === 'Winner';

  // Relegation still needs the season that directly followed this one —
  // only known once THAT season has recorded a recognized-league result
  // of its own, which may not be true yet immediately after rollover
  // (hence "unknown"/false is a valid, honest outcome here). Promotion,
  // unlike relegation, doesn't need to wait for that: see
  // getPromotionStatusFromOwnResults below, which reads this season's own
  // final position/play-off result directly — that's what lets the
  // Season Summary be generated and shown BEFORE the in-game rollover
  // even happens (the "final save point" flow — see checkFinalSavePoint).
  let relegated = false;
  if (leagueResult) {
    const nextSeasonRes = db.exec(`SELECT id FROM seasons WHERE save_id = ${saveId} AND id > ${seasonId} ORDER BY id ASC LIMIT 1;`);
    if (nextSeasonRes.length > 0 && nextSeasonRes[0].values.length > 0) {
      const nextResult = getSeasonPrimaryLeagueResult(nextSeasonRes[0].values[0][0]);
      if (nextResult) {
        relegated = nextResult.tier > leagueResult.tier;
      }
    }
  }
  const { promoted, viaPlayoff: promotedViaPlayoff } = getPromotionStatusFromOwnResults(seasonId, leagueResult);

  const leagueHistoryRes = db.exec(`
    SELECT r.comp_name, r.standing, se.year_label, se.id
    FROM season_competition_results r JOIN seasons se ON se.id = r.season_id
    WHERE se.save_id = ${saveId} ORDER BY se.id ASC;
  `);
  const leagueHistory = [];
  if (leagueHistoryRes.length > 0) {
    leagueHistoryRes[0].values.forEach(([comp_name, standing, year_label, sid]) => {
      if (!isSeasonYearLabelTracked(year_label)) return; // see EARLIEST_TRACKED_SEASON_YEAR
      const tier = findPyramidTierServer(comp_name);
      if (tier) leagueHistory.push({ season_id: sid, year_label, tier: tier.tier, tier_name: tier.name, position: parseStandingPositionServer(standing) });
    });
  }

  const recordRes = db.exec(`
    SELECT COUNT(*), SUM(CASE WHEN result='W' THEN 1 ELSE 0 END), SUM(CASE WHEN result='D' THEN 1 ELSE 0 END),
           SUM(CASE WHEN result='L' THEN 1 ELSE 0 END), SUM(user_score), SUM(opponent_score)
    FROM matches WHERE season_id = ${seasonId};
  `);
  let teamRecord = null;
  if (recordRes.length > 0 && recordRes[0].values.length > 0 && recordRes[0].values[0][0] > 0) {
    const [played, wins, draws, losses, gf, ga] = recordRes[0].values[0];
    teamRecord = { played, wins: wins || 0, draws: draws || 0, losses: losses || 0, goals_for: gf || 0, goals_against: ga || 0 };
  }

  // Same shape as teamRecord above but filtered to just the primary
  // league's fixtures (matches.competition), plus points — for showing
  // "how did we do IN THE LEAGUE specifically" next to the position,
  // separate from the all-competitions record.
  let leagueRecord = null;
  if (leagueResult) {
    const escapedCompName = leagueResult.comp_name.replace(/'/g, "''");
    const leagueRecordRes = db.exec(`
      SELECT COUNT(*), SUM(CASE WHEN result='W' THEN 1 ELSE 0 END), SUM(CASE WHEN result='D' THEN 1 ELSE 0 END),
             SUM(CASE WHEN result='L' THEN 1 ELSE 0 END), SUM(user_score), SUM(opponent_score)
      FROM matches WHERE season_id = ${seasonId} AND competition = '${escapedCompName}';
    `);
    if (leagueRecordRes.length > 0 && leagueRecordRes[0].values.length > 0 && leagueRecordRes[0].values[0][0] > 0) {
      const [played, wins, draws, losses, gf, ga] = leagueRecordRes[0].values[0];
      const w = wins || 0, dr = draws || 0;
      leagueRecord = { played, wins: w, draws: dr, losses: losses || 0, goals_for: gf || 0, goals_against: ga || 0, points: (w * 3) + dr };
    }
  }

  // Biggest win/loss by goal margin — ties keep whichever match was
  // found first (no meaningful secondary sort for a tie here).
  let biggestWin = null, biggestLoss = null;
  const marginRes = db.exec(`
    SELECT opponent, competition, match_date, user_score, opponent_score
    FROM matches WHERE season_id = ${seasonId};
  `);
  if (marginRes.length > 0) {
    marginRes[0].values.forEach(([opponent, competition, match_date, user_score, opponent_score]) => {
      const margin = user_score - opponent_score;
      const entry = { opponent, competition, match_date, user_score, opponent_score, margin };
      if (margin > 0 && (!biggestWin || margin > biggestWin.margin)) biggestWin = entry;
      if (margin < 0 && (!biggestLoss || margin < biggestLoss.margin)) biggestLoss = entry;
    });
  }

  const allCompsRes = db.exec(`SELECT comp_name, standing FROM season_competition_results WHERE season_id = ${seasonId};`);
  const otherCompetitions = [];
  const wonCompetitions = wonLeague ? [leagueResult.comp_name] : [];
  if (allCompsRes.length > 0) {
    allCompsRes[0].values.forEach(([comp_name, standing]) => {
      if (leagueResult && comp_name === leagueResult.comp_name) return; // shown separately
      otherCompetitions.push({ comp_name, standing });
      if (standing === 'Winner') wonCompetitions.push(comp_name);
    });
  }

  return {
    save_id: saveId,
    season_id: seasonId,
    year_label: yearLabel,
    club_name: clubName,
    league: leagueResult ? {
      comp_name: leagueResult.comp_name,
      standing_text: leagueResult.standing,
      position: leaguePosition,
      won: wonLeague,
      relegated,
      promoted,
      promoted_via_playoff: promotedViaPlayoff
    } : null,
    league_history: leagueHistory,
    standings: getSeasonStandings(seasonId),
    team_record: teamRecord,
    league_record: leagueRecord,
    biggest_win: biggestWin,
    biggest_loss: biggestLoss,
    other_competitions: otherCompetitions,
    won_competitions: wonCompetitions,
    squad_leaders: {
      goals: seasonTopN(seasonId, 'goals', 5),
      assists: seasonTopN(seasonId, 'assists', 5),
      appearances: seasonTopN(seasonId, 'appearances', 5),
      clean_sheets: seasonTopN(seasonId, 'clean_sheets', 5),
      yellow_cards: seasonTopN(seasonId, 'yellow_cards', 5),
      red_cards: seasonTopN(seasonId, 'red_cards', 5)
    },
    league_leaders: {
      goals: seasonLeagueTopN(seasonId, 'goals', 5),
      assists: seasonLeagueTopN(seasonId, 'assists', 5),
      appearances: seasonLeagueTopN(seasonId, 'appearances', 5),
      clean_sheets: seasonLeagueTopN(seasonId, 'clean_sheets', 5),
      yellow_cards: seasonLeagueTopN(seasonId, 'yellow_cards', 5),
      red_cards: seasonLeagueTopN(seasonId, 'red_cards', 5)
    },
    transfers: getSeasonTransfersForSeason(saveId, seasonId, yearLabel),
    progression: getSeasonPlayerProgression(saveId, seasonId),
    progression_history: getSquadProgressionHistory(saveId, seasonId)
  };
}

// The most recent ended season (is_current = 0) that hasn't had its
// overview acknowledged yet — null once every ended season has been
// seen, or if this save has never had a season actually end.
// The user's save has a stray/incomplete 2024/2025 season on record from
// before season-scoped tracking (League Stats history, End of Season
// Overview) was fully built out — rather than deleting that history
// outright, these newer features just don't consider any season before
// this one. Not a deletion: player_season_stats/matches/etc. for that
// season are untouched, only these two entry points skip past it.
const EARLIEST_TRACKED_SEASON_YEAR = 2025;

function isSeasonYearLabelTracked(yearLabel) {
  const year = parseInt(String(yearLabel || '').split('/')[0], 10);
  return !isNaN(year) && year >= EARLIEST_TRACKED_SEASON_YEAR;
}

function getPendingSeasonOverview(saveId = activeSaveId) {
  if (!db || !saveId) return null;
  const res = db.exec(`
    SELECT id, year_label FROM seasons
    WHERE save_id = ${saveId} AND is_current = 0 AND overview_acknowledged = 0
    ORDER BY id DESC;
  `);
  if (res.length > 0) {
    const row = res[0].values.find(([, year_label]) => isSeasonYearLabelTracked(year_label));
    if (row) return getSeasonOverview(saveId, row[0]);
  }

  // Final Save Point: the CURRENT season's own Season Summary, frozen
  // early — before the in-game rollover — once checkFinalSavePoint below
  // confirms the season's data is complete. Surfaced through this same
  // pending-overview flow so it auto-pops the existing splash exactly
  // once, the same way an already-ended season's overview does above;
  // returns the FROZEN snapshot rather than recomputing live, since the
  // whole point of a save point is to lock in data that's known-good
  // right now rather than trust it stays that way through the rollover.
  const currentRes = db.exec(`
    SELECT final_save_point_overview_json FROM seasons
    WHERE save_id = ${saveId} AND is_current = 1 AND overview_acknowledged = 0
      AND final_save_point_overview_json IS NOT NULL;
  `);
  if (currentRes.length > 0 && currentRes[0].values.length > 0) {
    try {
      return JSON.parse(currentRes[0].values[0][0]);
    } catch (e) {
      return null;
    }
  }

  return null;
}

// ------------------------------------------------------------------
// Final Save Point — a one-time-per-season safety net around the end
// of the football season. On or after June 20th, once this season's
// own results show it's genuinely finished (not "Not Started"), its
// Season Summary is computed and frozen (see getPendingSeasonOverview
// above) — this is what protects that data from whatever race/timing
// issue might otherwise corrupt it during the actual in-game rollover
// (see the league-stats season-resolution race this was built after).
// Runs on every calendar sync ("on refresh") — if the season isn't
// finished yet by the 20th, it just silently re-checks on the next
// sync; if it's STILL not locked in by the 29th, getSeasonAlerts below
// starts returning show_final_alert so the UI can nag about it.
// ------------------------------------------------------------------

function parseYMD(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
  return m ? { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) } : null;
}

function seasonEndYear(yearLabel) {
  const parts = String(yearLabel || '').split('/');
  return parts.length === 2 ? parseInt(parts[1], 10) : null;
}

// Last week of May — the softer, dismissible heads-up.
function isInMayReminderWindow(ymd, endYear) {
  return !!ymd && ymd.year === endYear && ymd.month === 5 && ymd.day >= 24;
}

// June 20-29 — the window the final check actively runs in.
function isInFinalCheckWindow(ymd, endYear) {
  return !!ymd && ymd.year === endYear && ymd.month === 6 && ymd.day >= 20 && ymd.day <= 29;
}

// June 29 through July 1 inclusive — the non-dismissible banner window;
// per the user's explicit call, this stays up through July 1st
// regardless of whether the check already completed, only clearing once
// the date moves past it.
function isInFinalAlertWindow(ymd, endYear) {
  if (!ymd || ymd.year !== endYear) return false;
  if (ymd.month === 6) return ymd.day >= 29;
  if (ymd.month === 7) return ymd.day <= 1;
  return false;
}

// Called on every calendar sync for the CURRENT season with that sync's
// own in-game date. Idempotent/cheap to call repeatedly — that's what
// makes "just keep syncing" the retry mechanism, no separate retry loop
// needed.
function checkSeasonFinalSavePoint(saveId, seasonId, currentDateStr) {
  if (!db || !saveId || !seasonId || !currentDateStr) return;

  const seasonRes = db.exec(`SELECT year_label, final_save_point_at FROM seasons WHERE id = ${seasonId};`);
  if (seasonRes.length === 0 || seasonRes[0].values.length === 0) return;
  const [yearLabel, finalSavePointAt] = seasonRes[0].values[0];

  db.run('UPDATE seasons SET last_known_date = ? WHERE id = ?;', [currentDateStr, seasonId]);

  const ymd = parseYMD(currentDateStr);
  const endYear = seasonEndYear(yearLabel);
  if (!ymd || !endYear || finalSavePointAt || !isInFinalCheckWindow(ymd, endYear)) {
    saveDatabaseToDisk();
    return;
  }

  const leagueResult = getSeasonPrimaryLeagueResult(seasonId);
  const seasonComplete = !!leagueResult && leagueResult.standing !== 'Not Started';
  if (seasonComplete) {
    const overview = getSeasonOverview(saveId, seasonId);
    if (overview) {
      db.run(
        'UPDATE seasons SET final_save_point_at = CURRENT_TIMESTAMP, final_save_point_overview_json = ? WHERE id = ?;',
        [JSON.stringify(overview), seasonId]
      );
      console.log(`[Final Save Point] Season ${yearLabel} (id ${seasonId}) locked in.`);
    }
  }
  saveDatabaseToDisk();
}

// Read-only status for the renderer's alert banners — recomputed live
// from last_known_date on every call, so it stays correct across app
// restarts without needing a fresh sync first.
function getSeasonAlerts(saveId = activeSaveId) {
  if (!db || !saveId) return null;
  const seasonId = getCurrentSeasonForSave(saveId);
  if (!seasonId) return null;

  const res = db.exec(`
    SELECT year_label, last_known_date, final_save_point_at, final_reminder_may_shown_at
    FROM seasons WHERE id = ${seasonId};
  `);
  if (res.length === 0 || res[0].values.length === 0) return null;
  const [yearLabel, lastKnownDate, finalSavePointAt, mayReminderShownAt] = res[0].values[0];

  const ymd = parseYMD(lastKnownDate);
  const endYear = seasonEndYear(yearLabel);

  return {
    season_id: seasonId,
    year_label: yearLabel,
    show_may_reminder: !mayReminderShownAt && isInMayReminderWindow(ymd, endYear),
    show_final_alert: isInFinalAlertWindow(ymd, endYear),
    final_save_point_complete: !!finalSavePointAt
  };
}

function dismissMayReminder(saveId, seasonId) {
  if (!db || !saveId || !seasonId) return { success: false };
  db.run('UPDATE seasons SET final_reminder_may_shown_at = CURRENT_TIMESTAMP WHERE id = ? AND save_id = ?;', [seasonId, saveId]);
  saveDatabaseToDisk();
  return { success: true };
}

function acknowledgeSeasonOverview(saveId, seasonId) {
  if (!db || !saveId || !seasonId) return { success: false };
  db.run('UPDATE seasons SET overview_acknowledged = 1 WHERE id = ? AND save_id = ?;', [seasonId, saveId]);
  saveDatabaseToDisk();
  return { success: true };
}

// For the "Preview" test button — the most recent ended season if one
// exists, otherwise the current in-progress season, so there's always
// something to preview even before a save has ever crossed a season
// boundary. Doesn't check/set overview_acknowledged at all.
function getSeasonOverviewPreview(saveId = activeSaveId) {
  if (!db || !saveId) return null;
  const endedRes = db.exec(`SELECT id, year_label FROM seasons WHERE save_id = ${saveId} AND is_current = 0 ORDER BY id DESC;`);
  if (endedRes.length > 0) {
    const row = endedRes[0].values.find(([, year_label]) => isSeasonYearLabelTracked(year_label));
    if (row) return getSeasonOverview(saveId, row[0]);
  }
  const currentSeasonId = getCurrentSeasonForSave(saveId);
  return currentSeasonId ? getSeasonOverview(saveId, currentSeasonId) : null;
}

// Current youth academy roster for a save — see importYouthAcademy.
// potential_low/potential_high are a deliberate range, not the exact
// potential (see export_all.lua's YOUTH ACADEMY EXPORT block for why).
// youth_academy_snapshot rows are never deleted once seen (see
// importYouthAcademy), so a player promoted to the senior squad since
// their last youth export would otherwise still show up here — excluded
// via NOT IN player_season_stats for this season, which is what the
// senior squad view (getSquadFromDB) is built from, so a duplicate
// never appears in both tables at once.
function getYouthAcademy(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const seasonId = getCurrentSeasonForSave(saveId);
  if (!seasonId) return [];

  const res = db.exec(`
    SELECT p.player_id, p.name, p.position_id, p.dob,
           y.overall, y.potential_low, y.potential_high, y.tier, y.months_in_squad
    FROM youth_academy_snapshot y
    JOIN players p ON p.player_id = y.player_id
    WHERE y.season_id = ${seasonId}
      AND y.player_id NOT IN (
        SELECT s.player_id FROM player_season_stats s WHERE s.season_id = ${seasonId}
      )
    ORDER BY y.potential_high DESC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({
    player_id: row[0], name: row[1], position_id: row[2], dob: row[3],
    overall: row[4], potential_low: row[5], potential_high: row[6],
    tier: row[7], months_in_squad: row[8]
  }));
}

// Trophies actually won during this save — a competition result of
// "Winner" in season_competition_results. Cups reach that text once the
// final is won (see export_all.lua's round-progress logic); leagues only
// reach it once every one of the team's scheduled fixtures in that
// competition has been played and they finished 1st — a mid-season "1st"
// (still just the current table position, see export_all.lua's
// round-robin standing_text) never matches this, so a league in progress
// doesn't show up here as already won.
// Distinct from the static historical counts on the "teams" table (see
// currentTrophies client-side) — those have no season attached and
// predate the save; this is what the save has actually achieved.
// Grouped by competition, with the most recent season won as "last_won"
// (rows come back in ascending season order, so the last write per
// competition is always the most recent).
function getTrophiesWon(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`
    SELECT r.comp_name, se.year_label
    FROM season_competition_results r
    JOIN seasons se ON se.id = r.season_id
    WHERE se.save_id = ${saveId} AND r.standing = 'Winner'
    ORDER BY se.id ASC;
  `);
  if (res.length === 0) return [];

  const byComp = new Map();
  res[0].values.forEach(([comp_name, year_label]) => {
    if (!byComp.has(comp_name)) byComp.set(comp_name, { comp_name, count: 0, last_won: null });
    const entry = byComp.get(comp_name);
    entry.count += 1;
    entry.last_won = year_label;
  });

  return Array.from(byComp.values());
}

// Every player_id this save considers an academy graduate: anyone ever
// captured in youth_academy_snapshot, unioned with anyone manually
// flagged via academy_graduate_overrides (the fail-safe for a promotion
// that happened between two exports and was never actually captured
// there). Shared by getInferredTransfers and getSignedPlayers so both
// "Academy Graduate" surfaces agree.
function getAcademyGraduateIds(saveId) {
  const ids = new Set();
  if (!db || !saveId) return ids;
  const academyRes = db.exec(`
    SELECT DISTINCT y.player_id FROM youth_academy_snapshot y
    JOIN seasons se ON se.id = y.season_id
    WHERE se.save_id = ${saveId};
  `);
  if (academyRes.length > 0) academyRes[0].values.forEach(([pid]) => ids.add(pid));

  const overrideRes = db.exec(`SELECT player_id FROM academy_graduate_overrides WHERE save_id = ${saveId};`);
  if (overrideRes.length > 0) overrideRes[0].values.forEach(([pid]) => ids.add(pid));

  return ids;
}

// Manual fail-safe for missed "Academy Graduate" detection — called from
// the player profile page's "Mark as Academy Graduate" button (Youth
// Mode only). See academy_graduate_overrides in schema.sql.
function markAcademyGraduate(playerId, saveId = activeSaveId) {
  if (!db || !saveId || !playerId) return { success: false };
  db.run('INSERT OR IGNORE INTO academy_graduate_overrides (player_id, save_id) VALUES (?, ?);', [playerId, saveId]);
  saveDatabaseToDisk();
  console.log(`[Academy] Player ${playerId} manually marked as academy graduate for save ${saveId}.`);
  return { success: true };
}

// Manually-recorded PlayStyles/PlayStyle+ for a player — see the
// "+ Playstyle" picker on the player profile and player_manual_playstyles
// in schema.sql. Not save-scoped: a player's PlayStyles belong to the
// real player, not to any one save.
function getManualPlayStyles(playerId) {
  if (!db || !playerId) return [];
  const res = db.exec(`SELECT playstyles_json FROM player_manual_playstyles WHERE player_id = ${playerId};`);
  if (res.length === 0 || res[0].values.length === 0) return [];
  try {
    const parsed = JSON.parse(res[0].values[0][0] || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Replaces the whole set in one go (the picker always submits the full
// current selection, not a delta).
function setManualPlayStyles(playerId, styles) {
  if (!db || !playerId) return { success: false };
  const json = JSON.stringify(Array.isArray(styles) ? styles : []);
  db.run(`
    INSERT INTO player_manual_playstyles (player_id, playstyles_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET playstyles_json = excluded.playstyles_json, updated_at = CURRENT_TIMESTAMP;
  `, [playerId, json]);
  saveDatabaseToDisk();
  return { success: true };
}

// The real "transfers" DB table crashes the game when Live Editor's Lua
// API tries to read it (confirmed 2026-08-25 — crashes inside its own
// GetFirstRecord(), before a single field is read; not fixable from a
// script). This infers transfer activity instead from squad-roster
// changes already safely captured season-to-season in player_season_stats
// — no fee or exact date, but real arrivals/departures with zero crash
// risk. Loan in/out and loan-return are distinguished using the on_loan/
// loan_club_name fields already exported per player.
function getInferredTransfers(saveId = activeSaveId) {
  if (!db || !saveId) return { transfers: [] };

  const seasonsRes = db.exec(`SELECT id, year_label FROM seasons WHERE save_id = ${saveId} ORDER BY year_label ASC;`);
  if (seasonsRes.length === 0 || seasonsRes[0].values.length < 2) return { transfers: [] };

  const seasonRows = seasonsRes[0].values;
  const [currentSeasonId, currentLabel] = seasonRows[seasonRows.length - 1];
  const [previousSeasonId, previousLabel] = seasonRows[seasonRows.length - 2];

  function loadSeasonRows(seasonId) {
    const map = new Map();
    const res = db.exec(`
      SELECT p.player_id, p.name, s.club_id, s.club_name, s.on_loan, s.loan_club_name
      FROM player_season_stats s
      JOIN players p ON p.player_id = s.player_id
      WHERE s.season_id = ${seasonId};
    `);
    if (res.length > 0) {
      res[0].values.forEach(([player_id, name, club_id, club_name, on_loan, loan_club_name]) => {
        map.set(player_id, { name, club_id, club_name, on_loan: !!on_loan, loan_club_name });
      });
    }
    return map;
  }

  const currentRows = loadSeasonRows(currentSeasonId);
  const previousRows = loadSeasonRows(previousSeasonId);

  // The user's own team id = whichever club_id shows up on a non-loan row
  // (a player genuinely contracted to the user's club, not a loanee).
  let userTeamId = null;
  for (const info of [...currentRows.values(), ...previousRows.values()]) {
    if (!info.on_loan) { userTeamId = info.club_id; break; }
  }
  if (userTeamId === null) return { transfers: [] };

  const currentActive = new Set([...currentRows.entries()].filter(([, v]) => v.club_id === userTeamId).map(([id]) => id));
  const previousActive = new Set([...previousRows.entries()].filter(([, v]) => v.club_id === userTeamId).map(([id]) => id));

  // Any player_id ever seen in this save's youth academy — a new
  // arrival matching one of these is a promotion, not a real signing.
  // Unioned with academy_graduate_overrides, the manual fail-safe for
  // when a promotion happens between two exports and never gets an
  // actual youth_academy_snapshot row — see markAcademyGraduate.
  const everInAcademy = getAcademyGraduateIds(saveId);

  const results = [];

  currentActive.forEach(id => {
    if (previousActive.has(id)) return;
    const info = currentRows.get(id);
    const isLoanIn = info.on_loan && info.loan_club_name;
    const isAcademyGraduate = everInAcademy.has(id);
    results.push({
      player_name: info.name,
      from_team: isAcademyGraduate ? `${info.club_name} Academy` : (isLoanIn ? info.loan_club_name : 'Unknown Club'),
      to_team: info.club_name,
      fee: 0,
      is_user: true,
      is_league: false,
      is_big_money: false,
      transfer_type: isAcademyGraduate ? 'Academy Graduate' : (isLoanIn ? 'Loan In' : 'Signed')
    });
  });

  previousActive.forEach(id => {
    if (currentActive.has(id)) return;
    const prevInfo = previousRows.get(id);
    const currInfo = currentRows.get(id);

    let toTeam = 'Unknown Club';
    let type = 'Departed';
    if (prevInfo.on_loan && prevInfo.loan_club_name) {
      toTeam = prevInfo.loan_club_name;
      type = 'Loan Return';
    } else if (currInfo && currInfo.club_id !== userTeamId) {
      toTeam = currInfo.club_name;
      type = 'Loan Out';
    }

    results.push({
      player_name: prevInfo.name,
      from_team: prevInfo.club_name,
      to_team: toTeam,
      fee: 0,
      is_user: true,
      is_league: false,
      is_big_money: false,
      transfer_type: type
    });
  });

  return { transfers: results, seasons: { current: currentLabel, previous: previousLabel } };
}

function correctTransferFlags(transferPayload) {
  if (!transferPayload || !Array.isArray(transferPayload.transfers)) return transferPayload;

  // Backfill userClubName by finding whichever club name repeats most often
  // across your transfers — the counterparty varies each time, your own
  // club name doesn't, so it'll be the clear mode.
  if (!userClubName) {
    const userTransfers = transferPayload.transfers.filter(t => t.is_user);
    if (userTransfers.length > 0) {
      const nameCounts = {};
      userTransfers.forEach(t => {
        [t.from_team, t.to_team].forEach(name => {
          if (!name) return;
          nameCounts[name] = (nameCounts[name] || 0) + 1;
        });
      });
      userClubName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0][0];
      leagueTeamNames.add(userClubName);
      console.log(`[League] Detected user club as "${userClubName}" from transfer history.`);
    }
  }

  transferPayload.transfers.forEach(t => {
    t.is_league = leagueTeamNames.has(t.from_team) || leagueTeamNames.has(t.to_team);
  });

  return transferPayload;
}

// Durable counterpart to correctTransferFlags above, which only patches
// flags on the transient in-memory payload pushed to the renderer this
// sync. This persists whatever real fee data the negotiation-manager
// memory read (see export_all.lua) currently has into transfer_fees, so
// the Transfer Hub/Former Players/player profile can show it across saves
// and app restarts, not just for the session that happened to be open
// when the deal was struck. Records without a resolvable player_id are
// skipped (shouldn't happen — see get_transfer_data in export_all.lua —
// but a bad memory read is exactly the failure mode worth guarding here).
function persistTransferFees(saveId, transferPayload) {
  if (!db || !saveId || !transferPayload || !Array.isArray(transferPayload.transfers)) return;
  const stmt = db.prepare(`
    INSERT INTO transfer_fees (save_id, player_id, from_team_id, to_team_id, from_team_name, to_team_name, deal_type, fee, exchange_value, deal_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(save_id, player_id, from_team_id, to_team_id, deal_date) DO UPDATE SET
      from_team_name=excluded.from_team_name,
      to_team_name=excluded.to_team_name,
      deal_type=excluded.deal_type,
      fee=excluded.fee,
      exchange_value=excluded.exchange_value,
      updated_at=CURRENT_TIMESTAMP;
  `);
  transferPayload.transfers.forEach(t => {
    if (!t.player_id) return;
    stmt.run([
      saveId, t.player_id, t.from_team_id || 0, t.to_team_id || 0,
      t.from_team || '', t.to_team || '', t.deal_type || 'transfer',
      t.fee || 0, t.exchange_value || 0, t.date || ''
    ]);
  });
  stmt.free();
  saveDatabaseToDisk();
}

// One row per (player, deal_type): whichever transfer_fees row is most
// recent (by deal_date) for that pairing — NOT collapsed to one row per
// player, since a player can legitimately have both a 'transfer' deal
// (their signing or departure) and a separate 'loan' deal captured in the
// same window, and the player profile's Transfer History wants fee/date
// data for each of those independently, not just whichever happened last
// overall. Loans always come back with fee 0 (see export_all.lua — the
// reference script never extracts a loan fee), so they still show up here
// for deal_type/date but the UI should treat a 0 fee as "not shown".
function getTransferFees(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  // deal_date is stored MM-DD-YYYY (text) — sorts wrong chronologically as
  // a plain string (e.g. "01-31-2026" < "07-06-2025"), same fix as
  // getPlayerTransferHistory's ORDER BY. Went unnoticed until now because
  // every deal_date used to come back blank (see export_all.lua's
  // convertNegotiationDate fix), so this ORDER BY was previously a no-op.
  const res = db.exec(`
    SELECT player_id, from_team_id, to_team_id, from_team_name, to_team_name, deal_type, fee, exchange_value, deal_date
    FROM transfer_fees
    WHERE save_id = ${saveId}
    ORDER BY CASE WHEN deal_date LIKE '__-__-____'
      THEN substr(deal_date,7,4) || substr(deal_date,1,2) || substr(deal_date,4,2)
      ELSE '' END ASC;
  `);
  if (res.length === 0) return [];
  const cols = res[0].columns;
  const latestByPlayerAndType = new Map();
  res[0].values.forEach(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    // later rows (ASC order) overwrite earlier ones for the same key
    latestByPlayerAndType.set(`${obj.player_id}|${obj.deal_type}`, obj);
  });
  return Array.from(latestByPlayerAndType.values());
}

// Full deal-by-deal history for one player, chronological — unlike
// getTransferFees above (which collapses to one row per deal_type), this
// keeps every row. persistTransferFees writes EVERY succeeded deal the
// negotiation-manager memory read finds each sync (see get_transfer_data
// in export_all.lua, which walks AI-AI and AI-user negotiations alike,
// not just ones involving our own club), so a former player's moves
// between OTHER clubs after leaving us are already accumulating here —
// this just surfaces that chain for the player profile's Transfer History
// timeline. deal_date is stored MM-DD-YYYY (text), which sorts wrong
// chronologically as a plain string, so ORDER BY rewrites it to
// YYYYMMDD first.
function getPlayerTransferHistory(playerId, saveId = activeSaveId) {
  if (!db || !saveId || !playerId) return [];
  const res = db.exec(`
    SELECT from_team_id, to_team_id, from_team_name, to_team_name, deal_type, fee, exchange_value, deal_date
    FROM transfer_fees
    WHERE save_id = ${saveId} AND player_id = ${playerId}
    ORDER BY CASE WHEN deal_date LIKE '__-__-____'
      THEN substr(deal_date,7,4) || substr(deal_date,1,2) || substr(deal_date,4,2)
      ELSE '' END ASC;
  `);
  if (res.length === 0) return [];
  const cols = res[0].columns;
  return res[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

// Every injury episode on record for one player in this save, most
// recent first. start_date/end_date are already ISO YYYY-MM-DD (the
// squad export's own current_date — see the injury-transition detection
// in importFifaData), which sorts correctly as a plain string, unlike
// transfer_fees' MM-DD-YYYY deal_date. end_date NULL means still ongoing
// (or never confirmed closed — see player_injury_history in schema.sql).
// injury_type_id is the user's own manual classification (NULL until set
// via setInjuryEpisodeType) — the episode COUNT here is what a future
// "injury prone" label would key off of.
function getPlayerInjuryHistory(playerId, saveId = activeSaveId) {
  if (!db || !saveId || !playerId) return [];
  const res = db.exec(`
    SELECT id, start_date, end_date, injury_type_id
    FROM player_injury_history
    WHERE save_id = ${saveId} AND player_id = ${playerId}
    ORDER BY start_date DESC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(([id, start_date, end_date, injury_type_id]) => ({ id, start_date, end_date, injury_type_id }));
}

// Manual injury-type classification for one episode — see
// player_injury_history in schema.sql and the INJURY_TYPES catalog in
// index.html. Pass null to clear back to "not yet classified".
function setInjuryEpisodeType(episodeId, injuryTypeId) {
  if (!db || !episodeId) return { success: false };
  db.run('UPDATE player_injury_history SET injury_type_id = ? WHERE id = ?;', [injuryTypeId, episodeId]);
  saveDatabaseToDisk();
  return { success: true };
}

// Manual fail-safe for Live Editor's injury boolean not reliably
// resetting to false on a real in-game recovery (confirmed by the user —
// see feedback_injury_tracking_workaround memory) — lets the user close a
// still-open episode by hand from the profile's "Returned to Full
// Fitness" button, locking in a return date so duration can be computed.
// The episode UPDATE's WHERE clause is deliberately AND end_date IS NULL,
// so calling this twice (e.g. a stale button click) can't clobber an
// already-closed episode's real end_date — that also doubles as the
// signal for whether this call is acting on a real open episode, which
// is what gates the injury-flag clear below.
//
// Also clears player_season_stats.injury for the CURRENT season, so the
// visible "INJURED" badge (Squad tab, profile header) reflects the
// confirmed recovery immediately instead of staying stuck. That column is
// still overwritten from Live Editor's raw export on every sync, so if
// the game's own flag really never resets, the badge can reappear on the
// next sync — this only fixes what the app itself is showing right now.
function returnPlayerToFullFitness(episodeId, endDate) {
  if (!db || !episodeId || !endDate) return { success: false };
  const episodeRes = db.exec(`SELECT player_id FROM player_injury_history WHERE id = ${episodeId} AND end_date IS NULL;`);
  if (episodeRes.length === 0 || episodeRes[0].values.length === 0) return { success: false };
  const playerId = episodeRes[0].values[0][0];

  db.run('UPDATE player_injury_history SET end_date = ? WHERE id = ? AND end_date IS NULL;', [endDate, episodeId]);
  if (currentSeasonId) {
    db.run('UPDATE player_season_stats SET injury = 0 WHERE player_id = ? AND season_id = ?;', [playerId, currentSeasonId]);
  }
  saveDatabaseToDisk();
  return { success: true };
}

// Manual fail-safe for the OTHER half of the same Live Editor problem —
// not only does teamplayerlinks.injury not reliably clear on recovery
// (see returnPlayerToFullFitness above), it doesn't reliably flip to
// true in the first place either, so a real in-game injury can simply
// never open an episode for the user to then classify. This is the
// "Mark as Currently Injured" button's handler: opens a brand new
// episode by hand (bypassing the boolean-flip detection in importFifaData
// entirely) so the normal type-picker/Returned-to-Full-Fitness flow has
// something to act on. Refuses if an open episode already exists for
// this player — the existing one should be classified/closed instead of
// creating a duplicate.
function markPlayerCurrentlyInjured(playerId, startDate, injuryTypeId, saveId = activeSaveId) {
  if (!db || !playerId || !startDate || !saveId) return { success: false };

  const openRes = db.exec(`SELECT id FROM player_injury_history WHERE save_id = ${saveId} AND player_id = ${playerId} AND end_date IS NULL;`);
  if (openRes.length > 0 && openRes[0].values.length > 0) return { success: false, error: 'already_open' };

  db.run('INSERT INTO player_injury_history (save_id, player_id, start_date, injury_type_id) VALUES (?, ?, ?, ?);', [saveId, playerId, startDate, injuryTypeId]);
  const idRes = db.exec('SELECT last_insert_rowid();');
  const episodeId = idRes[0].values[0][0];

  // Same badge-sync reasoning as returnPlayerToFullFitness — this only
  // takes effect for the player_season_stats row currently marked as
  // "current" for THIS ACTIVE save, so the visible INJURED badge (Squad
  // tab, profile header) reflects the manual entry immediately.
  if (currentSeasonId) {
    db.run('UPDATE player_season_stats SET injury = 1 WHERE player_id = ? AND season_id = ?;', [playerId, currentSeasonId]);
  }
  saveDatabaseToDisk();
  return { success: true, episode_id: episodeId };
}

// Lets the user remove a bad/duplicate/test injury record entirely from
// the profile's Injury History card — irreversible, gated behind a
// confirm() client-side.
function deleteInjuryEpisode(episodeId) {
  if (!db || !episodeId) return { success: false };
  db.run('DELETE FROM player_injury_history WHERE id = ?;', [episodeId]);
  saveDatabaseToDisk();
  return { success: true };
}

// Full manual edit of an already-recorded episode — the "Edit" button on
// a closed entry in the Injury History card, for fixing dates/type after
// the fact. Unlike returnPlayerToFullFitness (which only ever closes an
// OPEN episode once, guarded by end_date IS NULL), this can freely
// rewrite any episode, since Live Editor's own dates were always just
// "when our polling noticed the change" approximations to begin with.
function updateInjuryEpisode(episodeId, startDate, endDate, injuryTypeId) {
  if (!db || !episodeId || !startDate || !endDate) return { success: false };
  db.run('UPDATE player_injury_history SET start_date = ?, end_date = ?, injury_type_id = ? WHERE id = ?;', [startDate, endDate, injuryTypeId, episodeId]);
  saveDatabaseToDisk();
  return { success: true };
}

// Contract Renewal for the profile's Contract & Financials card: null
// (displayed as "N/A") if contract_expiry has never changed since this
// contract stint began, otherwise the in-game date of the most recent
// change. See player_contract_state in schema.sql and the detection
// logic in importFifaData.
function getPlayerContractRenewal(playerId, saveId = activeSaveId) {
  if (!db || !saveId || !playerId) return { renewal_date: null };
  const res = db.exec(`SELECT last_renewal_date FROM player_contract_state WHERE save_id = ${saveId} AND player_id = ${playerId};`);
  if (res.length === 0 || res[0].values.length === 0) return { renewal_date: null };
  return { renewal_date: res[0].values[0][0] };
}

// ------------------------------------------------------------------
// Youth Squad Career Mode — gameplay balancing
// ------------------------------------------------------------------
//
// Rather than computing a real "average overall" from every rival team's
// roster (which would mean exporting every team in the league's full
// player list via new, unverified Lua table reads — see the "transfers"
// table crash lesson), this uses static, tuned baseline overalls per
// English pyramid tier, the same approach already used for
// YOUTH_POTENTIAL_THRESHOLD_BY_TIER in index.html. Keep these three
// constants and findPyramidTierServer in sync with ENGLAND_PYRAMID /
// findPyramidTier in index.html if the tier names or numbers ever change.
const YOUTH_MODE_PYRAMID_TIERS = [
  { tier: 1, name: 'premier league' },
  { tier: 2, name: 'championship' },
  { tier: 3, name: 'league one' },
  { tier: 4, name: 'league two' }
];

// Lower tiers: flat baseline overall/allowance/margin per tier.
const YOUTH_MODE_TIER_CONFIG = {
  2: { leagueAverage: 72, allowance: 3, margin: 3 }, // Championship
  3: { leagueAverage: 67, allowance: 3, margin: 3 }, // League One
  4: { leagueAverage: 63, allowance: 2, margin: 3 }  // League Two
};

// Premier League scales with table position instead of a flat baseline
// — a mid-table/relegation-threatened squad gets held to a tighter cap
// than a title-chasing top-5 side, which faces no cap at all. Bands
// checked in order; the first whose position <= maxPos applies. Keep in
// sync with index.html's YOUTH_MODE_PREMIER_LEAGUE_BANDS (same bands,
// applied there to the LIVE position instead of this final one).
const YOUTH_MODE_PREMIER_LEAGUE_BANDS = [
  { maxPos: 5, leagueAverage: 80, allowance: Infinity, margin: 0 },
  { maxPos: 8, leagueAverage: 78, allowance: 4, margin: 5 },
  { maxPos: 14, leagueAverage: 76, allowance: 3, margin: 4 },
  { maxPos: Infinity, leagueAverage: 74, allowance: 3, margin: 3 }
];

function getYouthModePremierLeagueBand(position) {
  return YOUTH_MODE_PREMIER_LEAGUE_BANDS.find(b => position <= b.maxPos)
    || YOUTH_MODE_PREMIER_LEAGUE_BANDS[YOUTH_MODE_PREMIER_LEAGUE_BANDS.length - 1];
}

// Resolves the rule to enforce for a tier — Premier League needs a final
// table position to pick a band (null if that couldn't be parsed out of
// the stored standings text), every other tier just uses its flat config.
function getYouthModeTierRule(tier, finalPosition) {
  if (tier === 1) return finalPosition === null ? null : getYouthModePremierLeagueBand(finalPosition);
  return YOUTH_MODE_TIER_CONFIG[tier] || null;
}

function findPyramidTierServer(compName) {
  if (!compName) return null;
  const lname = compName.toLowerCase();
  return YOUTH_MODE_PYRAMID_TIERS.find(t => lname.includes(t.name)) || null;
}

// Parses the leading number out of standings text like "5th" (see
// export_all.lua's ordinal_suffix output) — mirrors parseStandingPosition
// in index.html. A league-winning season stores the literal text "Winner"
// instead of "1st" (see getTrophiesWon), which is still 1st place here.
function parseStandingPositionServer(standingText) {
  if (standingText === 'Winner') return 1;
  const match = /^(\d+)/.exec(standingText || '');
  return match ? parseInt(match[1], 10) : null;
}

// Whether a season counts as "promoted", read directly from that
// season's own recorded results — never needs a later season to exist,
// unlike the tier-comparison approach still used for relegated in
// getSeasonOverview. In the Championship/League One/League Two, only 1st
// and 2nd go up automatically; 3rd-6th enter a play-off and only its
// winner is also promoted — so this checks position first, then falls
// back to a play-off competition result (matched by name — the game
// varies the exact string per tier, e.g. "Lg Two Play-Offs") with
// standing "Winner". The Premier League (tier 1) has nothing above it.
function getPromotionStatusFromOwnResults(seasonId, leagueResult) {
  if (!leagueResult || leagueResult.tier === 1) return { promoted: false, viaPlayoff: false };

  const position = parseStandingPositionServer(leagueResult.standing);
  if (position !== null && position <= 2) return { promoted: true, viaPlayoff: false };

  const playoffRes = db.exec(`
    SELECT standing FROM season_competition_results
    WHERE season_id = ${seasonId}
      AND (LOWER(comp_name) LIKE '%play-off%' OR LOWER(comp_name) LIKE '%play off%' OR LOWER(comp_name) LIKE '%playoff%');
  `);
  const wonPlayoff = playoffRes.length > 0 && playoffRes[0].values.some(([standing]) => standing === 'Winner');
  return { promoted: wonPlayoff, viaPlayoff: wonPlayoff };
}

// Permanently enables Youth Squad Career Mode for a save. One-way by
// design — there is no corresponding disable function or IPC channel.
function enableYouthMode(saveId) {
  if (!db || !saveId) return { success: false };
  db.run('UPDATE saves SET youth_mode_enabled = 1 WHERE id = ?;', [saveId]);
  saveDatabaseToDisk();
  console.log(`[Youth Mode] Enabled for save ${saveId} (permanent).`);
  return { success: true };
}

// Clears the Former Players tab by stamping "now" as this save's cutoff —
// see former_players_cleared_before in schema.sql and getPastPlayers above.
// Used to drop the pre-youth-rebuild squad (players who left before the
// user's academy rebuild started) since they don't count toward it. Only
// affects which past players are shown going forward; nobody's underlying
// player_season_stats history is deleted, so past season stats/leaders are
// unaffected, and anyone who departs after this point still shows up
// normally.
function clearFormerPlayers(saveId) {
  if (!db || !saveId) return { success: false };
  db.run('UPDATE saves SET former_players_cleared_before = CURRENT_TIMESTAMP WHERE id = ?;', [saveId]);
  saveDatabaseToDisk();
  console.log(`[Former Players] Cleared for save ${saveId}.`);
  return { success: true };
}

// Called right when a season boundary is crossed (see resolveActiveSave)
// for a save with Youth Squad Career Mode on. Looks back at the season
// that just ended: identifies its domestic league (whichever recorded
// competition name matches a pyramid tier — cups never do), and flags
// any player still genuinely on the squad (freshest updated_at that
// season, not out on loan — same definition as __clubStatus === 'normal'
// in index.html) whose overall exceeds that tier/band's average by more
// than its margin (see getYouthModeTierRule). Only writes a row if the
// count of such players exceeds what the tier/band allows — nothing to
// review otherwise.
function generateSeasonEndReviewIfNeeded(saveId, endedSeasonId) {
  if (!db) return;

  const enabledRes = db.exec(`SELECT youth_mode_enabled FROM saves WHERE id = ${saveId};`);
  const youthModeEnabled = enabledRes.length > 0 && enabledRes[0].values.length > 0
    && enabledRes[0].values[0][0] === 1;
  if (!youthModeEnabled) return;

  // Same "Not Started" ambiguity as getSeasonPrimaryLeagueResult — a
  // pending promotion/relegation can leave next season's not-yet-started
  // league sitting in this same season's results alongside the real one.
  const compRes = db.exec(`SELECT comp_name, standing FROM season_competition_results WHERE season_id = ${endedSeasonId};`);
  const compRows = compRes.length > 0 ? compRes[0].values : [];
  let leagueName = null;
  let tierInfo = null;
  let standingText = null;
  for (const [name, standing] of compRows) {
    const t = findPyramidTierServer(name);
    if (!t) continue;
    if (standing !== 'Not Started') { leagueName = name; tierInfo = t; standingText = standing; break; }
    if (!tierInfo) { leagueName = name; tierInfo = t; standingText = standing; }
  }
  if (!tierInfo) return; // no recognized league this season — nothing to enforce

  const rule = getYouthModeTierRule(tierInfo.tier, parseStandingPositionServer(standingText));
  if (!rule || rule.allowance === Infinity) return; // no restriction at this tier/position

  const { leagueAverage, allowance, margin } = rule;
  const cutoff = leagueAverage + margin;

  const squadRes = db.exec(`
    SELECT p.player_id, p.name, s.overall, s.updated_at, s.on_loan
    FROM players p JOIN player_season_stats s ON s.player_id = p.player_id
    WHERE s.season_id = ${endedSeasonId};
  `);
  const rows = squadRes.length > 0 ? squadRes[0].values : [];
  if (rows.length === 0) return;

  let maxUpdatedAt = null;
  rows.forEach(r => { if (r[3] && (!maxUpdatedAt || r[3] > maxUpdatedAt)) maxUpdatedAt = r[3]; });

  const overratedPlayers = rows
    .filter(r => r[4] !== 1 && maxUpdatedAt && r[3] >= maxUpdatedAt && r[2] > cutoff)
    .map(r => ({ player_id: r[0], name: r[1], overall: r[2] }))
    .sort((a, b) => b.overall - a.overall);

  if (overratedPlayers.length <= allowance) return; // within limits

  db.run(`
    INSERT INTO season_end_reviews
      (save_id, season_id, league_name, league_tier, league_average_overall, league_average_margin, allowed_overrated_count, overrated_count, overrated_players_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season_id) DO NOTHING;
  `, [saveId, endedSeasonId, leagueName, tierInfo.tier, leagueAverage, margin, allowance, overratedPlayers.length, JSON.stringify(overratedPlayers)]);
  saveDatabaseToDisk();
  console.log(`[Youth Mode] Season-end review for save ${saveId}: ${overratedPlayers.length} players over the ${leagueName} cap (allowed ${allowance}).`);
}

// Individual season-end awards: Golden Boot (league's top scorer),
// Playmaker (top assists), Golden Glove (top clean sheets, goalkeepers
// only) — only recorded if the league-wide leader in that category was
// on OUR OWN squad that season. Uses whatever league-wide stats last
// happened to sync (see latestLeagueStatsPayload) — there's no historical
// per-season snapshot of league-wide stats, so this is a best-effort read
// of "whoever was on top when the season last synced," same as the rest
// of this app's live-only data.
function generateSeasonAwardsIfNeeded(saveId, endedSeasonId) {
  if (!db || !latestLeagueStatsPayload || !Array.isArray(latestLeagueStatsPayload.players)) return;
  const leaguePlayers = latestLeagueStatsPayload.players;
  if (leaguePlayers.length === 0) return;

  const ourRes = db.exec(`SELECT DISTINCT player_id FROM player_season_stats WHERE season_id = ${endedSeasonId};`);
  const ourPlayerIds = new Set(ourRes.length > 0 ? ourRes[0].values.map(r => r[0]) : []);
  if (ourPlayerIds.size === 0) return;

  const categories = [
    { key: 'goals', award: 'golden_boot' },
    { key: 'assists', award: 'playmaker' },
    { key: 'clean_sheets', award: 'golden_glove', positionFilter: 0 } // position_id 0 == GK
  ];

  categories.forEach(({ key, award, positionFilter }) => {
    const pool = leaguePlayers.filter(p => positionFilter === undefined || p.position_id === positionFilter);
    if (pool.length === 0) return;

    const top = [...pool].sort((a, b) => (b[key] || 0) - (a[key] || 0))[0];
    if (!top || !(top[key] > 0) || !ourPlayerIds.has(top.player_id)) return;

    db.run(`
      INSERT INTO player_awards (player_id, season_id, award_type, stat_value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(season_id, award_type) DO NOTHING;
    `, [top.player_id, endedSeasonId, award, top[key]]);
    console.log(`[Awards] ${award} for player ${top.player_id} in season ${endedSeasonId} (${top[key]} ${key}).`);
  });

  saveDatabaseToDisk();
}

// Team trophies won during seasons this specific player was actually on
// the squad — "Winner" standings (see getTrophiesWon) restricted to
// season_ids where player_season_stats has a row for this player. League
// wins are labeled "Champion" rather than "Winner" to read more naturally
// (a cup is "won", a league is "won as champion").
function getPlayerTrophies(playerId, saveId = activeSaveId) {
  if (!db || !playerId || !saveId) return [];
  const res = db.exec(`
    SELECT r.comp_name, se.year_label
    FROM season_competition_results r
    JOIN seasons se ON se.id = r.season_id
    WHERE se.save_id = ${saveId} AND r.standing = 'Winner'
      AND r.season_id IN (SELECT season_id FROM player_season_stats WHERE player_id = ${playerId})
    ORDER BY se.id ASC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({ comp_name: row[0], year_label: row[1] }));
}

const AWARD_LABELS = { golden_boot: 'Golden Boot', playmaker: 'Playmaker', golden_glove: 'Golden Glove' };
const AWARD_STAT_LABELS = { golden_boot: 'goals', playmaker: 'assists', golden_glove: 'clean sheets' };

// This player's individual season-end awards for a save (see
// generateSeasonAwardsIfNeeded), most recent first.
function getPlayerAwards(playerId, saveId = activeSaveId) {
  if (!db || !playerId || !saveId) return [];
  const res = db.exec(`
    SELECT a.award_type, a.stat_value, se.year_label
    FROM player_awards a
    JOIN seasons se ON se.id = a.season_id
    WHERE a.player_id = ${playerId} AND se.save_id = ${saveId}
    ORDER BY se.id DESC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({
    award_type: row[0],
    label: AWARD_LABELS[row[0]] || row[0],
    stat_label: AWARD_STAT_LABELS[row[0]] || 'stat',
    stat_value: row[1],
    year_label: row[2]
  }));
}

function getPlayerHonours(playerId, saveId = activeSaveId) {
  return {
    trophies: getPlayerTrophies(playerId, saveId),
    awards: getPlayerAwards(playerId, saveId)
  };
}

// The oldest unacknowledged season-end review for a save, or null.
function getPendingSeasonReview(saveId = activeSaveId) {
  if (!db || !saveId) return null;
  const res = db.exec(`
    SELECT id, season_id, league_name, league_tier, league_average_overall, league_average_margin,
           allowed_overrated_count, overrated_count, overrated_players_json
    FROM season_end_reviews
    WHERE save_id = ${saveId} AND acknowledged = 0
    ORDER BY id ASC LIMIT 1;
  `);
  if (res.length === 0 || res[0].values.length === 0) return null;
  const row = res[0].values[0];
  return {
    id: row[0],
    season_id: row[1],
    league_name: row[2],
    league_tier: row[3],
    league_average_overall: row[4],
    league_average_margin: row[5],
    allowed_overrated_count: row[6],
    overrated_count: row[7],
    overrated_players: JSON.parse(row[8] || '[]')
  };
}

function acknowledgeSeasonReview(reviewId) {
  if (!db || !reviewId) return { success: false };
  db.run('UPDATE season_end_reviews SET acknowledged = 1 WHERE id = ?;', [reviewId]);
  saveDatabaseToDisk();
  return { success: true };
}

// Resolves which save a sync belongs to (via save_uid — see
// getOrCreateSaveByUID) and which season within it, setting
// activeSaveId/currentSeasonId to match. This is the "auto-detect" half
// of multi-save support: every sync points the app at whichever save is
// actually loaded in-game, regardless of whether it was the squad or
// calendar file that triggered it.
function resolveActiveSave(uid, managerName, clubName, dateForSeasonLabel) {
  const previousSaveId = activeSaveId;
  const previousSeasonId = currentSeasonId;

  if (!uid && previousSaveId) {
    // A blank save_uid on this sync (Live Editor's GetSaveUID() can come
    // back empty transiently, e.g. mid-save-switch in-game) while a save
    // is already active — getOrCreateSaveByUID's "no uid" fallback just
    // picks whichever save happens to be oldest, which would silently
    // reattribute this sync to the wrong save. Skipping resolution here
    // (the caller then skips importing this sync's data entirely — see
    // importFifaData and the calendar watcher) is what closes the exact
    // gap that corrupted a real save with another save's players once
    // already: better to drop one sync than misattribute it.
    console.warn('[Season] Skipped season resolution — blank save_uid with a save already active.');
    return false;
  }

  const saveId = getOrCreateSaveByUID(uid, managerName, clubName);
  activeSaveId = saveId;
  liveSyncedSaveId = saveId;

  const seasonLabel = computeSeasonLabel(dateForSeasonLabel);
  currentSeasonId = getOrCreateSeason(saveId, seasonLabel);

  // Only a genuine season rollover within the SAME save — not a switch to
  // a different save mid-sync — should trigger a season-end review/awards.
  if (previousSaveId === saveId && previousSeasonId && previousSeasonId !== currentSeasonId) {
    generateSeasonEndReviewIfNeeded(saveId, previousSeasonId);
    generateSeasonAwardsIfNeeded(saveId, previousSeasonId);
  }

  db.run('UPDATE seasons SET is_current = 1 WHERE id = ?;', [currentSeasonId]);
  db.run('UPDATE seasons SET is_current = 0 WHERE id != ? AND save_id = ?;', [
    currentSeasonId,
    saveId
  ]);
  saveDatabaseToDisk();
  console.log(`[Season] Save ${saveId}, season "${seasonLabel}" (id ${currentSeasonId})`);
  return true;
}

// Calendar-triggered entry point for resolveActiveSave — accepts an
// already-parsed payload when the caller has one (avoids a redundant
// re-read); falls back to reading the file itself for the startup call
// site, where nothing's been read yet.
function refreshCurrentSeasonFromCalendar(parsedPayload = null) {
  let parsed = parsedPayload;
  if (!parsed && fs.existsSync(calendarExportPath)) {
    try {
      parsed = JSON.parse(fs.readFileSync(calendarExportPath, 'utf-8'));
    } catch (err) {
      console.warn('[Season] Could not parse calendar export, using system date fallback:', err.message);
    }
  }

  return resolveActiveSave(
    parsed && parsed.save_uid,
    parsed && parsed.manager && parsed.manager.name,
    parsed && parsed.club_name,
    parsed && parsed.current_date
  );
}

// Stores the raw calendar export for activeSaveId so its "live" Home
// dashboard widgets (standings, upcoming match, captain, manager,
// trophies) have something to show when browsing this save later while
// a different one is loaded in-game — see selectSave().
function saveSnapshotForActiveSave(rawCalendarJson) {
  if (!db || !activeSaveId) return;
  db.run(`
    INSERT INTO save_snapshots (save_id, raw_calendar_json, synced_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(save_id) DO UPDATE SET
      raw_calendar_json = excluded.raw_calendar_json,
      synced_at = CURRENT_TIMESTAMP;
  `, [activeSaveId, rawCalendarJson]);
  saveDatabaseToDisk();
}

// ------------------------------------------------------------------
// Import
// ------------------------------------------------------------------

function importFifaData(jsonPayload) {
  if (!db || !jsonPayload || !Array.isArray(jsonPayload.players)) {
    console.warn('[DB] Invalid payload or players list empty.');
    return;
  }

  // The squad file is written before the calendar file each F10 run
  // (see export_all.lua's block order), so this can't lean on the
  // calendar sync having already run this cycle — it resolves the
  // season from this payload's OWN current_date instead.
  //
  // FIXED 2026-08-27 — this used to reuse getCurrentSeasonForSave()'s
  // "already-known current season" (whatever's flagged is_current in
  // the DB) rather than recomputing from a date, on the theory that
  // recomputing from today's real-world date on every squad sync would
  // fight with the calendar sync's in-game-date-based value. That
  // reasoning was wrong: on the FIRST sync after a real season rollover
  // in-game, the DB's is_current flag is still pointing at the OLD
  // season (only the calendar sync updates it), so the new season's
  // reset-to-zero stats got upserted straight into the old season's
  // row — silently overwriting the previous season's accumulated
  // history. Now that the squad export carries its own real in-game
  // date, resolving from it here is always correct, not a compromise.
  if (jsonPayload.save_uid) {
    resolveActiveSave(jsonPayload.save_uid, null, null, jsonPayload.current_date);
  } else if (!currentSeasonId) {
    refreshCurrentSeasonFromCalendar();
  } else {
    // GetSaveUID() came back empty on this export (seen in practice during
    // an in-game save switch, when club-name lookups for the same payload
    // also came back blank) while a DIFFERENT save was already active from
    // a previous sync. Silently upserting this payload into that stale
    // currentSeasonId would attribute one save's squad to another save's
    // history — exactly what corrupted a real save this way once already.
    // Safer to drop this one sync than misattribute it; the next sync
    // (almost always moments later) will carry a real save_uid.
    console.warn('[DB] Squad export had no save_uid while a different save was already active — skipping import to avoid cross-save contamination.');
    return;
  }

  // Whether each player already has a row THIS season (so overall_delta/
  // attribute_deltas_json below know to diff against the season's frozen
  // starting point rather than treating this as a fresh baseline). Read
  // once up front rather than per player to avoid a query per row.
  const previousStatsByPlayer = new Map();
  if (currentSeasonId) {
    const prevRes = db.exec(`SELECT player_id, overall, attributes_json, season_start_overall, season_start_attributes_json FROM player_season_stats WHERE season_id = ${currentSeasonId};`);
    if (prevRes.length > 0) {
      prevRes[0].values.forEach(([playerId, overall, attributesJson, seasonStartOverall, seasonStartAttributesJson]) => {
        previousStatsByPlayer.set(playerId, {
          overall,
          attributes: JSON.parse(attributesJson || '{}'),
          // Falls back to this row's plain overall/attributes_json only if
          // season_start_* somehow never got backfilled (shouldn't happen
          // post-migration, but keeps this from ever computing a delta
          // against nothing).
          seasonStartOverall: seasonStartOverall != null ? seasonStartOverall : overall,
          seasonStartAttributes: seasonStartAttributesJson ? JSON.parse(seasonStartAttributesJson) : JSON.parse(attributesJson || '{}')
        });
      });
    }
  }

  // Currently-open injury episodes (end_date IS NULL) for this save, so
  // the sync loop below can tell "still injured from before" apart from
  // "newly injured this sync" without a query per player. See
  // player_injury_history in schema.sql for why this is episode-based
  // rather than a running flag on player_season_stats.
  const openInjuryEpisodeByPlayer = new Map();
  if (activeSaveId) {
    const openRes = db.exec(`SELECT player_id, id FROM player_injury_history WHERE save_id = ${activeSaveId} AND end_date IS NULL;`);
    if (openRes.length > 0) {
      openRes[0].values.forEach(([playerId, episodeId]) => openInjuryEpisodeByPlayer.set(playerId, episodeId));
    }
  }

  // Existing contract-renewal tracking state for this save, so the sync
  // loop below can tell "same contract stint as last sync" apart from
  // "brand new contract" without a query per player. See
  // player_contract_state in schema.sql.
  const contractStateByPlayer = new Map();
  if (activeSaveId) {
    const contractStateRes = db.exec(`SELECT player_id, tracked_contract_date, baseline_contract_expiry, last_known_contract_expiry, last_renewal_date FROM player_contract_state WHERE save_id = ${activeSaveId};`);
    if (contractStateRes.length > 0) {
      contractStateRes[0].values.forEach(([playerId, trackedContractDate, baselineExpiry, lastKnownExpiry, lastRenewalDate]) => {
        contractStateByPlayer.set(playerId, { trackedContractDate, baselineExpiry, lastKnownExpiry, lastRenewalDate });
      });
    }
  }

  // The squad export's own in-game current_date (see the season-
  // resolution comment above) — falls back to today's real-world date
  // only in the unlikely case an export predates current_date existing.
  // Shared by both the injury-episode and contract-renewal detection
  // below, since both want "the in-game date we first noticed this
  // change", not wall-clock sync time.
  const syncInGameDate = jsonPayload.current_date || new Date().toISOString().slice(0, 10);

  // One shared timestamp for every row in this sync batch. Previously each
  // row's updated_at was set via SQL's CURRENT_TIMESTAMP, evaluated
  // per-row at execution time — SQLite's CURRENT_TIMESTAMP only has
  // 1-second resolution, so a squad sync spanning more than a second
  // (any squad of real size) could tick over mid-loop and give
  // earlier-processed players a strictly older updated_at than
  // later-processed ones, even though every player here is being synced
  // in this exact batch. That falsely tripped the "transferred" (stale
  // updated_at) detection below/in index.html on players who were still
  // very much on the squad — most visibly on players just signed in,
  // since a fresh arrival's row is often the first one processed.
  // Computing it once here and binding it to every row guarantees the
  // whole batch shares one identical value, so only genuinely-departed
  // players (whose row isn't touched at all this sync) end up stale.
  const syncTimestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  db.run('BEGIN TRANSACTION;');
  try {
    const injuryOpenStmt = db.prepare(`INSERT INTO player_injury_history (save_id, player_id, start_date) VALUES (?, ?, ?);`);
    const injuryCloseStmt = db.prepare(`UPDATE player_injury_history SET end_date = ? WHERE id = ?;`);

    const contractStateUpsertStmt = db.prepare(`
      INSERT INTO player_contract_state (player_id, save_id, tracked_contract_date, baseline_contract_expiry, last_known_contract_expiry, last_renewal_date)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id, save_id) DO UPDATE SET
        tracked_contract_date=excluded.tracked_contract_date,
        baseline_contract_expiry=excluded.baseline_contract_expiry,
        last_known_contract_expiry=excluded.last_known_contract_expiry,
        last_renewal_date=excluded.last_renewal_date;
    `);

    const playerStmt = db.prepare(`
      INSERT INTO players (player_id, name, position_id, alt_positions, nationality, dob, height, weight, preferred_foot, photo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET
        name=excluded.name,
        position_id=excluded.position_id,
        alt_positions=excluded.alt_positions,
        nationality=excluded.nationality,
        dob=excluded.dob,
        height=excluded.height,
        weight=excluded.weight,
        preferred_foot=excluded.preferred_foot,
        photo_id=excluded.photo_id;
    `);

    const statsStmt = db.prepare(`
      INSERT INTO player_season_stats
        (player_id, season_id, overall, potential, skill_moves, weak_foot,
         club_id, club_name, contract_expiry, contract_date, duration_months, player_role_, last_status_change_date,
         on_loan, loan_team_from, loan_club_name, loan_date_end, is_loan_to_buy, wage,
         jersey_number, injury,
         goals, assists, appearances, clean_sheets, saves, yellow_cards, red_cards, avg_rating,
         attributes_json, competitions_json, traits_json, play_styles_json,
         overall_delta, attribute_deltas_json, season_start_overall, season_start_attributes_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      -- season_start_overall/season_start_attributes_json are deliberately
      -- NOT in this SET list — see the column comment in schema.sql. The
      -- values bound for them below only ever take effect on a fresh
      -- INSERT (this player's first row for this season); on a conflict
      -- (every later sync this season) they're silently ignored and the
      -- row keeps whatever baseline its first insert set.
      ON CONFLICT(player_id, season_id) DO UPDATE SET
        overall=excluded.overall,
        potential=excluded.potential,
        skill_moves=excluded.skill_moves,
        weak_foot=excluded.weak_foot,
        club_id=excluded.club_id,
        club_name=excluded.club_name,
        contract_expiry=excluded.contract_expiry,
        contract_date=excluded.contract_date,
        duration_months=excluded.duration_months,
        player_role_=excluded.player_role_,
        last_status_change_date=excluded.last_status_change_date,
        on_loan=excluded.on_loan,
        loan_team_from=excluded.loan_team_from,
        loan_club_name=excluded.loan_club_name,
        loan_date_end=excluded.loan_date_end,
        is_loan_to_buy=excluded.is_loan_to_buy,
        wage=excluded.wage,
        jersey_number=excluded.jersey_number,
        injury=excluded.injury,
        goals=excluded.goals,
        assists=excluded.assists,
        appearances=excluded.appearances,
        clean_sheets=excluded.clean_sheets,
        saves=excluded.saves,
        yellow_cards=excluded.yellow_cards,
        red_cards=excluded.red_cards,
        avg_rating=excluded.avg_rating,
        attributes_json=excluded.attributes_json,
        competitions_json=excluded.competitions_json,
        traits_json=excluded.traits_json,
        play_styles_json=excluded.play_styles_json,
        overall_delta=excluded.overall_delta,
        attribute_deltas_json=excluded.attribute_deltas_json,
        updated_at=excluded.updated_at;
    `);

    jsonPayload.players.forEach(p => {
      const previous = previousStatsByPlayer.get(p.player_id);
      // Diffed against the season's FROZEN starting point (previous.
      // seasonStartOverall/seasonStartAttributes), not the previous sync's
      // values — this is what makes the delta accumulate for the whole
      // season instead of resetting every sync. A player with no row yet
      // this season has nothing to diff against, so their first sync of
      // the season always shows a 0/empty delta (exactly right, since
      // this sync IS the new baseline).
      const overallDelta = previous ? (p.overall || 0) - (previous.seasonStartOverall || 0) : 0;
      const attributeDeltas = previous ? computeAttributeDeltas(previous.seasonStartAttributes, p.attributes || {}) : {};

      playerStmt.run([
        p.player_id,
        p.name || 'Unknown',
        p.position_id || 0,
        p.alt_positions || '',
        p.nationality || '',
        p.dob || '',
        p.height || '',
        p.weight || '',
        p.preferred_foot || '',
        p.photo_id || p.player_id
      ]);

      statsStmt.run([
        p.player_id,
        currentSeasonId,
        p.overall || 0,
        p.potential || 0,
        p.skill_moves || '',
        p.weak_foot || '',
        p.club_id || 0,
        p.club_name || '',
        p.contract_expiry || '',
        p.contract_date || '',
        p.duration_months || 0,
        p.player_role_ || 0,
        p.last_status_change_date || '',
        p.on_loan ? 1 : 0,
        p.loan_team_from || 0,
        p.loan_club_name || '',
        p.loan_date_end || '',
        p.is_loan_to_buy ? 1 : 0,
        p.wage || 0,
        p.jersey_number || 0,
        p.injury ? 1 : 0,
        p.goals || 0,
        p.assists || 0,
        p.appearances || 0,
        p.clean_sheets || 0,
        p.saves || 0,
        p.yellow_cards || 0,
        p.red_cards || 0,
        p.avg_rating || 0.0,
        JSON.stringify(p.attributes || {}),
        JSON.stringify(p.competitions || []),
        JSON.stringify(p.traits || []),
        JSON.stringify(p.play_styles || []),
        overallDelta,
        JSON.stringify(attributeDeltas),
        p.overall || 0,                       // season_start_overall — only takes effect on a fresh insert
        JSON.stringify(p.attributes || {}),   // season_start_attributes_json — same
        syncTimestamp
      ]);

      // Injury episode transitions — see player_injury_history in
      // schema.sql. Only reacts to a CHANGE from last sync (via
      // openInjuryEpisodeByPlayer, built before this loop started), so a
      // player who's been injured for 10 syncs in a row gets exactly one
      // row, not one per sync.
      if (activeSaveId) {
        const hadOpenEpisode = openInjuryEpisodeByPlayer.has(p.player_id);
        if (p.injury && !hadOpenEpisode) {
          injuryOpenStmt.run([activeSaveId, p.player_id, syncInGameDate]);
        } else if (!p.injury && hadOpenEpisode) {
          injuryCloseStmt.run([syncInGameDate, openInjuryEpisodeByPlayer.get(p.player_id)]);
        }
      }

      // Contract renewal tracking — see player_contract_state in
      // schema.sql. A new contract_date (re-signing after leaving, or a
      // fresh deal) resets the baseline from scratch; otherwise, any
      // change in contract_expiry from what was last recorded stamps a
      // fresh last_renewal_date, so a second renewal isn't stuck showing
      // the first one's date.
      if (activeSaveId) {
        const existing = contractStateByPlayer.get(p.player_id);
        const contractDate = p.contract_date || '';
        const contractExpiry = p.contract_expiry || '';
        if (!existing || existing.trackedContractDate !== contractDate) {
          // Fresh contract stint — no renewal yet by definition.
          contractStateUpsertStmt.run([p.player_id, activeSaveId, contractDate, contractExpiry, contractExpiry, null]);
        } else if (contractExpiry !== existing.lastKnownExpiry) {
          contractStateUpsertStmt.run([p.player_id, activeSaveId, contractDate, existing.baselineExpiry, contractExpiry, syncInGameDate]);
        }
        // else: same contract, same expiry as last sync — no-op, row unchanged.
      }
    });

    injuryOpenStmt.free();
    injuryCloseStmt.free();
    contractStateUpsertStmt.free();
    playerStmt.free();
    statsStmt.free();
    db.run('COMMIT;');

    // Youth Mode potential-reveal: lock each new-to-us player's reveal
    // tier to whichever league the club is in RIGHT NOW, the first time
    // we ever see them (youth_reveal_tier IS NULL) — never touched again
    // after that, which is what makes the reveal speed "locked in" at
    // promotion instead of drifting if the club is later promoted or
    // relegated. Wrapped separately so a bug here can't roll back the
    // real squad sync above.
    try {
      lockYouthRevealTiers(jsonPayload.players.map(p => p.player_id).filter(Boolean));
    } catch (tierErr) {
      console.error('[DB] Failed to lock youth reveal tiers:', tierErr);
    }

    saveDatabaseToDisk();
    console.log(`[DB] Synced ${jsonPayload.players.length} players into season ${currentSeasonId} (history preserved).`);
  } catch (err) {
    db.run('ROLLBACK;');
    console.error('[DB] Transaction failed, rolled back changes:', err);
  }
}

function lockYouthRevealTiers(playerIds) {
  if (!db || !currentSeasonId || !activeSaveId || playerIds.length === 0) return;

  const youthEnabledRes = db.exec(`SELECT youth_mode_enabled FROM saves WHERE id = ${activeSaveId};`);
  const youthModeEnabled = youthEnabledRes.length > 0 && youthEnabledRes[0].values.length > 0
    && youthEnabledRes[0].values[0][0] === 1;
  if (!youthModeEnabled) return;

  const leagueNameRes = db.exec(`SELECT league_name FROM seasons WHERE id = ${currentSeasonId};`);
  const leagueName = (leagueNameRes.length > 0 && leagueNameRes[0].values.length > 0) ? leagueNameRes[0].values[0][0] : null;
  const tierInfo = findPyramidTierServer(leagueName);
  const currentTier = tierInfo ? tierInfo.tier : 4; // unrecognized/below League Two treated as the slowest (League Two) baseline

  db.run(`UPDATE players SET youth_reveal_tier = ${currentTier} WHERE youth_reveal_tier IS NULL AND player_id IN (${playerIds.join(',')});`);
}

// Youth academy roster — see export_all.lua's YOUTH ACADEMY EXPORT
// block. Upserts bio fields into the shared `players` table (only
// name/position_id/dob — a partial UPDATE via ON CONFLICT, so it never
// clobbers richer data a senior-squad sync already wrote) and the
// roster snapshot into youth_academy_snapshot, never deleted once seen
// — that history is what getInferredTransfers checks to tell an
// Academy Graduate apart from an outside signing.
function importYouthAcademy(jsonPayload) {
  if (!db || !currentSeasonId || !jsonPayload || !Array.isArray(jsonPayload.youth_academy)) return;

  const playerStmt = db.prepare(`
    INSERT INTO players (player_id, name, position_id, dob)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET
      name = excluded.name,
      position_id = excluded.position_id,
      dob = excluded.dob;
  `);
  const snapshotStmt = db.prepare(`
    INSERT INTO youth_academy_snapshot (player_id, season_id, tier, months_in_squad, overall, potential_low, potential_high, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id, season_id) DO UPDATE SET
      tier = excluded.tier,
      months_in_squad = excluded.months_in_squad,
      overall = excluded.overall,
      potential_low = excluded.potential_low,
      potential_high = excluded.potential_high,
      updated_at = CURRENT_TIMESTAMP;
  `);

  try {
    jsonPayload.youth_academy.forEach(p => {
      if (!p.player_id) return;
      playerStmt.run([p.player_id, p.name || 'Unknown', p.position_id || 0, p.dob || '']);
      snapshotStmt.run([p.player_id, currentSeasonId, p.tier || 0, p.months_in_squad || 0, p.overall || 0, p.potential_low || 0, p.potential_high || 0]);
    });
  } finally {
    playerStmt.free();
    snapshotStmt.free();
  }

  saveDatabaseToDisk();
}

// ------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------

// Current-season squad view (what the UI shows by default)
function getSquadFromDB(seasonId = currentSeasonId) {
  if (!db || !seasonId) return [];

  const res = db.exec(`
    SELECT p.player_id, p.name, p.position_id, p.alt_positions, p.nationality, p.dob, p.height, p.weight,
           p.preferred_foot, p.photo_id,
           s.overall, s.potential, s.skill_moves, s.weak_foot, s.club_id, s.club_name, s.contract_expiry,
           s.contract_date, s.duration_months, s.player_role_, s.last_status_change_date,
           s.on_loan, s.loan_team_from, s.loan_club_name, s.loan_date_end, s.is_loan_to_buy, s.wage,
           s.jersey_number, s.injury,
           s.goals, s.assists, s.appearances, s.clean_sheets, s.saves,
           s.yellow_cards, s.red_cards, s.avg_rating, s.attributes_json, s.competitions_json,
           s.traits_json, s.play_styles_json, s.updated_at, s.overall_delta, s.attribute_deltas_json,
           p.youth_reveal_tier
    FROM players p
    JOIN player_season_stats s ON s.player_id = p.player_id
    WHERE s.season_id = ${seasonId}
    ORDER BY s.overall DESC;
  `);

  if (res.length === 0) return [];

  return res[0].values.map(row => ({
    player_id: row[0],
    name: row[1],
    position_id: row[2],
    alt_positions: row[3],
    nationality: row[4],
    dob: row[5],
    height: row[6],
    weight: row[7],
    preferred_foot: row[8],
    photo_id: row[9],
    overall: row[10],
    potential: row[11],
    skill_moves: row[12],
    weak_foot: row[13],
    club_id: row[14],
    club_name: row[15],
    contract_expiry: row[16],
    contract_date: row[17],
    duration_months: row[18],
    player_role_: row[19],
    last_status_change_date: row[20],
    on_loan: row[21] === 1,
    loan_team_from: row[22],
    loan_club_name: row[23],
    loan_date_end: row[24],
    is_loan_to_buy: row[25] === 1,
    wage: row[26],
    jersey_number: row[27],
    injury: row[28] === 1,
    goals: row[29],
    assists: row[30],
    appearances: row[31],
    clean_sheets: row[32],
    saves: row[33],
    yellow_cards: row[34],
    red_cards: row[35],
    avg_rating: row[36],
    attributes: JSON.parse(row[37] || '{}'),
    competitions: JSON.parse(row[38] || '[]'),
    traits: JSON.parse(row[39] || '[]'),
    play_styles: JSON.parse(row[40] || '[]'),
    updated_at: row[41],
    overall_delta: row[42] || 0,
    attribute_deltas: JSON.parse(row[43] || '{}'),
    youth_reveal_tier: row[44]
  }));
}

// Season list for the Squad Stats selector (current save only).
function getSeasonsList(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`SELECT id, year_label, is_current, league_name FROM seasons WHERE save_id = ${saveId} ORDER BY year_label ASC;`);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({ id: row[0], year_label: row[1], is_current: row[2] === 1, league_name: row[3] }));
}

// Resolves "the current season" for an arbitrary save — the season-list
// pattern above filtered to is_current=1. Used by read functions when
// browsing a save other than the active one.
function getCurrentSeasonForSave(saveId) {
  if (!db || !saveId) return null;
  const res = db.exec(`SELECT id FROM seasons WHERE save_id = ${saveId} AND is_current = 1 LIMIT 1;`);
  if (res.length > 0 && res[0].values.length > 0) return res[0].values[0][0];
  const fallback = db.exec(`SELECT id FROM seasons WHERE save_id = ${saveId} ORDER BY year_label DESC LIMIT 1;`);
  return (fallback.length > 0 && fallback[0].values.length > 0) ? fallback[0].values[0][0] : null;
}

// "All Time" squad view: current/last-known bio/contract/club info (same
// shape as getSquadFromDB), but goals/assists/appearances/etc summed
// across every season each player has been with the club, and avg_rating
// as an appearances-weighted average across those seasons — same
// aggregation pattern already used client-side for a player's
// competitions breakdown. Scoped to this save specifically (a player_id
// is a global EA FC id — the same real player could theoretically show
// up in a different save too, so the aggregation must not cross saves).
//
// FIXED: previously joined "cur" to the CURRENT season specifically
// (cur.season_id = ${seasonId}), an INNER JOIN — so anyone who left the
// club before the current season (no row for that exact season_id) was
// silently excluded from "All Time" entirely, not just missing their
// stats. "latest" now resolves each player's most recent season_id FOR
// THIS SAVE regardless of whether that's the current season, so a
// long-departed player still shows up with their last-known bio/overall/
// club from whenever they actually left — same "last known" convention
// getPastPlayers already uses for the Former Players tab.
function getAllTimeSquadStats(saveId = activeSaveId) {
  if (!db || !saveId) return [];

  const res = db.exec(`
    SELECT p.player_id, p.name, p.position_id, p.alt_positions, p.nationality, p.dob, p.height, p.weight,
           p.preferred_foot, p.photo_id,
           cur.overall, cur.potential, cur.skill_moves, cur.weak_foot, cur.club_id, cur.club_name, cur.contract_expiry,
           cur.contract_date, cur.duration_months, cur.player_role_, cur.last_status_change_date,
           cur.on_loan, cur.loan_team_from, cur.loan_club_name, cur.loan_date_end, cur.is_loan_to_buy, cur.wage,
           cur.jersey_number, cur.injury,
           cur.attributes_json, cur.competitions_json, cur.traits_json, cur.play_styles_json,
           SUM(s.goals) as t_goals, SUM(s.assists) as t_assists, SUM(s.appearances) as t_apps,
           SUM(s.clean_sheets) as t_cs, SUM(s.saves) as t_saves,
           SUM(s.yellow_cards) as t_yellow, SUM(s.red_cards) as t_red,
           SUM(s.avg_rating * s.appearances) as t_rating_weighted,
           cur.updated_at, p.youth_reveal_tier
    FROM players p
    JOIN (
      SELECT ps.player_id, MAX(ps.season_id) as latest_season_id
      FROM player_season_stats ps
      JOIN seasons se3 ON se3.id = ps.season_id AND se3.save_id = ${saveId}
      GROUP BY ps.player_id
    ) latest ON latest.player_id = p.player_id
    JOIN player_season_stats cur ON cur.player_id = p.player_id AND cur.season_id = latest.latest_season_id
    JOIN player_season_stats s ON s.player_id = p.player_id
    JOIN seasons se2 ON se2.id = s.season_id AND se2.save_id = ${saveId}
    GROUP BY p.player_id
    ORDER BY cur.overall DESC;
  `);

  if (res.length === 0) return [];

  return res[0].values.map(row => {
    const totalApps = row[35] || 0;
    return {
      player_id: row[0], name: row[1], position_id: row[2], alt_positions: row[3], nationality: row[4], dob: row[5],
      height: row[6], weight: row[7], preferred_foot: row[8], photo_id: row[9],
      overall: row[10], potential: row[11], skill_moves: row[12], weak_foot: row[13],
      club_id: row[14], club_name: row[15], contract_expiry: row[16], contract_date: row[17],
      duration_months: row[18], player_role_: row[19], last_status_change_date: row[20],
      on_loan: row[21] === 1, loan_team_from: row[22], loan_club_name: row[23], loan_date_end: row[24],
      is_loan_to_buy: row[25] === 1, wage: row[26],
      jersey_number: row[27], injury: row[28] === 1,
      attributes: JSON.parse(row[29] || '{}'), competitions: JSON.parse(row[30] || '[]'),
      traits: JSON.parse(row[31] || '[]'), play_styles: JSON.parse(row[32] || '[]'),
      goals: row[33] || 0, assists: row[34] || 0, appearances: totalApps,
      clean_sheets: row[36] || 0, saves: row[37] || 0, yellow_cards: row[38] || 0, red_cards: row[39] || 0,
      avg_rating: totalApps > 0 ? (row[40] || 0) / totalApps : 0,
      updated_at: row[41],
      youth_reveal_tier: row[42]
    };
  });
}

// Past Players: anyone who was ever on the club's books (club_id ===
// the user's team in some earlier season) but isn't on the current
// roster. "Current club" is only known if they're still being tracked
// via the is_loaned_out export path (loaned out from us, still resolves
// live each sync) — otherwise it's honestly "Unknown", same philosophy
// as the rest of the app (see getInferredTransfers). OVR/potential/wage
// are their LAST KNOWN values from when they left, not live — there's no
// safe way to get current stats for a player no longer on our roster
// (the Live Editor "transfers" table crash means we can't cross-reference
// arbitrary players; see feedback_live_editor_data_safety memory).
// Reads whatever export_all.lua's watchlist lookup last wrote (current
// overall/potential/club for specific former-squad players we asked
// about). Returns a Map keyed by player_id, empty if the file doesn't
// exist yet (nothing has been looked up) — that's expected until the
// user hits F10 at least once after past players are first detected.
function readWatchlistStatus() {
  const map = new Map();
  if (!fs.existsSync(watchlistStatusPath)) return map;
  try {
    const parsed = JSON.parse(fs.readFileSync(watchlistStatusPath, 'utf-8'));
    (parsed.players || []).forEach(p => map.set(p.player_id, p));
  } catch (err) {
    console.error('[Watchlist] Failed to read watchlist status file:', err);
  }
  return map;
}

// Tells export_all.lua's watchlist section which player IDs to look up
// on its NEXT run — one refresh cycle behind is expected and fine here.
function writeWatchlistFile(playerIds) {
  try {
    fs.writeFileSync(watchlistInputPath, JSON.stringify({ player_ids: playerIds }));
  } catch (err) {
    console.error('[Watchlist] Failed to write watchlist input file:', err);
  }
}

function getPastPlayers(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const currentSeasonForSave = getCurrentSeasonForSave(saveId);
  if (!currentSeasonForSave) return [];

  const currentRes = db.exec(`
    SELECT player_id, club_id, on_loan, updated_at FROM player_season_stats WHERE season_id = ${currentSeasonForSave};
  `);
  const currentRows = currentRes.length > 0 ? currentRes[0].values : [];

  // A departed player's row is never deleted (history is kept forever),
  // and nothing overwrites its club_id once the squad export stops
  // including them mid-season — so club_id alone can't tell "still ours"
  // from "left ours" for anyone whose old club happens to still be the
  // user's team id. The real signal is whether the row was actually
  // touched by the most recent squad sync, same __clubStatus logic used
  // client-side in index.html (transformPlayersForTable).
  let maxUpdatedAt = null;
  currentRows.forEach(([, , , updated_at]) => {
    if (updated_at && (!maxUpdatedAt || updated_at > maxUpdatedAt)) maxUpdatedAt = updated_at;
  });

  const currentClubById = new Map();
  const stillOnRosterIds = new Set();
  currentRows.forEach(([player_id, club_id, , updated_at]) => {
    currentClubById.set(player_id, club_id);
    // A currently-active loan is re-detected from live game state every
    // export cycle, so its row is refreshed right alongside everyone
    // else's — on_loan is never stale while the loan is still real. Only
    // staleness (row untouched by the latest sync) means the player
    // actually left the club — trusting a stale on_loan flag on its own
    // would wrongly keep a recalled-then-sold player listed as "ours".
    if (!maxUpdatedAt || !updated_at || updated_at === maxUpdatedAt) stillOnRosterIds.add(player_id);
  });

  // The user's own team id, same trick as getInferredTransfers: whichever
  // club_id shows up on a non-loan row that's still actually on the roster.
  let userTeamId = null;
  for (const [player_id, club_id, on_loan] of currentRows) {
    if (!on_loan && stillOnRosterIds.has(player_id)) { userTeamId = club_id; break; }
  }
  if (userTeamId === null) return [];

  // Every player who was ever "ours" (club_id === userTeamId) in ANY
  // season OF THIS SAVE, with their most recent such row. Team ids are
  // global to the game (e.g. Arsenal is always id 1), so scoping to
  // se.save_id matters here — without it, a second save also involving
  // the same club would mix its past players into this one's list.
  const pastRes = db.exec(`
    SELECT p.player_id, p.name, p.position_id, p.dob, p.nationality, p.height, p.weight, p.alt_positions,
           s.overall, s.potential, s.wage, s.club_id, se.year_label, s.season_id, s.updated_at
    FROM player_season_stats s
    JOIN players p ON p.player_id = s.player_id
    JOIN seasons se ON se.id = s.season_id
    WHERE s.club_id = ${userTeamId} AND se.save_id = ${saveId}
    ORDER BY s.season_id ASC;
  `);
  if (pastRes.length === 0) return [];

  // ASC order means the first time a player_id is seen here is their
  // earliest season with the club — kept alongside the (repeatedly
  // overwritten) most recent row so years-with-club can be computed as
  // a real span instead of just a single "departed" point in time.
  const lastKnown = new Map();
  const firstYearLabelByPlayer = new Map();
  pastRes[0].values.forEach(row => {
    const [player_id, name, position_id, dob, nationality, height, weight, alt_positions, overall, potential, wage, club_id, year_label, season_id, updated_at] = row;
    if (!firstYearLabelByPlayer.has(player_id)) firstYearLabelByPlayer.set(player_id, year_label);
    lastKnown.set(player_id, { player_id, name, position_id, dob, nationality, height, weight, alt_positions, overall, potential, wage, year_label, season_id, updated_at });
  });

  // See clearFormerPlayers/former_players_cleared_before — a player whose
  // last known row predates this cutoff was already gone before the user
  // cleared the tab (e.g. right before starting a youth rebuild) and stays
  // hidden from this list forever; only departures after the cutoff count.
  // Purely a display filter — their player_season_stats rows are untouched,
  // so past season stats/leaders elsewhere are unaffected.
  const clearedRes = db.exec(`SELECT former_players_cleared_before FROM saves WHERE id = ${saveId};`);
  const clearedBefore = (clearedRes.length > 0 && clearedRes[0].values.length > 0) ? clearedRes[0].values[0][0] : null;

  // year_label is "2026/2027" — the leading year is enough to measure a
  // span in whole seasons; +1 makes a single season played count as 1
  // year, not 0.
  function seasonStartYear(yearLabel) {
    const year = parseInt(String(yearLabel || '').split('/')[0], 10);
    return isNaN(year) ? null : year;
  }

  const watchlistStatus = readWatchlistStatus();

  const results = [];
  lastKnown.forEach((info, playerId) => {
    if (stillOnRosterIds.has(playerId)) return; // still on the roster (or out on loan), not a "past" player
    if (clearedBefore && info.updated_at && info.updated_at <= clearedBefore) return; // cleared — see former_players_cleared_before above

    const currentClubId = currentClubById.get(playerId);
    let currentClub = 'Unknown';
    if (currentClubId !== undefined && currentClubId !== userTeamId) {
      const clubRes = db.exec(`SELECT club_name FROM player_season_stats WHERE season_id = ${currentSeasonForSave} AND player_id = ${playerId} LIMIT 1;`);
      if (clubRes.length > 0 && clubRes[0].values.length > 0) currentClub = clubRes[0].values[0][0];
    }

    // Prefer the live watchlist lookup (current overall/potential/club
    // straight from the game) when we have it; fall back to their last
    // known values from when they left otherwise — see the watchlist
    // comment block above for why this needs a round trip.
    const live = watchlistStatus.get(playerId);
    if (live && live.club_name) currentClub = live.club_name;

    const joinedSeason = firstYearLabelByPlayer.get(playerId) || info.year_label;
    const joinedYear = seasonStartYear(joinedSeason);
    const departedYear = seasonStartYear(info.year_label);
    const yearsActive = (joinedYear !== null && departedYear !== null) ? (departedYear - joinedYear + 1) : null;

    results.push({
      player_id: info.player_id,
      name: info.name,
      position_id: info.position_id,
      dob: info.dob,
      nationality: info.nationality,
      height: info.height,
      weight: info.weight,
      alt_positions: info.alt_positions,
      overall: live ? live.overall : info.overall,
      potential: live ? live.potential : info.potential,
      overall_is_live: !!live,
      attributes: live ? live.attributes : null,
      wage_at_departure: info.wage,
      joined_season: joinedSeason,
      departed_season: info.year_label,
      years_active: yearsActive,
      current_club: currentClub
    });
  });

  // Only meaningful for the save Live Editor actually has loaded right
  // now — writing it for a save being browsed in the background would
  // either be pointless (Lua can't look up a save that isn't active) or
  // would clobber the active save's watchlist.
  if (saveId === activeSaveId) {
    writeWatchlistFile(results.map(r => r.player_id));
    persistFormerPlayerSnapshots(saveId, currentSeasonForSave, watchlistStatus);
  }

  return results;
}

// Keeps a former player's career actually followed for as long as the
// save continues, instead of freezing at their last known values from
// the day they left — upserted every time getPastPlayers runs (i.e.
// every time the Former Players tab loads) from whatever the watchlist
// most recently found live in-game. See former_player_snapshots in
// schema.sql and getPlayerHistory below, which unions this in.
function persistFormerPlayerSnapshots(saveId, seasonId, watchlistStatus) {
  if (!db || !seasonId || watchlistStatus.size === 0) return;
  const stmt = db.prepare(`
    INSERT INTO former_player_snapshots (player_id, season_id, overall, potential, club_id, club_name, attributes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, season_id) DO UPDATE SET
      overall=excluded.overall,
      potential=excluded.potential,
      club_id=excluded.club_id,
      club_name=excluded.club_name,
      attributes_json=excluded.attributes_json,
      updated_at=CURRENT_TIMESTAMP;
  `);
  watchlistStatus.forEach(live => {
    if (!live.attributes) return; // stale pre-attributes watchlist entry, skip until next real lookup
    stmt.run([
      live.player_id,
      seasonId,
      live.overall || 0,
      live.potential || 0,
      live.club_id || 0,
      live.club_name || '',
      JSON.stringify(live.attributes)
    ]);
  });
  stmt.free();
  saveDatabaseToDisk();
}

// Signed players: everyone currently under contract to the club (on the
// active roster or out on loan — a loanee is still "signed" here, the
// Loaned tab covers where they currently are) with where they came from.
// "Academy" if they were ever tracked in this save's youth academy,
// otherwise the most recent club season_league_stats shows them at
// BEFORE they first appeared on our books (a rival team's rival, if
// they were playing in this same league) — 'Unknown Club' when neither
// applies, same honesty-about-missing-data philosophy as the rest of
// this app (player_season_stats only ever records OUR OWN roster, so
// there's no direct "previous club" field to read for an outside signing).
function getSignedPlayers(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const currentSeasonForSave = getCurrentSeasonForSave(saveId);
  if (!currentSeasonForSave) return [];

  const currentRes = db.exec(`
    SELECT player_id, club_id, on_loan, updated_at, contract_date, overall FROM player_season_stats WHERE season_id = ${currentSeasonForSave};
  `);
  const currentRows = currentRes.length > 0 ? currentRes[0].values : [];

  let maxUpdatedAt = null;
  currentRows.forEach(([, , , updated_at]) => {
    if (updated_at && (!maxUpdatedAt || updated_at > maxUpdatedAt)) maxUpdatedAt = updated_at;
  });

  // Signed = currently under contract: touched by the latest sync (on
  // the pitch for us, or out on loan and re-detected fresh this cycle —
  // see getCurrentActivePlayerIds for why on_loan can't override
  // staleness on its own).
  const activeIds = [];
  let userTeamId = null;
  // contract_date (YYYYMMDD, from the game's own contract record — see
  // export_all.lua) is the fallback "signed date" for anyone with no
  // captured transfer negotiation, most importantly academy graduates
  // (a promotion has no negotiation at all) — always present, unlike the
  // negotiation-memory deal which only exists if a sync happened to catch
  // it while it was still in memory.
  const contractDateByPlayer = new Map();
  const overallByPlayer = new Map();
  currentRows.forEach(([player_id, club_id, on_loan, updated_at, contract_date, overall]) => {
    const isActive = !maxUpdatedAt || !updated_at || updated_at === maxUpdatedAt;
    if (isActive) {
      activeIds.push(player_id);
      if (!on_loan && userTeamId === null) userTeamId = club_id;
      contractDateByPlayer.set(player_id, contract_date || '');
      overallByPlayer.set(player_id, overall || 0);
    }
  });
  if (userTeamId === null || activeIds.length === 0) return [];

  const ourClubNameRes = db.exec(`SELECT club_name FROM player_season_stats WHERE club_id = ${userTeamId} AND club_name IS NOT NULL LIMIT 1;`);
  const ourClubName = (ourClubNameRes.length > 0 && ourClubNameRes[0].values.length > 0) ? ourClubNameRes[0].values[0][0] : null;

  const everInAcademy = getAcademyGraduateIds(saveId);

  // Earliest season_id each active player_id has ever had a row for on
  // our books this save — that's "when" they signed. Computed in JS from
  // a flat, ASC-ordered scan rather than a nested SQL query.
  const allOursRes = db.exec(`
    SELECT s.player_id, s.season_id, se.year_label
    FROM player_season_stats s
    JOIN seasons se ON se.id = s.season_id
    WHERE se.save_id = ${saveId}
    ORDER BY s.season_id ASC;
  `);
  const earliestSeasonByPlayer = new Map();
  if (allOursRes.length > 0) {
    allOursRes[0].values.forEach(([player_id, season_id, year_label]) => {
      if (!earliestSeasonByPlayer.has(player_id)) {
        earliestSeasonByPlayer.set(player_id, { season_id, year_label });
      }
    });
  }

  const bioRes = db.exec(`SELECT player_id, name, position_id, dob FROM players;`);
  const bioById = new Map();
  if (bioRes.length > 0) bioRes[0].values.forEach(([player_id, name, position_id, dob]) => bioById.set(player_id, { name, position_id, dob }));

  const results = [];
  activeIds.forEach(playerId => {
    const earliest = earliestSeasonByPlayer.get(playerId);
    const isAcademy = everInAcademy.has(playerId);

    let fromTeam = 'Unknown Club';
    if (isAcademy) {
      fromTeam = ourClubName ? `${ourClubName} Academy` : 'Academy';
    } else if (earliest) {
      // A rival team's row for this same player_id from a season BEFORE
      // they first appeared on our own books — the closest thing to a
      // real "signed from" club this app can honestly know.
      const priorRes = db.exec(`
        SELECT team_name FROM season_league_stats
        WHERE player_id = ${playerId} AND season_id < ${earliest.season_id}
        ORDER BY season_id DESC LIMIT 1;
      `);
      if (priorRes.length > 0 && priorRes[0].values.length > 0) {
        const priorTeamName = priorRes[0].values[0][0];
        // Guards against a same-club false positive (e.g. a promoted
        // academy player whose earliest player_season_stats row lags one
        // sync behind their earliest season_league_stats row).
        if (priorTeamName && priorTeamName !== ourClubName) fromTeam = priorTeamName;
      }
    }

    const bio = bioById.get(playerId) || {};
    results.push({
      player_id: playerId,
      name: bio.name || 'Unknown',
      position_id: bio.position_id || 0,
      dob: bio.dob || '',
      overall: overallByPlayer.get(playerId) || 0,
      from_team: fromTeam,
      is_academy: isAcademy,
      signed_season: earliest ? earliest.year_label : null,
      contract_date: contractDateByPlayer.get(playerId) || ''
    });
  });

  return results;
}

// Full multi-season history for one player — this is the whole point.
// Scoped to a save (player_id is a global EA FC id, so the same real
// player could exist in more than one save's history).
//
// Unions two sources on one continuous season timeline: player_season_stats
// (seasons actually on our books) and former_player_snapshots (seasons
// after they left, tracked live via the watchlist — see
// persistFormerPlayerSnapshots). A departed player's snapshot seasons are
// left-joined against season_league_stats so real goals/assists/
// appearances show up whenever they stayed within the tracked league;
// otherwise those fields are honestly 0 rather than fabricated.
function getPlayerHistory(playerId, saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`
    SELECT se.id, se.year_label, se.league_name, s.overall, s.potential, s.goals, s.assists, s.appearances,
           s.clean_sheets, s.avg_rating, s.attributes_json, s.competitions_json
    FROM player_season_stats s
    JOIN seasons se ON se.id = s.season_id
    WHERE s.player_id = ${playerId} AND se.save_id = ${saveId}
    ORDER BY se.id ASC;
  `);
  const withUsRows = res.length > 0 ? res[0].values : [];
  const coveredSeasonIds = new Set();

  const combined = withUsRows.map(row => {
    coveredSeasonIds.add(row[0]);
    return {
      seasonOrder: row[0],
      season: row[1],
      league_name: row[2],
      overall: row[3],
      potential: row[4],
      goals: row[5],
      assists: row[6],
      appearances: row[7],
      clean_sheets: row[8],
      avg_rating: row[9],
      attributes: JSON.parse(row[10] || '{}'),
      competitions: JSON.parse(row[11] || '[]')
    };
  });

  const formerRes = db.exec(`
    SELECT se.id, se.year_label, se.league_name, f.overall, f.potential, f.attributes_json,
           l.goals, l.assists, l.appearances, l.clean_sheets
    FROM former_player_snapshots f
    JOIN seasons se ON se.id = f.season_id
    LEFT JOIN season_league_stats l ON l.season_id = f.season_id AND l.player_id = f.player_id
    WHERE f.player_id = ${playerId} AND se.save_id = ${saveId}
    ORDER BY se.id ASC;
  `);
  if (formerRes.length > 0) {
    formerRes[0].values.forEach(row => {
      const [seasonId, yearLabel, leagueName, overall, potential, attributesJson, goals, assists, appearances, cleanSheets] = row;
      if (coveredSeasonIds.has(seasonId)) return; // already have a with-us row for this season
      combined.push({
        seasonOrder: seasonId,
        season: yearLabel,
        league_name: leagueName,
        overall,
        potential,
        goals: goals || 0,
        assists: assists || 0,
        appearances: appearances || 0,
        clean_sheets: cleanSheets || 0,
        avg_rating: 0,
        attributes: JSON.parse(attributesJson || '{}'),
        competitions: []
      });
    });
  }

  combined.sort((a, b) => a.seasonOrder - b.seasonOrder);
  return combined.map(({ seasonOrder, ...rest }) => rest);
}

// Career (all-season) totals per player, for the Home page's All-Time
// top scorers/assists/appearances toggle.
function getCareerTotalsForSquad(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`
    SELECT p.player_id, p.name, p.position_id,
           SUM(s.goals) AS goals, SUM(s.assists) AS assists,
           SUM(s.appearances) AS appearances, SUM(s.clean_sheets) AS clean_sheets
    FROM player_season_stats s
    JOIN players p ON p.player_id = s.player_id
    JOIN seasons se ON se.id = s.season_id AND se.save_id = ${saveId}
    GROUP BY s.player_id
    ORDER BY goals DESC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({
    player_id: row[0],
    name: row[1],
    position_id: row[2],
    goals: row[3],
    assists: row[4],
    appearances: row[5],
    clean_sheets: row[6]
  }));
}

// Points-per-game per season, chronological, for the Manager PPG widget.
function getManagerSeasonPPG(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`
    SELECT se.year_label,
           COUNT(*) AS played,
           SUM(CASE WHEN m.result = 'W' THEN 3 WHEN m.result = 'D' THEN 1 ELSE 0 END) AS points
    FROM matches m
    JOIN seasons se ON se.id = m.season_id
    WHERE se.save_id = ${saveId}
    GROUP BY m.season_id
    ORDER BY se.id ASC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => {
    const played = row[1];
    const points = row[2];
    return {
      season: row[0],
      played,
      points,
      ppg: played > 0 ? points / played : 0
    };
  });
}

// Per-season W/D/L/GF/GA, chronological, for the Team Record widget's
// season selector (an "All Time" total is summed client-side from these).
function getTeamRecordSeasons(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`
    SELECT se.id,
           se.year_label,
           COUNT(*) AS played,
           SUM(CASE WHEN m.result = 'W' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN m.result = 'D' THEN 1 ELSE 0 END) AS draws,
           SUM(CASE WHEN m.result = 'L' THEN 1 ELSE 0 END) AS losses,
           SUM(m.user_score) AS goals_for,
           SUM(m.opponent_score) AS goals_against
    FROM matches m
    JOIN seasons se ON se.id = m.season_id
    WHERE se.save_id = ${saveId}
    GROUP BY m.season_id
    ORDER BY se.id ASC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({
    season_id: row[0],
    season: row[1],
    played: row[2],
    wins: row[3],
    draws: row[4],
    losses: row[5],
    goals_for: row[6],
    goals_against: row[7]
  }));
}

// ------------------------------------------------------------------
// Multi-save browsing
// ------------------------------------------------------------------

function getSavesList() {
  if (!db) return [];
  const res = db.exec(`
    SELECT s.id, s.club_name, s.manager_name, s.save_uid, ss.synced_at, s.youth_mode_enabled
    FROM saves s
    LEFT JOIN save_snapshots ss ON ss.save_id = s.id
    ORDER BY s.id ASC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({
    id: row[0],
    club_name: row[1],
    manager_name: row[2],
    save_uid: row[3],
    last_synced_at: row[4],
    is_live: row[0] === liveSyncedSaveId,
    youth_mode_enabled: row[5] === 1
  }));
}

// Switches which save the UI is viewing without waiting for a new sync
// (the "manual browse" half of multi-save support — see
// resolveActiveSave for the "auto-detect" half). Returns a full bundle
// so the renderer can re-hydrate in one round trip. Calendar-derived
// data (standings/upcoming match/captain/manager/trophies) comes from
// the stored snapshot unless this happens to be the currently-live
// save, in which case the live export file is still more current than
// the last snapshot.
function selectSave(saveId) {
  if (!db || !saveId) return null;
  activeSaveId = saveId;

  const seasonId = getCurrentSeasonForSave(saveId);
  const isLive = saveId === liveSyncedSaveId;

  const youthRes = db.exec(`SELECT youth_mode_enabled FROM saves WHERE id = ${saveId};`);
  const youthModeEnabled = youthRes.length > 0 && youthRes[0].values.length > 0
    && youthRes[0].values[0][0] === 1;

  let calendar = null;
  let calendarIsSnapshot = false;
  if (isLive && fs.existsSync(calendarExportPath)) {
    try {
      calendar = JSON.parse(fs.readFileSync(calendarExportPath, 'utf-8'));
    } catch (err) {
      console.error('[SelectSave] Failed to read live calendar export:', err);
    }
  }
  if (!calendar) {
    const snapRes = db.exec(`SELECT raw_calendar_json, synced_at FROM save_snapshots WHERE save_id = ${saveId};`);
    if (snapRes.length > 0 && snapRes[0].values.length > 0) {
      try {
        calendar = JSON.parse(snapRes[0].values[0][0]);
        calendar.snapshot_synced_at = snapRes[0].values[0][1];
        calendarIsSnapshot = true;
      } catch (err) {
        console.error('[SelectSave] Failed to parse stored snapshot:', err);
      }
    }
  }

  return {
    save_id: saveId,
    is_live: isLive,
    squad: seasonId ? getSquadFromDB(seasonId) : [],
    calendar,
    calendar_is_snapshot: calendarIsSnapshot,
    past_players: getPastPlayers(saveId),
    transfers: getInferredTransfers(saveId),
    seasons: getSeasonsList(saveId),
    youth_academy: getYouthAcademy(saveId),
    youth_mode_enabled: youthModeEnabled,
    pending_season_review: getPendingSeasonReview(saveId)
  };
}

// Permanently deletes a save and everything scoped to it (seasons,
// player_season_stats, matches, snapshot) — NOT the shared `players`
// table, since player bios are global EA FC data other saves may also
// reference. Irreversible; the renderer confirms with the user before
// calling this. If the deleted save was active/live, falls back to
// whatever save remains (if any) so the UI isn't left pointing at
// nothing.
function deleteSave(saveId) {
  if (!db || !saveId) return { success: false };

  db.run('DELETE FROM matches WHERE season_id IN (SELECT id FROM seasons WHERE save_id = ?);', [saveId]);
  db.run('DELETE FROM player_season_stats WHERE season_id IN (SELECT id FROM seasons WHERE save_id = ?);', [saveId]);
  db.run('DELETE FROM season_competition_results WHERE season_id IN (SELECT id FROM seasons WHERE save_id = ?);', [saveId]);
  db.run('DELETE FROM youth_academy_snapshot WHERE season_id IN (SELECT id FROM seasons WHERE save_id = ?);', [saveId]);
  db.run('DELETE FROM academy_graduate_overrides WHERE save_id = ?;', [saveId]);
  db.run('DELETE FROM transfer_fees WHERE save_id = ?;', [saveId]);
  db.run('DELETE FROM player_awards WHERE season_id IN (SELECT id FROM seasons WHERE save_id = ?);', [saveId]);
  db.run('DELETE FROM season_end_reviews WHERE save_id = ?;', [saveId]);
  db.run('DELETE FROM seasons WHERE save_id = ?;', [saveId]);
  db.run('DELETE FROM save_snapshots WHERE save_id = ?;', [saveId]);
  db.run('DELETE FROM saves WHERE id = ?;', [saveId]);
  saveDatabaseToDisk();
  console.log(`[Save] Deleted save ${saveId}.`);

  if (liveSyncedSaveId === saveId) liveSyncedSaveId = null;

  if (activeSaveId === saveId) {
    const remaining = db.exec('SELECT id FROM saves ORDER BY id ASC LIMIT 1;');
    activeSaveId = (remaining.length > 0 && remaining[0].values.length > 0) ? remaining[0].values[0][0] : null;
    currentSeasonId = activeSaveId ? getCurrentSeasonForSave(activeSaveId) : null;
  }

  return { success: true, fallback_save_id: activeSaveId };
}

// Permanently deletes a player and every row across every table that
// references their player_id — unlike deleteSave, this DOES touch the
// shared `players` table, since "delete this player" only makes sense
// as removing them entirely, not just from one save's view of them.
// Irreversible from the app's side; the renderer confirms with the user
// (and warns about the caveat below) before calling this. player_id is
// EA FC's own internal id, and importFifaData's sync upsert is a plain
// INSERT ... ON CONFLICT(player_id) DO UPDATE with no "was deliberately
// deleted" check — so if this player is still on the in-game squad, the
// very next Live Editor sync will simply re-create their row from
// scratch, with no memory of the deletion ever having happened.
function deletePlayer(playerId) {
  if (!db || !playerId) return { success: false };

  db.run('DELETE FROM player_season_stats WHERE player_id = ?;', [playerId]);
  db.run('DELETE FROM youth_academy_snapshot WHERE player_id = ?;', [playerId]);
  db.run('DELETE FROM season_league_stats WHERE player_id = ?;', [playerId]);
  db.run('DELETE FROM player_awards WHERE player_id = ?;', [playerId]);
  db.run('DELETE FROM former_player_snapshots WHERE player_id = ?;', [playerId]);
  db.run('DELETE FROM academy_graduate_overrides WHERE player_id = ?;', [playerId]);
  db.run('DELETE FROM transfer_fees WHERE player_id = ?;', [playerId]);
  db.run('DELETE FROM players WHERE player_id = ?;', [playerId]);
  saveDatabaseToDisk();
  console.log(`[Player] Deleted player ${playerId}.`);

  return { success: true };
}

// ------------------------------------------------------------------
// Refresh trigger
// ------------------------------------------------------------------

// Live Editor's export_all.lua is bound to a global F10 hotkey there —
// simulating that keypress (via a one-off PowerShell SendKeys call) is
// how the app triggers a re-export without the user alt-tabbing over
// and pressing it themselves. This only synthesizes a keystroke; the
// file watcher below picks up whatever Live Editor writes as a result.
//
// SendKeys always delivers to whatever window currently has OS focus —
// which is this app's own window when the user clicks the button, not
// the game. So the game window has to be brought to the foreground
// first (WScript.Shell's AppActivate, the standard SendKeys pairing)
// or the F10 keystroke never reaches Live Editor's hotkey handler at
// all. The companion window is refocused afterward so the user isn't
// left staring at the game.
const GAME_WINDOW_TITLE = 'EA SPORTS FC 26';

function triggerLiveEditorRefresh() {
  return new Promise(resolve => {
    const psCommand = [
      "$activated = (New-Object -ComObject WScript.Shell).AppActivate('" + GAME_WINDOW_TITLE + "');",
      "if (-not $activated) { Write-Output 'ACTIVATE_FAILED'; exit 1 }",
      "Start-Sleep -Milliseconds 150;",
      "Add-Type -AssemblyName System.Windows.Forms;",
      "[System.Windows.Forms.SendKeys]::SendWait('{F10}');"
    ].join(' ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], (err, stdout) => {
      if (mainWindow) mainWindow.focus();
      if (err || (stdout || '').includes('ACTIVATE_FAILED')) {
        console.error('[Refresh] Failed to send F10 hotkey — could not find/focus the game window ("' + GAME_WINDOW_TITLE + '"). Is the game running?', err ? err.message : '');
        resolve(false);
      } else {
        console.log('[Refresh] Focused game window and sent F10 — waiting on Live Editor to write updated export files.');
        resolve(true);
      }
    });
  });
}

// Renders the CURRENT page's print-media styles (see #season-overview-print
// and its @media print rules in index.html — the renderer fills that
// element with the summary content right before calling this) straight to
// a PDF file the user picks, via Electron's own PDF renderer — no external
// PDF library, and no OS print dialog detour either.
async function exportSeasonOverviewPdf(suggestedFileName) {
  if (!mainWindow) return { success: false };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Season Overview PDF',
    defaultPath: suggestedFileName || 'season-overview.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { success: false, canceled: true };

  try {
    // marginType 'none' hands full control of page margins to
    // #season-overview-print's own padding (see its @media print rules in
    // index.html) instead of stacking that padding on top of Chromium's
    // default print margins too — the double-margin was the main reason
    // content used to spill onto a second page.
    const pdfBuffer = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      pageSize: 'Letter',
      margins: { marginType: 'none' }
    });
    fs.writeFileSync(filePath, pdfBuffer);
    return { success: true, filePath };
  } catch (err) {
    console.error('[PDF Export] Failed to generate/save PDF:', err.message);
    return { success: false };
  }
}

// ------------------------------------------------------------------
// Electron boilerplate
// ------------------------------------------------------------------

function setupAutoUpdater() {
  // No app-update.yml exists outside a real electron-builder package, so
  // checking in a dev run (`npm start`) just throws — skip entirely there.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update ready',
      message: 'A new version of EA FC Companion App has been downloaded.',
      detail: 'Restart now to install it, or it will install automatically the next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error checking for updates:', err);
  });

  autoUpdater.checkForUpdates();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'EA FC Companion App',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
}

ipcMain.handle('get-squad-data', (_event, seasonId) => getSquadFromDB(seasonId || currentSeasonId));
ipcMain.handle('get-seasons-list', () => getSeasonsList());
ipcMain.handle('get-all-time-squad', () => getAllTimeSquadStats());
ipcMain.handle('get-past-players', () => getPastPlayers());
ipcMain.handle('get-player-history', (_event, playerId) => getPlayerHistory(playerId));
ipcMain.handle('trigger-refresh', () => triggerLiveEditorRefresh());
ipcMain.handle('get-career-totals', () => getCareerTotalsForSquad());
ipcMain.handle('get-manager-ppg', () => getManagerSeasonPPG());
ipcMain.handle('get-team-record-seasons', () => getTeamRecordSeasons());
ipcMain.handle('get-inferred-transfers', (_event, saveId) => getInferredTransfers(saveId));
ipcMain.handle('get-transfer-fees', (_event, saveId) => getTransferFees(saveId));
ipcMain.handle('get-player-transfer-history', (_event, playerId, saveId) => getPlayerTransferHistory(playerId, saveId));
ipcMain.handle('get-player-injury-history', (_event, playerId, saveId) => getPlayerInjuryHistory(playerId, saveId));
ipcMain.handle('set-injury-episode-type', (_event, episodeId, injuryTypeId) => setInjuryEpisodeType(episodeId, injuryTypeId));
ipcMain.handle('return-player-to-full-fitness', (_event, episodeId, endDate) => returnPlayerToFullFitness(episodeId, endDate));
ipcMain.handle('mark-player-currently-injured', (_event, playerId, startDate, injuryTypeId, saveId) => markPlayerCurrentlyInjured(playerId, startDate, injuryTypeId, saveId));
ipcMain.handle('delete-injury-episode', (_event, episodeId) => deleteInjuryEpisode(episodeId));
ipcMain.handle('update-injury-episode', (_event, episodeId, startDate, endDate, injuryTypeId) => updateInjuryEpisode(episodeId, startDate, endDate, injuryTypeId));
ipcMain.handle('get-player-contract-renewal', (_event, playerId, saveId) => getPlayerContractRenewal(playerId, saveId));
ipcMain.handle('get-saves-list', () => getSavesList());
ipcMain.handle('select-save', (_event, saveId) => selectSave(saveId));
ipcMain.handle('delete-save', (_event, saveId) => deleteSave(saveId));
ipcMain.handle('delete-player', (_event, playerId) => deletePlayer(playerId));
ipcMain.handle('get-season-competition-results', (_event, seasonId) => getSeasonCompetitionResults(seasonId));
ipcMain.handle('get-trophies-won', () => getTrophiesWon());
ipcMain.handle('get-youth-academy', (_event, saveId) => getYouthAcademy(saveId));
ipcMain.handle('enable-youth-mode', (_event, saveId) => enableYouthMode(saveId));
ipcMain.handle('clear-former-players', (_event, saveId) => clearFormerPlayers(saveId));
ipcMain.handle('get-pending-season-review', (_event, saveId) => getPendingSeasonReview(saveId));
ipcMain.handle('get-player-honours', (_event, playerId, saveId) => getPlayerHonours(playerId, saveId));
ipcMain.handle('acknowledge-season-review', (_event, reviewId) => acknowledgeSeasonReview(reviewId));
ipcMain.handle('get-league-stats-for-season', (_event, seasonId) => getLeagueStatsForSeason(seasonId));
ipcMain.handle('get-signed-players', (_event, saveId) => getSignedPlayers(saveId));
ipcMain.handle('mark-academy-graduate', (_event, playerId, saveId) => markAcademyGraduate(playerId, saveId));
ipcMain.handle('get-manual-play-styles', (_event, playerId) => getManualPlayStyles(playerId));
ipcMain.handle('set-manual-play-styles', (_event, playerId, styles) => setManualPlayStyles(playerId, styles));
ipcMain.handle('get-pending-season-overview', (_event, saveId) => getPendingSeasonOverview(saveId));
ipcMain.handle('acknowledge-season-overview', (_event, saveId, seasonId) => acknowledgeSeasonOverview(saveId, seasonId));
ipcMain.handle('get-season-alerts', (_event, saveId) => getSeasonAlerts(saveId));
ipcMain.handle('dismiss-may-reminder', (_event, saveId, seasonId) => dismissMayReminder(saveId, seasonId));
ipcMain.handle('get-season-overview-preview', (_event, saveId) => getSeasonOverviewPreview(saveId));
ipcMain.handle('export-season-overview-pdf', (_event, suggestedFileName) => exportSeasonOverviewPdf(suggestedFileName));

// ------------------------------------------------------------------
// Connected Career (optional sync module -- see connected_career/,
// which owns all of this feature's own logic). This only registers
// the functions it's allowed to reach into the app with, plus a few
// IPC handlers the Settings panel's "Connected Career" section calls
// through; it doesn't run anything on its own or affect normal app
// use otherwise.
// ------------------------------------------------------------------
try {
  const connectedCareer = require('./connected_career');
  connectedCareer.init({
    getSquadFromDB,
    getCurrentSeasonId: () => currentSeasonId,
    userDataPath: app.getPath('userData'),
  });
  ipcMain.handle('connected-career-status', () => connectedCareer.getStatus());
  ipcMain.handle('connected-career-join', (_event, code, owner) => connectedCareer.join(code, owner));
  ipcMain.handle('connected-career-sync-now', () => connectedCareer.syncNow());
  ipcMain.handle('connected-career-leave', () => connectedCareer.leave());
} catch (err) {
  console.error('[Connected Career] Failed to initialize -- Connected Career features unavailable this session.', err.message);
}

app.whenReady().then(async () => {
  await initDatabase();
  backfillSeasonLeagueNames();
  refreshCurrentSeasonFromCalendar();
  createWindow();
  setupAutoUpdater();

  mainWindow.webContents.once('did-finish-load', () => {
    if (fs.existsSync(calendarExportPath)) {
      try {
        const rawCalendar = fs.readFileSync(calendarExportPath, 'utf-8');
        const startupCalendarPayload = JSON.parse(rawCalendar);
        refreshLeagueTeamsFromCalendar(startupCalendarPayload);
        importCalendarMatches(startupCalendarPayload);
        persistSeasonCompetitionResults(startupCalendarPayload);
        syncSeasonLeagueNameFromResults(currentSeasonId);
        persistSeasonStandings(currentSeasonId, startupCalendarPayload.standings);
        checkSeasonFinalSavePoint(activeSaveId, currentSeasonId, startupCalendarPayload.current_date);
        saveSnapshotForActiveSave(rawCalendar);
        mainWindow.webContents.send('calendar-updated', { save_id: activeSaveId, data: startupCalendarPayload });
      } catch (err) {
        console.error('[Startup] Failed to load existing calendar export:', err);
      }
    }

    if (fs.existsSync(leagueStatsExportPath)) {
      try {
        const startupLeagueStats = JSON.parse(fs.readFileSync(leagueStatsExportPath, 'utf-8'));
        latestLeagueStatsPayload = startupLeagueStats;
        persistLeagueStats(resolveLeagueStatsSeasonId(startupLeagueStats), startupLeagueStats);
        mainWindow.webContents.send('league-stats-updated', { save_id: activeSaveId, data: startupLeagueStats.players || [], league_name: startupLeagueStats.league_name || null });
      } catch (err) {
        console.error('[Startup] Failed to load existing league stats export:', err);
      }
    }
  });

  const watcher = chokidar.watch([squadExportPath, calendarExportPath, transferExportPath, youthExportPath, leagueStatsExportPath], {
    persistent: true,
    usePolling: true,
    interval: 500
  });

  watcher.on('all', (event, filePath) => {
    if (event !== 'add' && event !== 'change') return;

    if (filePath.includes('ea_fc_calendar_export.json')) {
      if (fs.existsSync(calendarExportPath)) {
        try {
          const rawCalendar = fs.readFileSync(calendarExportPath, 'utf-8');
          const calendarPayload = JSON.parse(rawCalendar);

          // resolveActiveSave returns false when this sync had a blank
          // save_uid while a different save was already active (see its
          // comment) — importing this payload in that state risks writing
          // it into the wrong save's history, so skip it entirely.
          if (refreshCurrentSeasonFromCalendar(calendarPayload)) {
            refreshLeagueTeamsFromCalendar(calendarPayload);
            importCalendarMatches(calendarPayload);
            persistSeasonCompetitionResults(calendarPayload);
            syncSeasonLeagueNameFromResults(currentSeasonId);
            persistSeasonStandings(currentSeasonId, calendarPayload.standings);
            checkSeasonFinalSavePoint(activeSaveId, currentSeasonId, calendarPayload.current_date);
            saveSnapshotForActiveSave(rawCalendar);

            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('calendar-updated', { save_id: activeSaveId, data: calendarPayload });
            }
          }
        } catch (err) {
          console.error('[Watcher] Failed to process calendar export file:', err);
        }
      }
      return;
    }

    if (filePath.includes('ea_fc_squad_export.json') && fs.existsSync(squadExportPath)) {
      try {
        const rawData = fs.readFileSync(squadExportPath, 'utf-8');
        const jsonPayload = JSON.parse(rawData);

        importFifaData(jsonPayload);
        const squadData = getSquadFromDB();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('squad-updated', { save_id: activeSaveId, data: squadData });
        }
      } catch (err) {
        console.error('[Watcher] Failed to process export file:', err);
      }
    }

    if (filePath.includes('ea_fc_transfers_export.json') && fs.existsSync(transferExportPath)) {
      try {
        const rawTransfers = fs.readFileSync(transferExportPath, 'utf-8');
        const transferPayload = correctTransferFlags(JSON.parse(rawTransfers));
        persistTransferFees(activeSaveId, transferPayload);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('transfers-updated', { save_id: activeSaveId, data: transferPayload });
        }
      } catch (err) {
        console.error('[Watcher] Failed to process transfers export file:', err);
      }
    }

    if (filePath.includes('ea_fc_youth_export.json') && fs.existsSync(youthExportPath)) {
      try {
        const rawYouth = fs.readFileSync(youthExportPath, 'utf-8');
        importYouthAcademy(JSON.parse(rawYouth));

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('youth-updated', { save_id: activeSaveId, data: getYouthAcademy() });
        }
      } catch (err) {
        console.error('[Watcher] Failed to process youth academy export file:', err);
      }
    }

    // League-wide stats (see export_all.lua's LEAGUE STATS EXPORT block)
    // aren't persisted to the DB — this is live-only data, same pattern
    // as raw transfers/calendar payloads, not accumulated season history.
    // Browsing an inactive save won't show that save's own league stats
    // (no snapshot for this file yet), only whatever was last live.
    if (filePath.includes('ea_fc_league_stats_export.json') && fs.existsSync(leagueStatsExportPath)) {
      try {
        const rawLeagueStats = fs.readFileSync(leagueStatsExportPath, 'utf-8');
        const leagueStatsPayload = JSON.parse(rawLeagueStats);
        latestLeagueStatsPayload = leagueStatsPayload;
        persistLeagueStats(resolveLeagueStatsSeasonId(leagueStatsPayload), leagueStatsPayload);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('league-stats-updated', { save_id: activeSaveId, data: leagueStatsPayload.players || [], league_name: leagueStatsPayload.league_name || null });
        }
      } catch (err) {
        console.error('[Watcher] Failed to process league stats export file:', err);
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});