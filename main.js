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

// Cached season context, refreshed whenever the calendar export updates.
// Everything defaults to a single save (id 1) for now — multi-save
// selection is a later problem, not part of this fix.
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

function getOrCreateDefaultSave() {
  const res = db.exec('SELECT id FROM saves LIMIT 1;');
  if (res.length > 0 && res[0].values.length > 0) {
    return res[0].values[0][0];
  }
  db.run(`INSERT INTO saves (manager_name, club_name) VALUES (?, ?);`, [
    'Manager',
    'My Club'
  ]);
  const inserted = db.exec('SELECT id FROM saves ORDER BY id DESC LIMIT 1;');
  return inserted[0].values[0][0];
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

function refreshCurrentSeasonFromCalendar() {
  const saveId = getOrCreateDefaultSave();
  let seasonLabel = computeSeasonLabel(null); // fallback: today's date

  if (fs.existsSync(calendarExportPath)) {
    try {
      const raw = fs.readFileSync(calendarExportPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.current_date) {
        seasonLabel = computeSeasonLabel(parsed.current_date);
      }
    } catch (err) {
      console.warn('[Season] Could not parse calendar export, using system date fallback:', err.message);
    }
  }

  currentSeasonId = getOrCreateSeason(saveId, seasonLabel);
  db.run('UPDATE seasons SET is_current = 1 WHERE id = ?;', [currentSeasonId]);
  db.run('UPDATE seasons SET is_current = 0 WHERE id != ? AND save_id = ?;', [
    currentSeasonId,
    saveId
  ]);
  saveDatabaseToDisk();
  console.log(`[Season] Current season resolved to "${seasonLabel}" (id ${currentSeasonId})`);
}

// ------------------------------------------------------------------
// Import
// ------------------------------------------------------------------

function importFifaData(jsonPayload) {
  if (!db || !jsonPayload || !Array.isArray(jsonPayload.players)) {
    console.warn('[DB] Invalid payload or players list empty.');
    return;
  }

  if (!currentSeasonId) {
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
           s.traits_json, s.play_styles_json
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
    play_styles: JSON.parse(row[37] || '[]')
  }));
}

// Full multi-season history for one player — this is the whole point
function getPlayerHistory(playerId) {
  if (!db) return [];
  const res = db.exec(`
    SELECT se.year_label, s.overall, s.potential, s.goals, s.assists, s.appearances,
           s.clean_sheets, s.avg_rating, s.attributes_json
    FROM player_season_stats s
    JOIN seasons se ON se.id = s.season_id
    WHERE s.player_id = ${playerId}
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
    attributes: JSON.parse(row[8] || '{}')
  }));
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

ipcMain.handle('get-squad-data', () => getSquadFromDB());
ipcMain.handle('get-player-history', (_event, playerId) => getPlayerHistory(playerId));
ipcMain.handle('trigger-refresh', () => triggerLiveEditorRefresh());

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
        mainWindow.webContents.send('calendar-updated', startupCalendarPayload);
      } catch (err) {
        console.error('[Startup] Failed to load existing calendar export:', err);
      }
    }
  });

  const watcher = chokidar.watch([squadExportPath, calendarExportPath, transferExportPath], {
    persistent: true,
    usePolling: true,
    interval: 500
  });

  watcher.on('all', (event, filePath) => {
    if (event !== 'add' && event !== 'change') return;

    if (filePath.includes('ea_fc_calendar_export.json')) {
      refreshCurrentSeasonFromCalendar();

      if (fs.existsSync(calendarExportPath)) {
        try {
          const rawCalendar = fs.readFileSync(calendarExportPath, 'utf-8');
          const calendarPayload = JSON.parse(rawCalendar);
          refreshLeagueTeamsFromCalendar(calendarPayload);

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
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});