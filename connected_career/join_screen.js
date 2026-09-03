// Owns the "join a league by code" state: persistence, and the join/
// leave/status/sync-now actions the renderer's Settings panel calls
// through main.js's IPC handlers. This is the only file in the feature
// that persists its own config to disk -- everything else stays
// stateless/in-memory, wired through app_bridge/live_editor_bridge.

const fs = require('fs');
const path = require('path');

let configPath = null;
let squadAccessors = null; // { getSquadFromDB, getCurrentSeasonId } -- from index.js's init()
let syncEngine = null;

let lastSyncOk = null; // null = never synced this session, true/false = last attempt result
let lastSyncAt = null;
let lastSyncError = null;

function configure({ userDataPath, accessors, engine }) {
  configPath = path.join(userDataPath, 'connected_career_join.json');
  squadAccessors = accessors;
  syncEngine = engine;

  const existing = loadConfig();
  if (existing) {
    syncEngine.configure({ code: existing.leagueCode, owner: existing.ownerId });
  }
}

function loadConfig() {
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function getStatus() {
  const cfg = loadConfig();
  return {
    joined: !!cfg,
    leagueCode: cfg ? cfg.leagueCode : null,
    ownerId: cfg ? cfg.ownerId : null,
    lastSyncOk,
    lastSyncAt,
    lastSyncError,
  };
}

async function join(leagueCode, ownerId) {
  if (!leagueCode || !leagueCode.trim()) throw new Error('League code is required.');
  if (ownerId !== 'me' && ownerId !== 'gavin') throw new Error('Invalid owner.');

  const cfg = { leagueCode: leagueCode.trim(), ownerId };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  syncEngine.configure({ code: cfg.leagueCode, owner: cfg.ownerId });
  lastSyncOk = null;
  lastSyncAt = null;
  lastSyncError = null;
  return getStatus();
}

function leave() {
  if (configPath && fs.existsSync(configPath)) fs.unlinkSync(configPath);
  lastSyncOk = null;
  lastSyncAt = null;
  lastSyncError = null;
  return getStatus();
}

async function syncNow() {
  const cfg = loadConfig();
  if (!cfg) throw new Error('Not joined to a Connected Career yet.');

  try {
    const playerIds = squadAccessors.getSquadFromDB(squadAccessors.getCurrentSeasonId())
      .map(p => p.player_id);
    const queued = await syncEngine.runSyncCycle(playerIds);
    lastSyncOk = true;
    lastSyncAt = Date.now();
    lastSyncError = null;
    return { ok: true, queuedCount: queued.length, status: getStatus() };
  } catch (err) {
    lastSyncOk = false;
    lastSyncAt = Date.now();
    lastSyncError = err.message;
    return { ok: false, error: err.message, status: getStatus() };
  }
}

module.exports = { configure, join, leave, getStatus, syncNow };
