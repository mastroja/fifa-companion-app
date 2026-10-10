// Insights > Squad: the shape of the current squad in one place.
//  - Age vs overall: every senior player as a dot (size = wage, colour = position group) over a shaded peak-age band,
//    with the best-11 level as a reference line, and the squad split into Core / Prospects / Veterans / Rotation.
//  - Balance: per role, the 1st / 2nd / 3rd best natural players and the best cover (alt position), each cell
//    coloured against the best-11 level, with flags for empty roles, no backup and ageing starters.
// Pure helpers (bestElevenLevel, classify, roleDepth, tone) take plain data and are exported via module.exports for
// scripts/test_insights_squad.js. Rendering reads app.js globals at render time only (currentPlayers, getPositionInfo,
// computeAge, formatWageAmount, openPlayerProfile) and js/charts.js.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PROSPECT_MAX_AGE = 21, VETERAN_MIN_AGE = 30, PEAK = [24, 29];

  // Role -> position labels that count as natural for it (same families as the depth chart, wide roles merged).
  const ROLES = [
    ['GK', ['GK']], ['RB', ['RB', 'RWB']], ['CB', ['CB', 'LCB', 'RCB', 'SW']], ['LB', ['LB', 'LWB']],
    ['CDM', ['CDM', 'LDM', 'RDM']], ['CM', ['CM', 'LCM', 'RCM']], ['CAM', ['CAM', 'LAM', 'RAM', 'CF']],
    ['RW', ['RW', 'RM', 'RF']], ['LW', ['LW', 'LM', 'LF']], ['ST', ['ST', 'LS', 'RS']]
  ];

  // ---------------------------------------------------------------------------------------------------------
  // Pure logic
  // ---------------------------------------------------------------------------------------------------------

  // Average and cut-off (11th best) overall of the best 11 by overall; with fewer than 11 players, of everyone.
  function bestElevenLevel(players) {
    const ovrs = (players || []).map(p => Number(p.overall)).filter(v => v > 0).sort((a, b) => b - a).slice(0, 11);
    if (ovrs.length === 0) return { avg: null, cutoff: null };
    return { avg: ovrs.reduce((s, v) => s + v, 0) / ovrs.length, cutoff: ovrs[ovrs.length - 1] };
  }

  // prospect (21 and under) / veteran (30+) / core (at or above the best-11 cut-off) / rotation. Age wins over level,
  // so a 20-year-old starter is a prospect and a 32-year-old starter a veteran: those are the two groups to plan for.
  function classify(age, overall, cutoff) {
    if (age != null && age <= PROSPECT_MAX_AGE) return 'prospect';
    if (age != null && age >= VETERAN_MIN_AGE) return 'veteran';
    return cutoff != null && Number(overall) >= cutoff ? 'core' : 'rotation';
  }

  // players need position_id / alt_positions / overall; labelOf(posId) -> 'CB' etc.
  // -> [{ role, natural: [players by OVR desc], cover: best alt-position player not natural here, or null }]
  function roleDepth(players, labelOf) {
    const alts = p => String(p.alt_positions || '').split(',').map(x => x.trim()).filter(Boolean).map(labelOf);
    return ROLES.map(([role, fam]) => {
      const byOvr = (a, b) => (Number(b.overall) || 0) - (Number(a.overall) || 0);
      const natural = (players || []).filter(p => fam.includes(labelOf(p.position_id))).sort(byOvr);
      const cover = (players || []).filter(p => !fam.includes(labelOf(p.position_id)) && alts(p).some(l => fam.includes(l))).sort(byOvr)[0] || null;
      return { role, natural, cover };
    });
  }

  // Cell colour band for an overall against the best-11 average: good (at or above), ok (within 4), weak (within 8),
  // poor (below that), empty (nobody).
  function tone(overall, level) {
    if (!overall) return 'empty';
    if (level == null) return 'ok';
    if (overall >= level) return 'good';
    if (overall >= level - 4) return 'ok';
    if (overall >= level - 8) return 'weak';
    return 'poor';
  }

  // ---------------------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------------------

  const GROUP_COLOR = { GK: '#d29922', DEF: '#58a6ff', MID: '#3fb950', ATT: '#f85149' };
  const TONE_BG = { good: 'rgba(63,185,80,0.45)', ok: 'rgba(63,185,80,0.20)', weak: 'rgba(210,153,34,0.32)', poor: 'rgba(248,81,73,0.32)', empty: 'rgba(248,81,73,0.12)' };
  const GROUPS = [['core', 'Core', 'At or above the best-11 level, under 30'], ['prospect', 'Prospects', `${PROSPECT_MAX_AGE} and under`],
    ['veteran', 'Veterans', `${VETERAN_MIN_AGE} and over`], ['rotation', 'Rotation', 'Below the best-11 level, 22-29']];

  const squad = () => (typeof currentPlayers !== 'undefined' ? currentPlayers : []).filter(p => p.__clubStatus === 'normal');
  const link = p => `<span class="clickable-name" style="color: #58a6ff;" onclick="openPlayerProfile('${esc(p.player_id)}')">${esc(p.name)}</span>`;

  function profileCard(players, level) {
    const withAge = players.map(p => ({ p, age: root.computeAge(p.dob), ovr: Number(p.overall) || 0 })).filter(x => x.age != null && x.ovr > 0);
    if (withAge.length === 0) return '<div class="empty-state" style="padding: 12px;">No ages or ratings to plot yet.</div>';
    const wages = withAge.map(x => Number(x.p.wage) || 0), maxW = Math.max(...wages, 1);
    const pts = withAge.map(x => {
      const g = root.getPositionInfo(x.p.position_id);
      const w = Number(x.p.wage) || 0;
      return { x: x.age, y: x.ovr, r: 4 + 8 * Math.sqrt(w / maxW), color: GROUP_COLOR[g.group] || 'var(--accent-color)', id: x.p.player_id,
        title: `${x.p.name} · ${g.label} · age ${x.age} · OVR ${x.ovr}${w ? ` · ${root.formatWageAmount(w)}/wk` : ''}` };
    });
    const svg = root.Charts.scatterSvg(pts, { xLabel: 'Age', yLabel: 'Overall', xFmt: v => Math.round(v), yFmt: v => Math.round(v), onClick: 'openPlayerProfile',
      bands: [{ x0: PEAK[0], x1: PEAK[1], label: 'Peak years' }], yRef: level.avg, yRefLabel: level.avg ? `Best 11 avg ${level.avg.toFixed(1)}` : '' });
    const legend = Object.keys(GROUP_COLOR).map(g => `<span><span style="color: ${GROUP_COLOR[g]};">●</span> ${g}</span>`).join(' ');

    const groups = {}; GROUPS.forEach(([k]) => { groups[k] = []; });
    withAge.forEach(x => groups[classify(x.age, x.ovr, level.cutoff)].push(x));
    const cols = GROUPS.map(([k, label, hint]) => {
      const list = groups[k].sort((a, b) => b.ovr - a.ovr);
      const avgAge = list.length ? (list.reduce((s, x) => s + x.age, 0) / list.length).toFixed(1) : '–';
      return `<div style="min-width: 0;"><div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim);" title="${esc(hint)}">${label} · ${list.length}</div>
        <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 6px;">avg age ${avgAge}</div>
        <div style="font-size: 13px; line-height: 1.7;">${list.map(x => `${link(x.p)} <span style="color: var(--text-dim);">${x.ovr}</span>`).join('<br>') || '<span style="color: var(--text-dim);">nobody</span>'}</div></div>`;
    }).join('');
    return `${svg}<div style="display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); margin: 4px 0 14px;">${legend}<span>Dot size = wage</span></div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 14px;">${cols}</div>`;
  }

  function balanceCard(players, level) {
    const rows = roleDepth(players, id => root.getPositionInfo(id).label);
    const cell = p => {
      const t = tone(p && Number(p.overall), level.avg);
      if (!p) return `<td style="background: ${TONE_BG.empty}; color: var(--text-dim); text-align: center;">–</td>`;
      const age = root.computeAge(p.dob);
      return `<td style="background: ${TONE_BG[t]};" title="${esc(p.name)} · OVR ${p.overall}${age != null ? ` · age ${age}` : ''}">
        <span class="clickable-name" onclick="openPlayerProfile('${esc(p.player_id)}')"><strong>${p.overall}</strong> <span style="font-size: 12px;">${esc(p.name)}</span></span></td>`;
    };
    const body = rows.map(r => {
      // [text, red?]: red = a real hole, amber = worth watching (someone can cover it, or the starter is ageing)
      const flags = [];
      if (!r.natural.length) flags.push(r.cover ? ['cover only', false] : ['empty', true]);
      else if (r.natural.length === 1) flags.push(r.cover ? ['no natural backup', false] : ['no backup', true]);
      const starter = r.natural[0];
      const starterAge = starter ? root.computeAge(starter.dob) : null;
      if (starterAge != null && starterAge >= 31) flags.push([`starter is ${starterAge}`, false]);
      if (starter && level.avg != null && Number(starter.overall) < level.avg - 8) flags.push(['weak starter', true]);
      const flagHtml = flags.map(([t, red]) => `<span style="color: ${red ? '#f85149' : '#d29922'};">${t}</span>`).join(' · ') || '<span style="color: var(--text-dim);">ok</span>';
      return `<tr><td><strong>${r.role}</strong></td>${[0, 1, 2].map(i => cell(r.natural[i])).join('')}${cell(r.cover)}
        <td style="font-size: 12px;">${flagHtml}</td></tr>`;
    }).join('');
    const key = [['good', 'at/above best-11 avg'], ['ok', 'within 4'], ['weak', 'within 8'], ['poor', 'further below'], ['empty', 'nobody']]
      .map(([t, l]) => `<span><span style="display: inline-block; width: 12px; height: 12px; border-radius: 2px; background: ${TONE_BG[t]}; vertical-align: -1px;"></span> ${l}</span>`).join(' ');
    // fixed layout so long names wrap inside their cell instead of pushing the table past the card
    return `<table class="sub-table insights-balance" style="width: 100%; table-layout: fixed;"><colgroup><col style="width: 11%"><col style="width: 17.5%"><col style="width: 17.5%"><col style="width: 17.5%"><col style="width: 17.5%"><col style="width: 19%"></colgroup>
      <thead><tr><th>Role</th><th>1st</th><th>2nd</th><th>3rd</th><th title="Best player listed at this role as an alternative position">Cover</th><th>Flags</th></tr></thead><tbody>${body}</tbody></table>
      <div style="display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); margin-top: 8px;">${key}<span>· flags: <span style="color: #f85149;">red</span> = a real hole, <span style="color: #d29922;">amber</span> = worth watching</span></div>`;
  }

  function squadHtml() {
    const players = squad();
    if (players.length === 0) return '<div class="empty-state">No squad loaded.</div>';
    const level = bestElevenLevel(players);
    return `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; align-items: start;">
      <div class="profile-card"><h3>Age vs overall</h3>${profileCard(players, level)}</div>
      <div class="profile-card"><h3>Squad balance</h3>${balanceCard(players, level)}
        <div style="font-size: 11px; color: var(--text-dim); margin-top: 8px;">Natural position only for 1st-3rd; "Cover" is the best player who lists the role as an alternative. Loaned-out players are not counted.</div></div>
    </div>`;
  }

  if (root.Insights) root.Insights.addView('squad', squadHtml);
  const api = { bestElevenLevel, classify, roleDepth, tone, ROLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
