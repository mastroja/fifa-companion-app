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

// Only ever writes to a player_id that's been through the mirroring
// process and has a confirmed local mapping (see the "Mirroring" section
// below) -- a remote record for a player we haven't mirrored in yet is
// skipped, not written to its raw source id, since that id might not
// exist here at all or might belong to someone else entirely (the
// Sebastian Nixon problem this whole mapping system exists to prevent).
async function pullAndQueueRemoteUpdates() {
  if (!leagueCode || !ownerId) throw new Error('sync_engine not configured -- call configure({ code, owner }) first.');
  const remoteRecords = await firebaseClient.readPlayers(leagueCode, otherOwnerId);
  const toQueue = diffRemoteRecords(remoteRecords, lastAppliedAt);
  const mirrorMap = await firebaseClient.readMirrorMappings(leagueCode, ownerId);

  const applied = [];
  for (const record of toQueue) {
    const localId = mirrorMap.get(record.playerId);
    if (localId === undefined) {
      continue; // not mirrored in here yet -- nothing safe to write to
    }
    liveEditorBridge.applyPlayerUpdate({ ...record, playerId: localId });
    lastAppliedAt[record.playerId] = record.updatedAt;
    applied.push(record);
  }
  return applied;
}

async function runSyncCycle(playerIds) {
  await pushLocalSquad(playerIds);
  return pullAndQueueRemoteUpdates();
}

// ------------------------------------------------------------------
// Mirroring -- creating each side's generated players in the other's
// save via CreatePlayer, so player_id becomes a stable, intentionally-
// established cross-save key instead of a coincidence (see the
// project's connected-career-architecture memory on why this exists:
// the Sebastian Nixon incident, and CreatePlayer being confirmed safe
// as long as it's given a real, captured headassetid). Three manual
// steps, same pattern as the rest of this project -- nothing here is
// automatic yet:
//   1. requestFullRowExport(playerIds) -> user runs
//      export_player_full_row.lua -> readFullRowExport() has data
//   2. pushFullRows() -> uploads that to Firebase
//   3. pullAndPrepareMirrorCreates() -> reads the OTHER owner's full
//      rows, skips anything already mirrored in per Firebase's
//      "mirrored" tracking, queues the rest -> user runs
//      create_mirrored_players.lua
//   4. confirmMirrorResults() -> reads the REAL source_id -> local_id
//      mapping create_mirrored_players.lua resolved (direct/offset/
//      already_present -- only Lua can determine this, via live
//      PlayerExists/GetPlayerName checks) and persists it to Firebase.
//      Only ids that have been through this step are ever written to
//      by pullAndQueueRemoteUpdates above.
// ------------------------------------------------------------------

function requestFullRowExport(playerIds) {
  return liveEditorBridge.requestFullRowExport(playerIds);
}

async function pushFullRows() {
  if (!leagueCode || !ownerId) throw new Error('sync_engine not configured -- call configure({ code, owner }) first.');
  const rows = liveEditorBridge.readFullRowExport();
  if (rows.length === 0) return [];
  await firebaseClient.writeFullRows(leagueCode, ownerId, rows);
  return rows;
}

async function pullAndPrepareMirrorCreates() {
  if (!leagueCode || !ownerId) throw new Error('sync_engine not configured -- call configure({ code, owner }) first.');
  const remoteFullRows = await firebaseClient.readFullRows(leagueCode, otherOwnerId);
  const alreadyMirrored = await firebaseClient.readMirrorMappings(leagueCode, ownerId);
  const toCreate = remoteFullRows.filter(r => !alreadyMirrored.has(r.player_id));

  if (toCreate.length > 0) {
    liveEditorBridge.queueMirrorCreates(toCreate);
  }
  return toCreate;
}

// Reads the REAL mapping create_mirrored_players.lua resolved (only Lua
// can determine this -- see that script) and persists it to Firebase.
// Call this after the user has actually run that script, not before --
// unlike pushLocalSquad/pullAndQueueRemoteUpdates, there's nothing to
// mark optimistically here since the whole point of this mapping is
// that Node can't know it in advance.
async function confirmMirrorResults() {
  if (!leagueCode || !ownerId) throw new Error('sync_engine not configured -- call configure({ code, owner }) first.');
  const results = liveEditorBridge.readMirrorCreateResults();
  const entries = Object.entries(results);
  if (entries.length === 0) return {};
  await firebaseClient.writeMirrorMappings(leagueCode, ownerId, results);
  return results;
}

module.exports = {
  configure,
  pushLocalSquad,
  pullAndQueueRemoteUpdates,
  runSyncCycle,
  requestFullRowExport,
  pushFullRows,
  pullAndPrepareMirrorCreates,
  confirmMirrorResults,
  // exported for standalone/unit testing only
  diffRemoteRecords,
  toSyncRecords,
};
