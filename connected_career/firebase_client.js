// Firebase Realtime Database client -- free tier, one project the user
// owns and administers. Gavin (the other end of the sync) never touches
// this file, any config, or any API key directly -- the join flow
// (join_screen.js) only ever asks him for a league code.
//
// Uses the Firebase Web/Client SDK (not the Admin SDK) with Anonymous
// Auth, because this ships inside a distributed Electron app: an Admin
// SDK service-account key is a secret that grants full database access
// and must never be embedded in client software, whereas a Firebase web
// apiKey is not a secret -- access is controlled by Realtime Database
// Security Rules instead (scoped per league code below), which is what
// makes the "just enter a code, no accounts" join flow possible at all.
//
// TODO once the Firebase project exists (console.firebase.google.com):
//   1. Create the project (free Spark plan).
//   2. Enable Realtime Database (start in locked mode).
//   3. Enable Anonymous sign-in under Authentication -> Sign-in method.
//   4. Paste the web app config below (Project settings -> your apps ->
//      SDK setup and configuration). Safe to commit -- see note above.
//   5. Set Realtime Database rules so a league's subtree only opens up
//      once authenticated (anonymous is enough to start):
//      { "rules": { "leagues": { "$code": {
//          ".read": "auth != null", ".write": "auth != null" } } } }

const firebaseConfig = {
  apiKey: 'AIzaSyC6wii5LAnqeY10ISpDKREVBNeGwGzAJd4',
  authDomain: 'fc-26-connect-career.firebaseapp.com',
  databaseURL: 'https://fc-26-connect-career-default-rtdb.firebaseio.com',
  projectId: 'fc-26-connect-career',
  storageBucket: 'fc-26-connect-career.firebasestorage.app',
  messagingSenderId: '175132697521',
  appId: '1:175132697521:web:a17e8fed1cbaace3c7d390',
  // measurementId intentionally omitted -- firebase/analytics needs real
  // browser APIs (window, IndexedDB) this code doesn't have running inside
  // Electron's main process, and isn't useful for a two-person sync tool.
};

function isConfigured() {
  return !!firebaseConfig.databaseURL;
}

let dbPromise = null;

async function ensureInit() {
  if (!isConfigured()) {
    throw new Error('connected_career/firebase_client is not configured yet -- paste the Firebase project web config into firebaseConfig before using Connected Career sync.');
  }
  if (!dbPromise) {
    dbPromise = (async () => {
      const { initializeApp } = require('firebase/app');
      const { getDatabase } = require('firebase/database');
      const { getAuth, signInAnonymously } = require('firebase/auth');

      const app = initializeApp(firebaseConfig);
      const database = getDatabase(app);
      await signInAnonymously(getAuth(app));
      return database;
    })();
  }
  return dbPromise;
}

// Overwrites this owner's whole player list for the league -- callers
// always push a full current snapshot of their own squad, not a partial
// diff, so a record that no longer exists locally (e.g. a sold player)
// naturally drops out of the other side's next pull too.
async function writePlayers(leagueCode, ownerId, records) {
  const database = await ensureInit();
  const { ref, set } = require('firebase/database');
  const byPlayerId = {};
  for (const record of records) {
    byPlayerId[record.playerId] = record;
  }
  await set(ref(database, `leagues/${leagueCode}/players/${ownerId}`), byPlayerId);
}

async function readPlayers(leagueCode, ownerId) {
  const database = await ensureInit();
  const { ref, get } = require('firebase/database');
  const snapshot = await get(ref(database, `leagues/${leagueCode}/players/${ownerId}`));
  if (!snapshot.exists()) return [];
  return Object.values(snapshot.val());
}

// Full player rows -- the complete raw "players" table row (all ~90
// fields, see export_player_full_row.lua) plus a name entry, needed to
// CreatePlayer() a mirror of this player in another save. Separate path
// from writePlayers/readPlayers above (the lightweight attribute-only
// sync) since full rows are much bigger and only need pushing once per
// player, not on every sync tick.
async function writeFullRows(leagueCode, ownerId, records) {
  const database = await ensureInit();
  const { ref, update } = require('firebase/database');
  const updates = {};
  for (const record of records) {
    updates[record.player_id] = record;
  }
  await update(ref(database, `leagues/${leagueCode}/full_rows/${ownerId}`), updates);
}

async function readFullRows(leagueCode, ownerId) {
  const database = await ensureInit();
  const { ref, get } = require('firebase/database');
  const snapshot = await get(ref(database, `leagues/${leagueCode}/full_rows/${ownerId}`));
  if (!snapshot.exists()) return [];
  return Object.values(snapshot.val());
}

// Tracks the REAL mapping from a source player_id (as pushed by the
// other owner) to the actual local player_id THIS save ended up using
// for their mirrored copy -- not always the same number. create_mirrored_
// players.lua resolves this live (PlayerExists/GetPlayerName checks it
// alone can do), reporting back "direct" (no collision, same id), "offset"
// (collided, used sourceId + a multiple of 100000 instead), or
// "already_present" (an existing player already matches by name -- no
// create needed, but still maps 1:1 so attribute sync knows where to
// write). Keyed by the save's OWN ownerId -- "players I have mirrored
// in", not "players I've sent out". This is also what makes attribute
// sync (pullAndQueueRemoteUpdates in sync_engine.js) safe post-mirroring:
// it only ever writes to a player_id recorded here, never a raw,
// unverified source id.
async function writeMirrorMappings(leagueCode, ownerId, mappings) {
  const database = await ensureInit();
  const { ref, update } = require('firebase/database');
  const updates = {};
  for (const [sourcePid, localPid] of Object.entries(mappings)) {
    updates[sourcePid] = localPid;
  }
  await update(ref(database, `leagues/${leagueCode}/mirrored/${ownerId}`), updates);
}

async function readMirrorMappings(leagueCode, ownerId) {
  const database = await ensureInit();
  const { ref, get } = require('firebase/database');
  const snapshot = await get(ref(database, `leagues/${leagueCode}/mirrored/${ownerId}`));
  if (!snapshot.exists()) return new Map();
  const val = snapshot.val();
  return new Map(Object.entries(val).map(([sourcePid, localPid]) => [Number(sourcePid), Number(localPid)]));
}

module.exports = {
  writePlayers,
  readPlayers,
  writeFullRows,
  readFullRows,
  writeMirrorMappings,
  readMirrorMappings,
  isConfigured,
};
