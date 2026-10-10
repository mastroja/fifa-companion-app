// Licensing configuration. Licensing is OFF (everything unlocked) until PUBLIC_KEY_PEM is filled in, so a development
// build, or a build made before you decide to charge, never locks anything.
//
// To turn it on:
//   1. node tools/license/gen-keys.js            (writes the private key OUTSIDE the repo, prints the public key)
//   2. paste the printed public key below
//   3. set SERVER_URL to where tools/license/server.js is hosted (for "Sign in with Patreon") and MEMBERSHIP_URL
//   4. update BUILD_DATE on every release (keys can say "valid for builds released up to <date>")
module.exports = {
  PUBLIC_KEY_PEM: 'MCowBQYDK2VwAyEAImcZFkXNuTniMM6DSKU8KOH4ZTzWWJuzNv66FfbsoZw=',
  SERVER_URL: '',        // e.g. https://license.example.com  — no trailing slash
  MEMBERSHIP_URL: '',    // e.g. https://www.patreon.com/yourname
  BUILD_DATE: '2026-10-08',

  // Everything not listed here is free. Add a feature here to make it Pro; remove it to make it free again.
  PRO_FEATURES: {
    'youth-mode': 'Youth Mode and the Challenge dashboard',
    'academy-tracker': 'Academy tracker and regen watchlist',
    'depth-extras': 'Reserves, custom lineups, All-Time XI and the what-if tool',
    'player-editor': 'Player editor'
  }
};
