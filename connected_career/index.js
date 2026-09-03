// Single entry point main.js touches for Connected Career -- keeps this
// feature's footprint in main.js down to a handful of one-line IPC
// handlers that just delegate here. Everything else (the bridge wiring,
// sync logic, Firebase client, join-state persistence, the Lua
// write-back script) lives inside this folder so the feature stays
// separate and easy to manage independently of the rest of the app.

const appBridge = require('./app_bridge');
const liveEditorBridge = require('./live_editor_bridge');
const syncEngine = require('./sync_engine');
const joinScreen = require('./join_screen');

function init({ getSquadFromDB, getCurrentSeasonId, userDataPath }) {
  appBridge.configure({
    getCurrentPlayerData: (playerIds) => {
      const idSet = new Set(playerIds);
      return getSquadFromDB(getCurrentSeasonId()).filter(p => idSet.has(p.player_id));
    },
  });
  liveEditorBridge.configure({});
  joinScreen.configure({
    userDataPath,
    accessors: { getSquadFromDB, getCurrentSeasonId },
    engine: syncEngine,
  });
}

module.exports = {
  init,
  join: (code, owner) => joinScreen.join(code, owner),
  leave: () => joinScreen.leave(),
  getStatus: () => joinScreen.getStatus(),
  syncNow: () => joinScreen.syncNow(),
};
