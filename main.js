const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const initSqlJs = require('sql.js');
const { execFile } = require('child_process');

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
    ['play_styles_json', 'TEXT']
  ];
  seasonStatsMigrations.forEach(([column, type]) => {
    try {
      db.run(`ALTER TABLE player_season_stats ADD COLUMN ${column} ${type};`);
    } catch (e) {
      // column already exists, safe to ignore
    }
  });

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
      if (!comp.name) return;
      stmt.run([currentSeasonId, comp.name, comp.standing || '']);
    });
  } finally {
    stmt.free();
  }

  saveDatabaseToDisk();
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

// Current youth academy roster for a save — see importYouthAcademy.
// potential_low/potential_high are a deliberate range, not the exact
// potential (see export_all.lua's YOUTH ACADEMY EXPORT block for why).
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
  const everInAcademy = new Set();
  const academyRes = db.exec(`
    SELECT DISTINCT y.player_id FROM youth_academy_snapshot y
    JOIN seasons se ON se.id = y.season_id
    WHERE se.save_id = ${saveId};
  `);
  if (academyRes.length > 0) {
    academyRes[0].values.forEach(([pid]) => everInAcademy.add(pid));
  }

  const results = [];

  currentActive.forEach(id => {
    if (previousActive.has(id)) return;
    const info = currentRows.get(id);
    const isLoanIn = info.on_loan && info.loan_club_name;
    const isAcademyGraduate = everInAcademy.has(id);
    results.push({
      player_name: info.name,
      from_team: isAcademyGraduate ? 'Academy' : (isLoanIn ? info.loan_club_name : 'Unknown Club'),
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

// Resolves which save a sync belongs to (via save_uid — see
// getOrCreateSaveByUID) and which season within it, setting
// activeSaveId/currentSeasonId to match. This is the "auto-detect" half
// of multi-save support: every sync points the app at whichever save is
// actually loaded in-game, regardless of whether it was the squad or
// calendar file that triggered it.
function resolveActiveSave(uid, managerName, clubName, dateForSeasonLabel) {
  const saveId = getOrCreateSaveByUID(uid, managerName, clubName);
  activeSaveId = saveId;
  liveSyncedSaveId = saveId;

  const seasonLabel = computeSeasonLabel(dateForSeasonLabel);
  currentSeasonId = getOrCreateSeason(saveId, seasonLabel);
  db.run('UPDATE seasons SET is_current = 1 WHERE id = ?;', [currentSeasonId]);
  db.run('UPDATE seasons SET is_current = 0 WHERE id != ? AND save_id = ?;', [
    currentSeasonId,
    saveId
  ]);
  saveDatabaseToDisk();
  console.log(`[Season] Save ${saveId}, season "${seasonLabel}" (id ${currentSeasonId})`);
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

  resolveActiveSave(
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
  }

  db.run('BEGIN TRANSACTION;');
  try {
    const playerStmt = db.prepare(`
      INSERT INTO players (player_id, name, position_id, nationality, dob, height, weight, preferred_foot, photo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET
        name=excluded.name,
        position_id=excluded.position_id,
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
         goals, assists, appearances, clean_sheets, saves, yellow_cards, red_cards, avg_rating,
         attributes_json, competitions_json, traits_json, play_styles_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
        updated_at=CURRENT_TIMESTAMP;
    `);

    jsonPayload.players.forEach(p => {
      playerStmt.run([
        p.player_id,
        p.name || 'Unknown',
        p.position_id || 0,
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
        JSON.stringify(p.play_styles || [])
      ]);
    });

    playerStmt.free();
    statsStmt.free();
    db.run('COMMIT;');
    saveDatabaseToDisk();
    console.log(`[DB] Synced ${jsonPayload.players.length} players into season ${currentSeasonId} (history preserved).`);
  } catch (err) {
    db.run('ROLLBACK;');
    console.error('[DB] Transaction failed, rolled back changes:', err);
  }
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
    SELECT p.player_id, p.name, p.position_id, p.nationality, p.dob, p.height, p.weight,
           p.preferred_foot, p.photo_id,
           s.overall, s.potential, s.skill_moves, s.weak_foot, s.club_id, s.club_name, s.contract_expiry,
           s.contract_date, s.duration_months, s.player_role_, s.last_status_change_date,
           s.on_loan, s.loan_team_from, s.loan_club_name, s.loan_date_end, s.is_loan_to_buy, s.wage,
           s.goals, s.assists, s.appearances, s.clean_sheets, s.saves,
           s.yellow_cards, s.red_cards, s.avg_rating, s.attributes_json, s.competitions_json,
           s.traits_json, s.play_styles_json, s.updated_at
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
    nationality: row[3],
    dob: row[4],
    height: row[5],
    weight: row[6],
    preferred_foot: row[7],
    photo_id: row[8],
    overall: row[9],
    potential: row[10],
    skill_moves: row[11],
    weak_foot: row[12],
    club_id: row[13],
    club_name: row[14],
    contract_expiry: row[15],
    contract_date: row[16],
    duration_months: row[17],
    player_role_: row[18],
    last_status_change_date: row[19],
    on_loan: row[20] === 1,
    loan_team_from: row[21],
    loan_club_name: row[22],
    loan_date_end: row[23],
    is_loan_to_buy: row[24] === 1,
    wage: row[25],
    goals: row[26],
    assists: row[27],
    appearances: row[28],
    clean_sheets: row[29],
    saves: row[30],
    yellow_cards: row[31],
    red_cards: row[32],
    avg_rating: row[33],
    attributes: JSON.parse(row[34] || '{}'),
    competitions: JSON.parse(row[35] || '[]'),
    traits: JSON.parse(row[36] || '[]'),
    play_styles: JSON.parse(row[37] || '[]'),
    updated_at: row[38]
  }));
}

// Season list for the Squad Stats selector (current save only).
function getSeasonsList(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`SELECT id, year_label, is_current FROM seasons WHERE save_id = ${saveId} ORDER BY year_label ASC;`);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({ id: row[0], year_label: row[1], is_current: row[2] === 1 }));
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

