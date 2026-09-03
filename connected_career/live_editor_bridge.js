// Strict interface boundary: the ONLY way the sync module changes
// anything in the live game. Same configure() pattern as app_bridge.js.
//
// IMPORTANT -- read before changing this file:
//
// There is no live RPC into Live Editor's Lua engine from this app. The
// only proven channel (see triggerLiveEditorRefresh() in main.js) is
// focusing the game window and sending the F10 hotkey, which Live Editor
// has bound to export_all.lua -- read direction only (game -> app).
//
// The write direction (app -> game) works the other way: applyPlayerUpdate
// below queues the change into a JSON file, and the user manually runs
// assets/apply_sync_updates.lua from Live Editor's own Lua Engine (NOT
// bound to any hotkey) to apply it via the sanctioned
// PlayerSetValueInDevelopementPlan API -- the same mechanism Live
// Editor's own in-game player editor uses internally. That script only
// affects players who have a development plan in that save, i.e. players
// on the squad the user actually manages there; anyone else is skipped
// and logged rather than force-written. See the
// feedback-live-editor-data-safety project memory for why raw DB-table
// writes (EditDBTableField) are avoided in favor of this sanctioned API.
//
// applyForcedResult() has no Lua/scriptable write path -- confirmed by
// exhaustive search of Live Editor's documented API and every bundled
// example script (2026-09-03): fixtures and standings are only ever read
// via raw memory struct offsets, never via a DB table, and nothing writes
// to either anywhere in Live Editor's own reference scripts.
//
// There IS a real way to set a fixture's score, though: Live Editor's own
// GUI has a "Fixtures" tab per team (Teams -> pick team -> Fixtures) with
// a pencil/edit icon on each *upcoming* (not-yet-played) fixture that lets
// you manually set its exact score ahead of time -- the user has already
// used this successfully with no crash. It only works on fixtures that
// haven't been played yet (already-played rows show no edit icon) --  it
// pre-determines a future result, it doesn't rewrite history. No function
// name or Lua binding for this action has been found, so it can't be
// automated the way applyPlayerUpdate can. applyForcedResult() therefore
// queues a human-readable checklist instead of a script the game runs --
// the user (or Gavin) works through it by hand in Live Editor's GUI.

const fs = require('fs');

const PENDING_WRITES_PATH = 'C:\\Users\\Public\\ea_fc_connected_career_pending_writes.json';
const PENDING_RESULT_FIXES_PATH = 'C:\\Users\\Public\\ea_fc_connected_career_pending_result_fixes.json';

let impl = null;

function configure(bridgeImpl) {
  impl = bridgeImpl;
}

function applyPlayerUpdate(record) {
  if (impl && impl.applyPlayerUpdate) {
    return impl.applyPlayerUpdate(record);
  }
  return queuePlayerUpdate(record);
}

// Default implementation: merge this player's update into the
// pending-writes file that apply_sync_updates.lua reads. Returns true once
// the write is queued -- NOT once it's actually applied in-game, since
// that step requires the user to manually run the Lua script.
function queuePlayerUpdate(record) {
  let queue = { players: [] };
  if (fs.existsSync(PENDING_WRITES_PATH)) {
    try {
      queue = JSON.parse(fs.readFileSync(PENDING_WRITES_PATH, 'utf8'));
    } catch (err) {
      queue = { players: [] };
    }
  }
  queue.players = (queue.players || []).filter(p => p.player_id !== record.playerId);
  queue.players.push({ player_id: record.playerId, attributes: record.attributes });
  fs.writeFileSync(PENDING_WRITES_PATH, JSON.stringify(queue, null, 2));
  return true;
}

function applyForcedResult(record) {
  if (impl && impl.applyForcedResult) {
    return impl.applyForcedResult(record);
  }
  return queueResultFix(record);
}

// Appends/merges this fixture into a checklist file -- not something the
// game applies automatically. The Connected Career UI is expected to
// render this list so the user can work through it by hand in Live
// Editor's Team Editor -> Fixtures tab. Returns true once queued, same
// "queued, not applied" contract as queuePlayerUpdate.
function queueResultFix(record) {
  let queue = { fixtures: [] };
  if (fs.existsSync(PENDING_RESULT_FIXES_PATH)) {
    try {
      queue = JSON.parse(fs.readFileSync(PENDING_RESULT_FIXES_PATH, 'utf8'));
    } catch (err) {
      queue = { fixtures: [] };
    }
  }
  queue.fixtures = (queue.fixtures || []).filter(f => f.fixtureId !== record.fixtureId);
  queue.fixtures.push(record);
  fs.writeFileSync(PENDING_RESULT_FIXES_PATH, JSON.stringify(queue, null, 2));
  return true;
}

module.exports = {
  configure,
  applyPlayerUpdate,
  applyForcedResult,
  PENDING_WRITES_PATH,
  PENDING_RESULT_FIXES_PATH,
};
