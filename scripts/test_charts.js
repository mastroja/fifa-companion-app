// node scripts/test_charts.js — logic checks for js/charts.js (season/age maths, projection, SVG output).
const assert = require('assert');
const C = require('../js/charts.js');

assert.strictEqual(C.seasonEndYear('2026/27'), 2027);
assert.strictEqual(C.seasonEndYear('2026/2027'), 2027);
assert.strictEqual(C.seasonEndYear('1999/00'), 2000);
assert.strictEqual(C.seasonEndYear(null), null);

// born 2008-03-10 -> 18 on 30 Jun 2027, born 2008-09-01 -> 18 on 30 Jun 2027 is false (17)
assert.strictEqual(C.ageAtSeasonEnd(new Date(2008, 2, 10), '2026/27'), 19);
assert.strictEqual(C.ageAtSeasonEnd(new Date(2008, 8, 1), '2026/27'), 18);
assert.strictEqual(C.ageAtSeasonEnd(null, '2026/27'), null);
assert.strictEqual(C.ageAtSeasonEnd(new Date(2008, 2, 10), 'junk'), null);

// projection rises toward potential, never exceeds it, then declines
const proj = C.projectCurve(19, 65, 82, false);
assert(proj[0].age === 20 && proj[0].overall > 65, 'grows next year');
assert(Math.max(...proj.map(p => p.overall)) === 82, 'peaks at potential');
assert(proj[proj.length - 1].overall < 82, 'declines late');
assert.deepStrictEqual(C.projectCurve(35, 70, 70, false), [], 'no projection past the end age');
assert(C.projectCurve(30, 80, 70, false).every(p => p.overall <= 80), 'potential below overall never raises it');

// past the peak age, a gap to potential is not closed: no jump, just hold then decline
const late = C.projectCurve(29, 69, 85, false);
assert(late.every(p => p.overall <= 69), 'a 29-year-old does not jump toward potential');
assert(late[late.length - 1].overall < 69, 'and still declines later');

// empty / unusable data gives the empty state, not a broken svg
assert(/Not enough history/.test(C.developmentCurveSvg([], {})));
assert(/Not enough history/.test(C.developmentCurveSvg([{ age: null, overall: 70 }], {})));

// one season is enough to draw (single point + projection); text is escaped
let svg = C.developmentCurveSvg([{ age: 19, overall: 65, potential: 82, label: '<b>x</b>' }], {});
assert(svg.includes('<svg') && svg.includes('Projection'), 'single season draws');
assert(!svg.includes('<b>x</b>') && svg.includes('&lt;b&gt;'), 'labels escaped');
assert(!svg.includes('NaN') && !svg.includes('undefined'), 'no NaN in single-season svg');

// flat player (min == max age span) must not divide by zero
svg = C.developmentCurveSvg([{ age: 36, overall: 70, potential: 70 }], { showProjection: false });
assert(!svg.includes('NaN') && !svg.includes('Infinity'), 'no NaN/Infinity for a single flat point');

// multi-season, no projection for former players
svg = C.developmentCurveSvg([{ age: 18, overall: 60, potential: 80 }, { age: 19, overall: 66, potential: 80 }, { age: 20, overall: 70, potential: 80 }], { showProjection: false });
assert(!svg.includes('Projection') && svg.includes('Potential'), 'former-player chart has no projection');

// line chart: gaps for null, single label draws, nothing to draw -> ''
let line = C.lineChartSvg(['a', 'b', 'c'], [{ name: 'OVR', color: '#0f0', values: [70, null, 74] }]);
assert(line.includes('<svg') && !line.includes('NaN'), 'line chart with a gap');
assert(!/<polyline/.test(line), 'a gap between two single points draws no line segment');
assert(C.lineChartSvg(['a'], [{ name: 'x', color: '#0f0', values: [5] }]).includes('<circle'), 'single label draws a dot');
assert.strictEqual(C.lineChartSvg([], []), '');
assert.strictEqual(C.lineChartSvg(['a'], [{ name: 'x', color: '#0f0', values: [null] }]), '');
assert(!C.lineChartSvg(['a', 'b'], [{ name: 'x', color: '#0f0', values: [3, 3] }]).includes('NaN'), 'flat series');

// timeline: open items run to "to", bad dates dropped, empty -> '', 8-digit dates parse
const tl = C.timelineSvg([{ label: 'A', id: 1, items: [{ start: '2026-08-01', end: '2026-08-20', title: 'x' }, { start: '20260901', end: null, title: 'open' }] }, { label: 'B', items: [{ start: 'junk' }] }], { to: '2026-10-15' });
assert(tl.includes('#f85149') && tl.includes('#d29922'), 'open and closed bars');
assert(!tl.includes('NaN') && !tl.includes('>B<'), 'lane with only bad dates is dropped');
assert.strictEqual(C.timelineSvg([], {}), '');
assert(!C.timelineSvg([{ items: [{ start: '2026-10-15', end: '2026-10-15' }] }], { to: '2026-10-15' }).includes('NaN'), 'zero-length injury on the last day');

// timeline clipping: an item that started before `from` starts at the plot's left edge, never under the labels;
// one that ended before `from` is not drawn
const clipped = C.timelineSvg([{ label: 'Long Name Here', items: [{ start: '2025-01-01', end: '2025-06-01' }, { start: '2024-01-01', end: '2024-02-01' }] }], { from: '2025-04-01', to: '2025-10-01' });
const xs = [...clipped.matchAll(/<rect x="([\d.]+)"/g)].map(m => Number(m[1]));
assert.strictEqual(xs.length, 1, 'item entirely before the window skipped');
assert(xs[0] >= 136, 'clipped bar starts at the plot edge (label width 130 + 6), got ' + xs[0]);

// scatter extras: bands and reference line render, out-of-range ref is skipped
let sc = C.scatterSvg([{ x: 20, y: 70 }, { x: 30, y: 80 }], { bands: [{ x0: 24, x1: 29, label: 'Peak' }], yRef: 75, yRefLabel: 'XI' });
assert(sc.includes('Peak') && sc.includes('>XI<'), 'band + ref drawn');
assert(!C.scatterSvg([{ x: 20, y: 70 }, { x: 30, y: 80 }], { yRef: 999, yRefLabel: 'XI' }).includes('>XI<'), 'ref outside the axis skipped');
// the trend line is clipped to the plot area, with ids unique per chart
const s1 = C.scatterSvg([{ x: 60, y: 1000 }, { x: 80, y: 20000 }], { trend: [{ x: 60, y: 1000 }, { x: 90, y: 90000 }] });
const s2 = C.scatterSvg([{ x: 60, y: 1000 }, { x: 80, y: 20000 }], { trend: [{ x: 60, y: 1000 }, { x: 90, y: 90000 }] });
const idOf = svg => svg.match(/clipPath id="([^"]+)"/)[1];
assert(/<polyline clip-path="url\(#/.test(s1), 'trend uses the clip');
assert.notStrictEqual(idOf(s1), idOf(s2), 'clip ids unique');

console.log('charts tests passed');
