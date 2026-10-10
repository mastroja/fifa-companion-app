// Hand-rolled SVG chart builders (no charting library, same approach as the league history chart in app.js).
// Everything here is a pure function over plain data that returns an SVG/HTML string, so it can be unit-tested
// via module.exports (scripts/test_charts.js). Colours come from the app's CSS variables.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------------------------------------------------------------------------------------------------------
  // Development curve
  // ---------------------------------------------------------------------------------------------------------

  // "2026/27" or "2026/2027" -> 2027 (the calendar year the season ends in); null if unreadable.
  function seasonEndYear(label) {
    const m = String(label || '').match(/(\d{4})\s*[\/\-]\s*(\d{2,4})/);
    if (m) {
      if (m[2].length !== 2) return Number(m[2]);
      const end = Number(m[1].slice(0, 2) + m[2]);
      return end < Number(m[1]) ? end + 100 : end; // "1999/00" -> 2000
    }
    const single = String(label || '').match(/(\d{4})/);
    return single ? Number(single[1]) : null;
  }

  // Age on 30 June of the season's end year (the season's rough midpoint-to-end), from a Date or null.
  function ageAtSeasonEnd(birthDate, label) {
    const endYear = seasonEndYear(label);
    if (!birthDate || !endYear) return null;
    const ref = new Date(endYear, 5, 30);
    let age = ref.getFullYear() - birthDate.getFullYear();
    const m = ref.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && ref.getDate() < birthDate.getDate())) age--;
    return age;
  }

  // Estimated future overall, one value per year from the player's current age. An ESTIMATE only: growth eases toward
  // potential by the peak age, holds a couple of years, then declines gently. Goalkeepers peak later.
  function projectCurve(age, overall, potential, isGoalkeeper) {
    const peakAge = isGoalkeeper ? 28 : 26;
    const declineFrom = isGoalkeeper ? 33 : 30;
    const endAge = Math.max(age, isGoalkeeper ? 38 : 35);
    // Only players still below the peak age grow toward potential; anyone already there holds their current overall.
    const target = age < peakAge ? Math.max(overall, potential || overall) : overall;
    const out = [];
    for (let a = age + 1; a <= endAge; a++) {
      let v;
      if (a <= peakAge) {
        const t = (a - age) / Math.max(1, peakAge - age);
        v = overall + (target - overall) * (1 - Math.pow(1 - clamp(t, 0, 1), 2));
      } else if (a <= declineFrom) {
        v = target;
      } else {
        v = target - (a - declineFrom) * (isGoalkeeper ? 1 : 1.5);
      }
      out.push({ age: a, overall: Math.round(v) });
    }
    return out;
  }

  // seasons: [{ age, overall, potential, label }] oldest -> newest (rows without age/overall are ignored).
  // opts: { isGoalkeeper, showProjection }.
  function developmentCurveSvg(seasons, opts) {
    opts = opts || {};
    const pts = (seasons || []).filter(s => s && Number.isFinite(s.age) && Number(s.overall) > 0);
    if (pts.length === 0) {
      return '<div style="color: var(--text-dim); font-size: 13px;">Not enough history yet. A point is added for every season this player appears in.</div>';
    }
    const last = pts[pts.length - 1];
    const proj = opts.showProjection === false ? [] : projectCurve(last.age, last.overall, last.potential, !!opts.isGoalkeeper);

    const ages = pts.map(p => p.age).concat(proj.map(p => p.age));
    const vals = pts.flatMap(p => [p.overall, Number(p.potential) || p.overall]).concat(proj.map(p => p.overall));
    const minAge = Math.min(...ages), maxAge = Math.max(...ages, minAge + 2);
    const yMin = Math.floor((Math.min(...vals) - 3) / 5) * 5, yMax = Math.ceil((Math.max(...vals) + 3) / 5) * 5;

    const W = 600, H = 280, L = 40, R = 584, T = 16, B = 244;
    const x = a => L + ((a - minAge) / (maxAge - minAge)) * (R - L);
    const y = v => B - ((v - yMin) / (yMax - yMin)) * (B - T);

    const yTicks = [];
    for (let v = yMin; v <= yMax; v += 5) yTicks.push(v);
    const grid = yTicks.map(v => `
      <line x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}" style="stroke: var(--border-color); stroke-width: 1; opacity: 0.6;" />
      <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" style="fill: var(--text-dim);">${v}</text>`).join('');
    const xStep = maxAge - minAge > 14 ? 2 : 1;
    let xLabels = '';
    for (let a = minAge; a <= maxAge; a += xStep) {
      xLabels += `<text x="${x(a)}" y="${B + 18}" text-anchor="middle" font-size="11" style="fill: var(--text-dim);">${a}</text>`;
    }

    const line = (arr, key) => arr.map(p => `${x(p.age)},${y(p[key])}`).join(' ');
    const potentialPts = pts.filter(p => Number(p.potential) > 0);
    const potLine = potentialPts.length > 1
      ? `<polyline points="${potentialPts.map(p => `${x(p.age)},${y(p.potential)}`).join(' ')}" fill="none" style="stroke: #d29922; stroke-width: 1.5; stroke-dasharray: 5 4;" />` : '';
    const projLine = proj.length
      ? `<polyline points="${x(last.age)},${y(last.overall)} ${line(proj, 'overall')}" fill="none" style="stroke: var(--accent-color); stroke-width: 2; stroke-dasharray: 2 5; stroke-linecap: round; opacity: 0.8;" />` : '';
    const peak = proj.length ? proj.reduce((b, p) => (p.overall > b.overall ? p : b), proj[0]) : null;
    const peakMark = peak && peak.overall > last.overall
      ? `<circle cx="${x(peak.age)}" cy="${y(peak.overall)}" r="4" style="fill: none; stroke: var(--accent-color); stroke-width: 2;"><title>Estimated peak: ${peak.overall} at age ${peak.age}</title></circle>
         <text x="${x(peak.age)}" y="${y(peak.overall) - 9}" text-anchor="middle" font-size="11" font-weight="700" style="fill: var(--accent-color);">~${peak.overall}</text>` : '';

    const ovrLine = pts.length > 1 ? `<polyline points="${line(pts, 'overall')}" fill="none" style="stroke: var(--accent-color); stroke-width: 2.5;" />` : '';
    const dots = pts.map(p => `
      <circle cx="${x(p.age)}" cy="${y(p.overall)}" r="5" style="fill: var(--accent-color); stroke: var(--card-bg); stroke-width: 1.5;"><title>${esc(p.label || '')} · age ${p.age} · OVR ${p.overall}${Number(p.potential) > 0 ? ' / POT ' + p.potential : ''}</title></circle>
      <text x="${x(p.age) - L < 14 ? x(p.age) + 7 : x(p.age)}" y="${y(p.overall) + 18}" text-anchor="${x(p.age) - L < 14 ? 'start' : 'middle'}" font-size="11" font-weight="700" style="fill: var(--text-color);">${p.overall}</text>`).join(''); // first point: label to the right, clear of the axis numbers

    const legend = `
      <div style="display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); margin-top: 6px;">
        <span><span style="color: var(--accent-color);">━</span> Overall</span>
        ${potLine ? '<span><span style="color: #d29922;">╌</span> Potential</span>' : ''}
        ${proj.length ? '<span><span style="color: var(--accent-color);">···</span> Projection (estimate)</span>' : ''}
      </div>`;
    return `
      <svg viewBox="0 0 ${W} ${H}" style="width: 100%; height: auto;" role="img" aria-label="Overall rating by age">
        ${grid}
        <line x1="${L}" y1="${B}" x2="${R}" y2="${B}" style="stroke: var(--text-dim); stroke-width: 1.5;" />
        ${xLabels}
        <text x="${(L + R) / 2}" y="${H - 4}" text-anchor="middle" font-size="11" style="fill: var(--text-dim);">Age</text>
        ${potLine}${projLine}${ovrLine}${peakMark}${dots}
      </svg>${legend}`;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Radar (attribute compare)
  // ---------------------------------------------------------------------------------------------------------

  // axes: ['PAC', ...]; series: [{ name, color, values: [n per axis] }]; scale 0..100 (rings every 20).
  function radarSvg(axes, series) {
    const n = (axes || []).length;
    if (n < 3 || !series || series.length === 0) return '';
    const W = 360, H = 330, cx = 180, cy = 160, r = 120;
    const ang = i => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const at = (i, frac) => [cx + Math.cos(ang(i)) * r * frac, cy + Math.sin(ang(i)) * r * frac];
    const rings = [0.2, 0.4, 0.6, 0.8, 1].map(f =>
      `<polygon points="${axes.map((_, i) => at(i, f).join(',')).join(' ')}" fill="none" style="stroke: var(--border-color); stroke-width: 1;" />`).join('');
    const spokes = axes.map((_, i) => { const [x, y] = at(i, 1); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" style="stroke: var(--border-color); stroke-width: 1;" />`; }).join('');
    const labels = axes.map((a, i) => {
      const [x, y] = at(i, 1.16);
      return `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--text-dim);">${esc(a)}</text>`;
    }).join('');
    const shapes = series.map(s => {
      const pts = axes.map((_, i) => at(i, clamp(Number(s.values[i]) || 0, 0, 100) / 100));
      const dots = pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${s.color}"><title>${esc(s.name)} · ${esc(axes[i])} ${Math.round(Number(s.values[i]) || 0)}</title></circle>`).join('');
      return `<polygon points="${pts.map(p => p.join(',')).join(' ')}" fill="${s.color}" fill-opacity="0.18" stroke="${s.color}" stroke-width="2" />${dots}`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width: 100%; max-width: 420px; height: auto;" role="img" aria-label="Attribute radar">${rings}${spokes}${shapes}${labels}</svg>`;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Scatter (e.g. wage vs overall, age vs overall)
  // ---------------------------------------------------------------------------------------------------------

  // points: [{ x, y, color, title, id, r }]; opts: { xLabel, yLabel, xFmt, yFmt, trend: [{x, y}, ...] (polyline), onClick: 'fnName',
  //   bands: [{ x0, x1, label, color, opacity }] (shaded x ranges), yRef / yRefLabel (dashed horizontal reference) }.
  // Points with a non-finite x/y are skipped. onClick is a global function name called with the point's id.
  let scatterClipSeq = 0; // unique clipPath ids, several scatters can share a page
  function scatterSvg(points, opts) {
    opts = opts || {};
    const pts = (points || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length === 0) return '';
    const xf = opts.xFmt || (v => v), yf = opts.yFmt || (v => v);
    const W = 600, H = 300, L = 56, Rr = 584, T = 14, B = 256;
    let x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
    let y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
    if (opts.xMin != null) x0 = Math.min(x0, opts.xMin);
    if (opts.yMin != null) y0 = Math.min(y0, opts.yMin);
    if (x1 === x0) { x0 -= 1; x1 += 1; }
    if (y1 === y0) { y0 -= 1; y1 += 1; }
    const px = (x1 - x0) * 0.06, py = (y1 - y0) * 0.08;
    x0 -= px; x1 += px; y0 = Math.max(0, y0 - py); y1 += py;
    const X = v => L + ((v - x0) / (x1 - x0)) * (Rr - L);
    const Y = v => B - ((v - y0) / (y1 - y0)) * (B - T);
    const ticks = (a, b) => [0, 1, 2, 3, 4].map(i => a + ((b - a) * i) / 4);
    const grid = ticks(y0, y1).map(v => `
      <line x1="${L}" y1="${Y(v)}" x2="${Rr}" y2="${Y(v)}" style="stroke: var(--border-color); stroke-width: 1; opacity: 0.6;" />
      <text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" style="fill: var(--text-dim);">${esc(yf(v))}</text>`).join('');
    const xl = ticks(x0, x1).map(v => `<text x="${X(v)}" y="${B + 16}" text-anchor="middle" font-size="11" style="fill: var(--text-dim);">${esc(xf(v))}</text>`).join('');
    const bands = (opts.bands || []).filter(b => Number.isFinite(b.x0) && Number.isFinite(b.x1)).map(b => {
      const a = X(Math.max(b.x0, x0)), z = X(Math.min(b.x1, x1));
      return z > a ? `<rect x="${a}" y="${T}" width="${z - a}" height="${B - T}" style="fill: ${b.color || 'var(--hover-color)'}; opacity: ${b.opacity || 0.5};" />
        ${b.label ? `<text x="${(a + z) / 2}" y="${B - 6}" text-anchor="middle" font-size="11" style="fill: var(--text-dim);">${esc(b.label)}</text>` : ''}` : '';
    }).join('');
    const yRef = Number.isFinite(opts.yRef) && opts.yRef >= y0 && opts.yRef <= y1
      ? `<line x1="${L}" y1="${Y(opts.yRef)}" x2="${Rr}" y2="${Y(opts.yRef)}" style="stroke: var(--text-dim); stroke-width: 1; stroke-dasharray: 3 4;" />${opts.yRefLabel ? `<text x="${Rr - 4}" y="${Y(opts.yRef) - 5}" text-anchor="end" font-size="11" style="fill: var(--text-dim);">${esc(opts.yRefLabel)}</text>` : ''}` : '';
    const trendPts = (opts.trend || []).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
    const clipId = `sc-clip-${++scatterClipSeq}`;
    const trend = trendPts.length >= 2
      ? `<defs><clipPath id="${clipId}"><rect x="${L}" y="${T}" width="${Rr - L}" height="${B - T}" /></clipPath></defs><polyline clip-path="url(#${clipId})" points="${trendPts.map(t => `${X(t.x)},${Y(t.y)}`).join(' ')}" fill="none" style="stroke: var(--text-dim); stroke-width: 1.5; stroke-dasharray: 5 4;" />` : '';
    const dots = pts.map(p => {
      const click = opts.onClick && p.id != null ? ` onclick="${esc(opts.onClick)}('${esc(p.id)}')" style="cursor: pointer;"` : '';
      return `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.r || 5.5}" fill="${p.color || 'var(--accent-color)'}" fill-opacity="0.85" stroke="var(--card-bg)" stroke-width="1.5"${click}><title>${esc(p.title || '')}</title></circle>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width: 100%; height: auto;" role="img" aria-label="${esc(opts.yLabel || '')} by ${esc(opts.xLabel || '')}">
      ${bands}${grid}${yRef}<line x1="${L}" y1="${B}" x2="${Rr}" y2="${B}" style="stroke: var(--text-dim); stroke-width: 1.5;" />
      ${xl}<text x="${(L + Rr) / 2}" y="${H - 6}" text-anchor="middle" font-size="11" style="fill: var(--text-dim);">${esc(opts.xLabel || '')}</text>
      ${trend}${dots}</svg>`;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Horizontal bars (e.g. contract expiries per year)
  // ---------------------------------------------------------------------------------------------------------

  // rows: [{ label, value, sub, color }]; value drives bar length, sub is shown after it. Empty rows list -> ''.
  function barsHtml(rows) {
    if (!rows || rows.length === 0) return '';
    const max = Math.max(...rows.map(r => Number(r.value) || 0), 1);
    return rows.map(r => `
      <div style="display: grid; grid-template-columns: 56px 1fr 130px; gap: 10px; align-items: center; margin: 7px 0; font-size: 13px;">
        <span style="color: var(--text-dim);">${esc(r.label)}</span>
        <span style="background: var(--hover-color); border-radius: 4px; height: 18px; display: block;">
          <span style="display: block; height: 100%; width: ${Math.max(((Number(r.value) || 0) / max) * 100, r.value ? 3 : 0)}%; background: ${r.color || 'var(--accent-color)'}; border-radius: 4px;"></span>
        </span>
        <span>${esc(r.text != null ? r.text : r.value)}${r.sub ? ` <span style="color: var(--text-dim);">${esc(r.sub)}</span>` : ''}</span>
      </div>`).join('');
  }

  // ---------------------------------------------------------------------------------------------------------
  // Line chart (one or more series over the same labels, e.g. seasons)
  // ---------------------------------------------------------------------------------------------------------

  // labels: ['2024/25', ...]; series: [{ name, color, values: [n|null per label] }]; opts: { yFmt, width, height, dashed: [names] }.
  // null values leave a gap; a single label draws dots only.
  function lineChartSvg(labels, series, opts) {
    opts = opts || {};
    const n = (labels || []).length;
    const all = (series || []).flatMap(s => s.values).filter(v => Number.isFinite(v));
    if (n === 0 || all.length === 0) return '';
    const yf = opts.yFmt || (v => Math.round(v));
    // opts.width: a narrower canvas for a small card keeps the text readable (it scales with the card)
    const W = opts.width || 600, H = opts.height || 220, L = 52, R = W - 26, T = 14, B = H - 30;
    let y0 = Math.min(...all), y1 = Math.max(...all);
    if (y1 === y0) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.12; y0 -= pad; y1 += pad;
    const X = i => n > 1 ? L + (i / (n - 1)) * (R - L) : (L + R) / 2;
    const Y = v => B - ((v - y0) / (y1 - y0)) * (B - T);
    const grid = [0, 1, 2, 3].map(i => y0 + ((y1 - y0) * i) / 3).map(v => `
      <line x1="${L}" y1="${Y(v)}" x2="${R}" y2="${Y(v)}" style="stroke: var(--border-color); stroke-width: 1; opacity: 0.6;" />
      <text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" style="fill: var(--text-dim);">${esc(yf(v))}</text>`).join('');
    const step = Math.max(1, Math.ceil(n / 8));
    const xl = labels.map((l, i) => i % step === 0 || i === n - 1 ? `<text x="${X(i)}" y="${B + 18}" text-anchor="middle" font-size="11" style="fill: var(--text-dim);">${esc(l)}</text>` : '').join('');
    const lines = series.map(s => {
      const segs = []; let cur = [];
      s.values.forEach((v, i) => { if (Number.isFinite(v)) cur.push(`${X(i)},${Y(v)}`); else if (cur.length) { segs.push(cur); cur = []; } });
      if (cur.length) segs.push(cur);
      const dash = (opts.dashed || []).includes(s.name) ? ' stroke-dasharray: 5 4;' : '';
      const path = segs.filter(sg => sg.length > 1).map(sg => `<polyline points="${sg.join(' ')}" fill="none" style="stroke: ${s.color}; stroke-width: 2.5;${dash}" />`).join('');
      const dots = s.values.map((v, i) => Number.isFinite(v) ? `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${s.color}" stroke="var(--card-bg)" stroke-width="1.5"><title>${esc(s.name)} · ${esc(labels[i])}: ${esc(yf(v))}</title></circle>` : '').join('');
      return path + dots;
    }).join('');
    const legend = series.length > 1 ? `<div style="display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); margin-top: 4px;">${series.map(s => `<span><span style="color: ${s.color};">━</span> ${esc(s.name)}</span>`).join('')}</div>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" style="width: 100%; height: auto;" role="img" aria-label="${esc(series.map(s => s.name).join(', '))} by season">
      ${grid}<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" style="stroke: var(--text-dim); stroke-width: 1.5;" />${xl}${lines}</svg>${legend}`;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Timeline (swimlanes of date ranges, e.g. injuries)
  // ---------------------------------------------------------------------------------------------------------

  const DAY = 86400000;
  const toDate = v => { if (!v) return null; const d = v instanceof Date ? v : new Date(/^\d{8}$/.test(String(v)) ? `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}` : v); return isNaN(d.getTime()) ? null : d; };

  // lanes: [{ label, id, items: [{ start, end (null = still open), title }] }]; opts: { to (date, default today), from,
  // onClick: 'fnName' (called with lane id), laneHeight, width }. Open items run to `to` and are drawn in red.
  function timelineSvg(lanes, opts) {
    opts = opts || {};
    const rows = (lanes || []).map(l => ({ ...l, items: (l.items || []).map(it => ({ ...it, s: toDate(it.start), e: toDate(it.end) })).filter(it => it.s) })).filter(l => l.items.length);
    if (rows.length === 0) return '';
    const to = toDate(opts.to) || new Date();
    const starts = rows.flatMap(l => l.items.map(it => it.s.getTime()));
    let from = toDate(opts.from) ? toDate(opts.from).getTime() : Math.min(...starts);
    let end = Math.max(to.getTime(), ...rows.flatMap(l => l.items.map(it => (it.e || to).getTime())));
    if (end - from < 60 * DAY) from = end - 60 * DAY; // at least two months wide, so a short injury is still visible
    const labelW = rows.some(l => l.label) ? 130 : 0;
    // opts.width: a wider canvas for a full-width card keeps the text at its normal size
    const lh = opts.laneHeight || 26, W = opts.width || 600, L = labelW + 6, R = W - 10, T = 6, B = T + rows.length * lh, H = B + 22;
    const X = t => L + ((t - from) / (end - from)) * (R - L);
    // month ticks, thinned to at most ~8 labels
    const ticks = []; const d = new Date(from); d.setDate(1); d.setMonth(d.getMonth() + 1);
    while (d.getTime() <= end) { ticks.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
    const every = Math.max(1, Math.ceil(ticks.length / 8));
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const tickSvg = ticks.map((t, i) => i % every ? '' : `<line x1="${X(t.getTime())}" y1="${T}" x2="${X(t.getTime())}" y2="${B}" style="stroke: var(--border-color); stroke-width: 1; opacity: 0.5;" />
      <text x="${X(t.getTime())}" y="${B + 15}" text-anchor="middle" font-size="10" style="fill: var(--text-dim);">${MONTHS[t.getMonth()]}${t.getMonth() === 0 || i === 0 ? ` '${String(t.getFullYear()).slice(2)}` : ''}</text>`).join('');
    const laneSvg = rows.map((l, i) => {
      const y = T + i * lh;
      const click = opts.onClick && l.id != null ? ` onclick="${esc(opts.onClick)}('${esc(l.id)}')" style="cursor: pointer; fill: var(--text-color);"` : ' style="fill: var(--text-color);"';
      const label = labelW ? `<text x="${labelW}" y="${y + lh / 2 + 4}" text-anchor="end" font-size="12"${click}>${esc(l.label)}</text>` : '';
      // clipped to the window: an item that started before `from` begins at the left edge, one that ended before it is skipped
      const bars = l.items.filter(it => (it.e || to).getTime() >= from).map(it => {
        const a = X(Math.max(it.s.getTime(), from)), z = Math.max(X(Math.min((it.e || to).getTime(), end)), a + 3);
        return `<rect x="${a}" y="${y + 5}" width="${z - a}" height="${lh - 10}" rx="3" fill="${it.e ? '#d29922' : '#f85149'}" fill-opacity="0.85"><title>${esc(it.title || '')}</title></rect>`;
      }).join('');
      return `<line x1="${L}" y1="${y + lh / 2}" x2="${R}" y2="${y + lh / 2}" style="stroke: var(--border-color); stroke-width: 1;" />${label}${bars}`;
    }).join('');
    const todayX = X(to.getTime());
    return `<svg viewBox="0 0 ${W} ${H}" style="width: 100%; height: auto;" role="img" aria-label="Timeline">
      ${tickSvg}${laneSvg}<line x1="${todayX}" y1="${T}" x2="${todayX}" y2="${B}" style="stroke: var(--accent-color); stroke-width: 1.5; stroke-dasharray: 3 3;"><title>Today (in game)</title></line></svg>`;
  }

  const api = { seasonEndYear, ageAtSeasonEnd, projectCurve, developmentCurveSvg, radarSvg, scatterSvg, barsHtml, lineChartSvg, timelineSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Charts = api;
})(typeof window !== 'undefined' ? window : globalThis);
