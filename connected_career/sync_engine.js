// Core sync loop: push this device's own squad up to Firebase, pull the
// other owner's squad down, and queue local write-backs for whichever of
// their players have changed since we last applied them.
//
// Scope, per the user's call on 2026-09-03: this only syncs attributes
// for players who are on THIS device's own managed squad locally --
// AI/CPU-controlled player growth is explicitly out of scope and isn't
// pushed or pulled. That scoping isn't even enforced here: it falls out
// naturally, because apply_sync_updates.lua already refuses to write any
// player who doesn't have a development plan in the local save (i.e.
// isn't on the locally managed squad) -- see live_editor_bridge.js.
//
// Results/league-table syncing (the other half of the diagram) isn't
// built yet -- there's no safe way to write a match result back into a
// save (see live_editor_bridge.js's applyForcedResult), so that side is
// expected to end up as a read-only combined view in the app's own UI,
// not a write-back into either save. Not started.

const appBridge = require('./app_bridge');
const liveEditorBridge = require('./live_editor_bridge');
const defaultFirebaseClient = require('./firebase_client');
const { createPlayerSyncRecord } = require('./models');

let leagueCode = null;
let ownerId = null; // this device's identity within the league, e.g. 'me' or 'gavin'
let otherOwnerId = null;
let firebaseClient = defaultFirebaseClient;

// playerId -> updatedAt of the last remote record we queued a write-back
// for, so a sync tick doesn't re-queue a player whose remote value hasn't
// changed since last time.
let lastAppliedAt = {};

function configure({ code, owner, firebaseClient: injectedClient } = {}) {
  leagueCode = code;
  ownerId = owner;
  otherOwnerId = owner === 'me' ? 'gavin' : 'me';
  if (injectedClient) firebaseClient = injectedClient;
  lastAppliedAt = {};
}

function extractAttributes(playerRow) {
  // player_season_stats.attributes_json already holds the individual
  // gameplay attributes (composure, standingtackle, ...) keyed by the
  // same field names Live Editor's "players" table uses -- see
  // live_editor_bridge.js / apply_sync_updates.lua.
  if (!playerRow.attributes_json) return {};
  try {
    return JSON.parse(playerRow.attributes_json);
  } catch (err) {
    return {};
  }
}

function toSyncRecords(playerRows) {
  const now = Date.now();
  return playerRows.map(row => createPlayerSyncRecord({
    playerId: row.player_id,
    ownerId,
    attributes: extractAttributes(row),
    overall: row.overall,
    potential: row.potential,
    updatedAt: now,
  }));
}

// Diff pure function -- no I/O -- kept separate so it can be unit tested
// directly against fixed input/output without touching Firebase or the DB.
function diffRemoteRecords(remoteRecords, appliedAtByPlayerId) {
  return remoteRecords.filter(r => (appliedAtByPlayerId[r.playerId] || 0) < r.updatedAt);
}

async function pushLocalSquad(playerIds) {
  if (!leagueCode || !ownerId) throw new Error('sync_engine not configured -- call configure({ code, owner }) first.');
  const playerRows = appBridge.getCurrentPlayerData(playerIds);
  const records = toSyncRecords(playerRows);
  await firebaseClient.writePlayers(leagueCode, ownerId, records);
  return records;
}

async function pullAndQueueRemoteUpdates() {
  if (!leagueCode || !ownerId) throw new Error('sync_engine not configured -- call configure({ code, owner }) first.');
  const remoteRecords = await firebaseClient.readPlayers(leagueCode, otherOwnerId);
  const toQueue = diffRemoteRecords(remoteRecords, lastAppliedAt);

  for (const record of toQueue) {
    liveEditorBridge.applyPlayerUpdate(record);
    lastAppliedAt[record.playerId] = record.updatedAt;
  }
  return toQueue;
}

async function runSyncCycle(playerIds) {
  await pushLocalSquad(playerIds);
  return pullAndQueueRemoteUpdates();
}

module.exports = {
  configure,
  pushLocalSquad,
  pullAndQueueRemoteUpdates,
  runSyncCycle,
  // exported for standalone/unit testing only
  diffRemoteRecords,
  toSyncRecords,
};
