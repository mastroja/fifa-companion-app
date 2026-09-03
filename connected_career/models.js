// Plain data shapes shared between app_bridge, live_editor_bridge, and
// sync_engine. Kept as factory functions (not classes) since this only
// needs to catch obvious mistakes early -- both Firebase and the game DB
// are loosely typed already.

function createPlayerSyncRecord({ playerId, ownerId, attributes, overall, potential, updatedAt }) {
  if (!playerId) throw new Error('PlayerSyncRecord requires playerId');
  return {
    playerId,
    ownerId, // 'me' | 'gavin' -- whose save this record came from
    attributes: attributes || {}, // e.g. { composure: 99, standingtackle: 19 } -- same field names as Live Editor's "players" table, see live_editor_bridge.js
    overall,
    potential,
    updatedAt: updatedAt || Date.now(),
  };
}

function createResultRecord({ ownerId, fixtureId, homeTeamId, awayTeamId, homeScore, awayScore, seasonId }) {
  if (homeScore == null || awayScore == null) throw new Error('ResultRecord requires homeScore and awayScore');
  return {
    ownerId,
    fixtureId,
    homeTeamId,
    awayTeamId,
    homeScore,
    awayScore,
    seasonId,
  };
}

module.exports = { createPlayerSyncRecord, createResultRecord };