// "All Time" squad view: current roster's bio/contract/club info (same as
// getSquadFromDB for the current season), but goals/assists/appearances/etc
// summed across every season each player has been with the club, and
// avg_rating as an appearances-weighted average across those seasons —
// same aggregation pattern already used client-side for a player's
// competitions breakdown. Scoped to this save specifically (a player_id
// is a global EA FC id — the same real player could theoretically show
// up in a different save too, so the aggregation must not cross saves).
function getAllTimeSquadStats(saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const seasonId = getCurrentSeasonForSave(saveId);
  if (!seasonId) return [];

  const res = db.exec(`
    SELECT p.player_id, p.name, p.position_id, p.nationality, p.dob, p.height, p.weight,
           p.preferred_foot, p.photo_id,
           cur.overall, cur.potential, cur.skill_moves, cur.weak_foot, cur.club_id, cur.club_name, cur.contract_expiry,
           cur.contract_date, cur.duration_months, cur.player_role_, cur.last_status_change_date,
           cur.on_loan, cur.loan_team_from, cur.loan_club_name, cur.loan_date_end, cur.is_loan_to_buy, cur.wage,
           cur.attributes_json, cur.competitions_json, cur.traits_json, cur.play_styles_json,
           SUM(s.goals) as t_goals, SUM(s.assists) as t_assists, SUM(s.appearances) as t_apps,
           SUM(s.clean_sheets) as t_cs, SUM(s.saves) as t_saves,
           SUM(s.yellow_cards) as t_yellow, SUM(s.red_cards) as t_red,
           SUM(s.avg_rating * s.appearances) as t_rating_weighted,
           cur.updated_at
    FROM players p
    JOIN player_season_stats cur ON cur.player_id = p.player_id AND cur.season_id = ${seasonId}
    JOIN player_season_stats s ON s.player_id = p.player_id
    JOIN seasons se2 ON se2.id = s.season_id AND se2.save_id = ${saveId}
    GROUP BY p.player_id
    ORDER BY cur.overall DESC;
  `);

  if (res.length === 0) return [];

  return res[0].values.map(row => {
    const totalApps = row[32] || 0;
    return {
      player_id: row[0], name: row[1], position_id: row[2], nationality: row[3], dob: row[4],
      height: row[5], weight: row[6], preferred_foot: row[7], photo_id: row[8],
      overall: row[9], potential: row[10], skill_moves: row[11], weak_foot: row[12],
      club_id: row[13], club_name: row[14], contract_expiry: row[15], contract_date: row[16],
      duration_months: row[17], player_role_: row[18], last_status_change_date: row[19],
      on_loan: row[20] === 1, loan_team_from: row[21], loan_club_name: row[22], loan_date_end: row[23],
      is_loan_to_buy: row[24] === 1, wage: row[25],
      attributes: JSON.parse(row[26] || '{}'), competitions: JSON.parse(row[27] || '[]'),
      traits: JSON.parse(row[28] || '[]'), play_styles: JSON.parse(row[29] || '[]'),
      goals: row[30] || 0, assists: row[31] || 0, appearances: totalApps,
      clean_sheets: row[33] || 0, saves: row[34] || 0, yellow_cards: row[35] || 0, red_cards: row[36] || 0,
      avg_rating: totalApps > 0 ? (row[37] || 0) / totalApps : 0,
      updated_at: row[38]
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
    SELECT player_id, club_id FROM player_season_stats WHERE season_id = ${currentSeasonForSave};
  `);
  const currentClubById = new Map();
  if (currentRes.length > 0) {
    currentRes[0].values.forEach(([player_id, club_id]) => currentClubById.set(player_id, club_id));
  }

  // The user's own team id, same trick as getInferredTransfers: whichever
  // club_id shows up on a non-loan row.
  const bioRes = db.exec(`
    SELECT player_id, club_id, on_loan FROM player_season_stats WHERE season_id = ${currentSeasonForSave};
  `);
  let userTeamId = null;
  if (bioRes.length > 0) {
    for (const [, club_id, on_loan] of bioRes[0].values) {
      if (!on_loan) { userTeamId = club_id; break; }
    }
  }
  if (userTeamId === null) return [];

  // Every player who was ever "ours" (club_id === userTeamId) in ANY
  // season OF THIS SAVE, with their most recent such row. Team ids are
  // global to the game (e.g. Arsenal is always id 1), so scoping to
  // se.save_id matters here — without it, a second save also involving
  // the same club would mix its past players into this one's list.
  const pastRes = db.exec(`
    SELECT p.player_id, p.name, p.position_id, p.dob, s.overall, s.potential, s.wage,
           s.club_id, se.year_label, s.season_id
    FROM player_season_stats s
    JOIN players p ON p.player_id = s.player_id
    JOIN seasons se ON se.id = s.season_id
    WHERE s.club_id = ${userTeamId} AND se.save_id = ${saveId}
    ORDER BY s.season_id ASC;
  `);
  if (pastRes.length === 0) return [];

  const lastKnown = new Map();
  pastRes[0].values.forEach(row => {
    const [player_id, name, position_id, dob, overall, potential, wage, club_id, year_label, season_id] = row;
    lastKnown.set(player_id, { player_id, name, position_id, dob, overall, potential, wage, year_label, season_id });
  });

  const watchlistStatus = readWatchlistStatus();

  const results = [];
  lastKnown.forEach((info, playerId) => {
    const stillOursNow = currentClubById.get(playerId) === userTeamId;
    if (stillOursNow) return; // still on the current roster, not a "past" player

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

    results.push({
      player_id: info.player_id,
      name: info.name,
      position_id: info.position_id,
      dob: info.dob,
      overall: live ? live.overall : info.overall,
      potential: live ? live.potential : info.potential,
      overall_is_live: !!live,
      wage_at_departure: info.wage,
      departed_season: info.year_label,
      current_club: currentClub
    });
  });

  // Only meaningful for the save Live Editor actually has loaded right
  // now — writing it for a save being browsed in the background would
  // either be pointless (Lua can't look up a save that isn't active) or
  // would clobber the active save's watchlist.
  if (saveId === activeSaveId) {
    writeWatchlistFile(results.map(r => r.player_id));
  }

  return results;
}

// Full multi-season history for one player — this is the whole point.
// Scoped to a save (player_id is a global EA FC id, so the same real
// player could exist in more than one save's history).
function getPlayerHistory(playerId, saveId = activeSaveId) {
  if (!db || !saveId) return [];
  const res = db.exec(`
    SELECT se.year_label, s.overall, s.potential, s.goals, s.assists, s.appearances,
           s.clean_sheets, s.avg_rating, s.attributes_json, s.competitions_json
    FROM player_season_stats s
    JOIN seasons se ON se.id = s.season_id
    WHERE s.player_id = ${playerId} AND se.save_id = ${saveId}
    ORDER BY se.id ASC;
  `);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({
    season: row[0],
    overall: row[1],
    potential: row[2],
    goals: row[3],
    assists: row[4],
    appearances: row[5],
    clean_sheets: row[6],
    avg_rating: row[7],
    attributes: JSON.parse(row[8] || '{}'),
    competitions: JSON.parse(row[9] || '[]')
  }));
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
    SELECT s.id, s.club_name, s.manager_name, s.save_uid, ss.synced_at
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
    is_live: row[0] === liveSyncedSaveId
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
    youth_academy: getYouthAcademy(saveId)
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

// ------------------------------------------------------------------
// Refresh trigger
// ------------------------------------------------------------------

// Live Editor's export_all.lua is bound to a global F10 hotkey there —
// simulating that keypress (via a one-off PowerShell SendKeys call) is
// how the app triggers a re-export without the user alt-tabbing over
// and pressing it themselves. This only synthesizes a keystroke; the
// file watcher below picks up whatever Live Editor writes as a result.
function triggerLiveEditorRefresh() {
  return new Promise(resolve => {
    const psCommand = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{F10}')";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], (err) => {
      if (err) {
        console.error('[Refresh] Failed to send F10 hotkey:', err.message);
        resolve(false);
      } else {
        console.log('[Refresh] Sent F10 — waiting on Live Editor to write updated export files.');
        resolve(true);
      }
    });
  });
}

// ------------------------------------------------------------------
// Electron boilerplate
// ------------------------------------------------------------------

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
ipcMain.handle('get-inferred-transfers', () => getInferredTransfers());
ipcMain.handle('get-saves-list', () => getSavesList());
ipcMain.handle('select-save', (_event, saveId) => selectSave(saveId));
ipcMain.handle('delete-save', (_event, saveId) => deleteSave(saveId));
ipcMain.handle('get-season-competition-results', (_event, seasonId) => getSeasonCompetitionResults(seasonId));
ipcMain.handle('get-trophies-won', () => getTrophiesWon());
ipcMain.handle('get-youth-academy', () => getYouthAcademy());

app.whenReady().then(async () => {
  await initDatabase();
  refreshCurrentSeasonFromCalendar();
  createWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    if (fs.existsSync(calendarExportPath)) {
      try {
        const rawCalendar = fs.readFileSync(calendarExportPath, 'utf-8');
        const startupCalendarPayload = JSON.parse(rawCalendar);
        refreshLeagueTeamsFromCalendar(startupCalendarPayload);
        importCalendarMatches(startupCalendarPayload);
        persistSeasonCompetitionResults(startupCalendarPayload);
        saveSnapshotForActiveSave(rawCalendar);
        mainWindow.webContents.send('calendar-updated', startupCalendarPayload);
      } catch (err) {
        console.error('[Startup] Failed to load existing calendar export:', err);
      }
    }
  });

  const watcher = chokidar.watch([squadExportPath, calendarExportPath, transferExportPath, youthExportPath], {
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

          refreshCurrentSeasonFromCalendar(calendarPayload);
          refreshLeagueTeamsFromCalendar(calendarPayload);
          importCalendarMatches(calendarPayload);
          persistSeasonCompetitionResults(calendarPayload);
          saveSnapshotForActiveSave(rawCalendar);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('calendar-updated', calendarPayload);
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
          mainWindow.webContents.send('squad-updated', squadData);
        }
      } catch (err) {
        console.error('[Watcher] Failed to process export file:', err);
      }
    }

    if (filePath.includes('ea_fc_transfers_export.json') && fs.existsSync(transferExportPath)) {
      try {
        const rawTransfers = fs.readFileSync(transferExportPath, 'utf-8');
        const transferPayload = correctTransferFlags(JSON.parse(rawTransfers));

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('transfers-updated', transferPayload);
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
          mainWindow.webContents.send('youth-updated', getYouthAcademy());
        }
      } catch (err) {
        console.error('[Watcher] Failed to process youth academy export file:', err);
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});