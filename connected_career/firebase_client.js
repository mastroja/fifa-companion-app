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

module.exports = { writePlayers, readPlayers, isConfigured };
