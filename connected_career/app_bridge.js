// Strict interface boundary: this is the ONLY way the sync module reads
// data from the rest of the app. main.js calls configure() once at
// startup with a real implementation backed by its own DB functions
// (getSquadFromDB, etc.) -- this file never requires main.js or touches
// its sqlite `db` directly, so the sync module has no path into the
// app's internals beyond what main.js explicitly hands it here.

let impl = null;

function configure(bridgeImpl) {
  impl = bridgeImpl;
}

function getCurrentPlayerData(playerIds) {
  if (!impl) {
    throw new Error('connected_career/app_bridge not configured -- main.js must call configure() before Connected Career features are used.');
  }
  return impl.getCurrentPlayerData(playerIds);
}

module.exports = { configure, getCurrentPlayerData };
