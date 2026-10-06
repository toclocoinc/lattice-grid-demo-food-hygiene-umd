/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the FSA API being reachable. It does depend on jsDelivr, because that is
 * where the page gets the grid from: this edition has no local copy of the
 * library at all, and a check that loaded one would not be checking the page.
 *
 * Beyond "it drew something", it asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag: there is no `type="module"`
 *     script on the page, every library tag points at the pinned release on
 *     the CDN, and each one left the global it documents;
 *   - narrowing to the worst ratings moves the tiles and the charts;
 *   - a re-rating lands on the row it belongs to rather than adding a second
 *     one;
 *   - grouping by local authority and by rating produces group rows;
 *   - the Scotland table is a separate dataset (FHIS), not a filter;
 *   - every headline figure agrees with the saved data, recomputed here
 *     rather than read back off the page.
 *
 * It then blocks the API in the browser and opens the live page, to prove a
 * visitor gets the saved copy, and is told so, when the FSA cannot be reached.
 *
 * `--all` also opens the live API, which is not part of the deployment gate.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

/** The release every library tag must name, and the globals each file leaves. */
const GRID_VERSION = '1.87.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/** This check needs Node's built-in WebSocket, which arrived in Node 22. */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'food-hygiene-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__foodDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__foodDemo.ready, error: window.__foodDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__foodDemo.fhrsGrid && window.__foodDemo.fhrsGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy: the deterministic run, where the figures are      */
  /*    cross-checked against the saved data.                             */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    const globals = {};
    for (const name of ['LatticeGrid', 'LatticeGridDataRouter', 'LatticeGridKPI', 'LatticeGridTabs']) {
      const value = window[name];
      globals[name] = value ? Object.keys(value).filter((k) => typeof value[k] === 'function').length : 0;
    }
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      globals,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(
    delivery.librarySrcs.length === LIBRARY_TAGS.length,
    `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`,
    `${delivery.librarySrcs.length}`,
  );
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash', `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(
    delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`,
    `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`,
    delivery.stylesheetSrc,
  );
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');

  const snap = await evaluate(`(() => {
    const d = window.__foodDemo;
    return {
      rows: d.fhrsGrid.rows.count(),
      total: d.fhrsGrid.rows.totalCount(),
      columns: d.fhrsGrid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      watermark: d.fhrsGrid.licence.watermark(),
      licenceState: d.fhrsGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      named: document.querySelector('.kpi-named-value').textContent,
    };
  })()`);
  console.log(`  ${snap.rows} rows, ${snap.columns} columns, ${snap.painted} painted, ${snap.charts} charts`);
  console.log(`  tiles: ${JSON.stringify(snap.tiles)}`);

  check(snap.rows > 0, 'saved copy: the table holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 4, 'saved copy: all four charts were built', `${snap.charts}`);

  /* Each chart is asked what it actually plotted, so an empty pair of axes is
     not mistaken for a chart. */
  const drawn = await evaluate(`(() => window.__foodDemo.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null && p.y !== 0).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('rect, circle').length : 0;
    return { i, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points carry a measure`);
    check(c.marks > 2, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  noErrors('saved copy');
  await shoot('01-grid-saved');

  /* The independent recomputation: the saved rows, reduced here in Node. */
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const values = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'establishments.json'), 'utf8'));
  const cols = meta.columns;
  const savedRows = values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
  const fhrs = savedRows.filter((row) => row.scheme === 'FHRS');
  const fhis = savedRows.filter((row) => row.scheme === 'FHIS');
  const scored = fhrs.filter((row) => typeof row.score === 'number');

  const expected = {
    businesses: fhrs.length,
    rated5: scored.filter((row) => row.score === 5).length,
    share5: scored.length ? (scored.filter((row) => row.score === 5).length / scored.length) * 100 : null,
    avgScore: scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : null,
    authorities: new Set(fhrs.map((row) => row.authority)).size,
  };

  const near = (a, b, eps) => Math.abs(a - b) <= eps;
  check(snap.tiles.businesses === expected.businesses, 'saved copy: the business count matches the saved data', `tile ${snap.tiles.businesses}, expected ${expected.businesses}`);
  check(snap.tiles.rated5 === expected.rated5, 'saved copy: the rated-5 count matches the saved data', `tile ${snap.tiles.rated5}, expected ${expected.rated5}`);
  check(near(snap.tiles.share5, expected.share5, 0.11), 'saved copy: the share-rated-5 figure matches the saved data', `tile ${snap.tiles.share5}, expected ${expected.share5.toFixed(1)}`);
  check(near(snap.tiles.avgScore, expected.avgScore, 0.011), 'saved copy: the average score matches the saved data', `tile ${snap.tiles.avgScore}, expected ${expected.avgScore.toFixed(2)}`);
  check(snap.tiles.authorities === expected.authorities, 'saved copy: the authority count matches the saved data', `tile ${snap.tiles.authorities}, expected ${expected.authorities}`);
  check(snap.named.length > 2 && snap.named !== 'No data', 'saved copy: the most common business type is named', snap.named);

  /* ---- narrowing to the worst ratings moves the tiles and charts ---- */

  const before = await evaluate(`(() => {
    const d = window.__foodDemo;
    return {
      rows: d.fhrsGrid.rows.count(),
      businesses: d.kpi.value('businesses'),
      chartSizes: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
    };
  })()`);

  await evaluate('window.__foodDemo.worstButton.click()');
  await sleep(700);

  const after = await evaluate(`(() => {
    const d = window.__foodDemo;
    return {
      rows: d.fhrsGrid.rows.count(),
      businesses: d.kpi.value('businesses'),
      pressed: d.worstButton.getAttribute('aria-pressed'),
      chartSizes: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
      worstRating: (() => { let w = null; d.fhrsGrid.rows.forEach((r) => { if (r && r.data && (w === null || String(r.data.rating) < w)) w = String(r.data.rating); }); return w; })(),
    };
  })()`);

  const expectedWorst = fhrs.filter((row) => ['0', '1', '2'].includes(row.rating)).length;

  console.log(`  narrowed: ${before.rows} rows -> ${after.rows} rows, tile ${before.businesses} -> ${after.businesses}`);
  check(after.pressed === 'true', 'the worst-rating filter reports itself pressed');
  check(after.rows < before.rows, 'the worst-rating filter narrows the table', `${before.rows} -> ${after.rows}`);
  check(after.businesses < before.businesses, 'the worst-rating filter moves the business tile', `${before.businesses} -> ${after.businesses}`);
  check(after.businesses === expectedWorst, 'the narrowed tile matches the saved worst-rating count', `tile ${after.businesses}, expected ${expectedWorst}`);
  const chartsMoved = after.chartSizes.filter((size, i) => size !== before.chartSizes[i]).length;
  check(chartsMoved > 0, 'the charts rebound to the narrowed data', `${chartsMoved} of ${after.chartSizes.length} changed`);
  await shoot('02-charts-filtered');

  await evaluate('window.__foodDemo.worstButton.click()');
  await sleep(500);
  const restored = await evaluate('window.__foodDemo.fhrsGrid.rows.count()');
  check(restored === before.rows, 'removing the filter restores the table', `${restored} of ${before.rows}`);

  /* ---- a re-rating lands on the row it belongs to ---- */

  const revision = await evaluate(`(async () => {
    const d = window.__foodDemo;
    let target = null;
    d.fhrsGrid.rows.forEach((r) => { if (!target && r && r.data && typeof r.data.score === 'number') target = r.data; });
    const before = { count: d.fhrsGrid.rows.count(), id: target.id, rating: target.rating };
    d.ingest([{ ...target, rating: '5', score: 5 }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.fhrsGrid.rows.forEach((r) => { if (r && r.data && r.data.id === before.id) found = r.data; });
    return { before, after: { count: d.fhrsGrid.rows.count(), rating: found ? found.rating : null } };
  })()`);
  console.log(`  re-rating: ${revision.before.id} ${revision.before.rating} -> ${revision.after.rating}, rows ${revision.before.count} -> ${revision.after.count}`);
  check(
    revision.after.count === revision.before.count,
    'a re-rating updates the row rather than adding one',
    `${revision.before.count} -> ${revision.after.count}`,
  );
  check(revision.after.rating === '5', 'the re-rating is on the row', `expected 5, found ${revision.after.rating}`);

  /* ---- grouping by authority and by rating ---- */

  await evaluate("window.__foodDemo.fhrsGrid.columns.group(['authority'])");
  await sleep(600);
  const groupedAuthority = await evaluate(`(() => {
    const d = window.__foodDemo;
    let groups = 0;
    d.fhrsGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups, rows: d.fhrsGrid.rows.count() };
  })()`);
  check(groupedAuthority.groups > 0, 'grouping by local authority produces group rows', `${groupedAuthority.groups} groups`);
  await shoot('03-grouped-by-authority');

  await evaluate("window.__foodDemo.fhrsGrid.columns.group(['rating'])");
  await sleep(600);
  const groupedRating = await evaluate(`(() => {
    const d = window.__foodDemo;
    let groups = 0;
    d.fhrsGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups };
  })()`);
  check(groupedRating.groups > 0, 'grouping by rating produces group rows', `${groupedRating.groups} groups`);
  await evaluate('window.__foodDemo.fhrsGrid.columns.group([])');
  await sleep(400);

  /* ---- the Scotland table is a separate dataset, partitioned by scheme ---- */

  await evaluate("window.__foodDemo.tabs.activate('fhis')");
  await waitFor('window.__foodDemo.fhisGrid && window.__foodDemo.fhisGrid.rows.count() > 0', 30000, 'the Scotland table');
  const fhisCheck = await evaluate(`(() => {
    const d = window.__foodDemo;
    let allFhis = true;
    d.fhisGrid.rows.forEach((r) => { if (r && r.data && r.data.scheme !== 'FHIS') allFhis = false; });
    return { rows: d.fhisGrid.rows.count(), allFhis };
  })()`);
  console.log(`  Scotland table: ${fhisCheck.rows} rows, saved data holds ${fhis.length}`);
  check(fhisCheck.rows > 0, 'the Scotland table holds rows', `${fhisCheck.rows}`);
  check(fhisCheck.allFhis, 'the Scotland table holds only FHIS businesses');
  check(fhisCheck.rows === fhis.length, 'the Scotland table matches the saved FHIS data', `${fhisCheck.rows} against ${fhis.length}`);
  await shoot('04-fhis-tab');
  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. What a visitor gets when the FSA API cannot be reached.          */
  /* =================================================================== */

  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*api.ratings.food.gov.uk*'] });
  await open(`${origin}/index.html`, 'live page, with the API unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__foodDemo;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    const freshness = document.querySelector('.freshness');
    return {
      rows: d.fhrsGrid.rows.totalCount(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      savedOnShown: freshness ? /saved copy/i.test(freshness.textContent) : false,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  rows ${fallback.rows}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.rows > 0, 'fallback: the saved copy is on screen', `${fallback.rows} rows`);
  check(fallback.painted > 0, 'fallback: the table painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(
    !!fallback.notice && /could not be reached/i.test(fallback.notice),
    'fallback: the page says the API was unreachable',
    fallback.notice,
  );
  check(fallback.savedOnShown, "fallback: the saved copy's provenance is shown");
  check(!fallback.polling, 'fallback: no poll is started against an API that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('05-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    /* ================================================================= */
    /* 3. Live.                                                          */
    /* ================================================================= */

    await open(`${origin}/index.html`, 'live');
    const live = await evaluate(`(() => {
      const d = window.__foodDemo;
      return {
        rows: d.fhrsGrid.rows.count(),
        charts: d.charts.length,
        fellBack: !!(d.timings && d.timings.fellBack),
        watermark: d.fhrsGrid.licence.watermark(),
        freshness: document.querySelector('.freshness').textContent,
        tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      };
    })()`);
    console.log(`  ${live.rows} rows from the live API; ${live.freshness}`);
    check(live.fellBack === false, 'live: the rows came from the API, not the saved copy');
    check(live.rows > 0, 'live: the table holds rows from the API', `${live.rows}`);
    check(live.charts === 4, 'live: all four charts were built', `${live.charts}`);
    check(live.watermark === false, 'live: no watermark on localhost');
    check(typeof live.tiles.businesses === 'number' && live.tiles.businesses > 0, 'live: the tiles read the API', `${live.tiles.businesses} businesses`);
    noErrors('live');
    await shoot('06-live');

    /* A poll that fails must leave the table alone and say so. */
    const failed = await evaluate(`(() => {
      const d = window.__foodDemo;
      const before = d.fhrsGrid.rows.count();
      d.onPollError(new Error('a deliberate failure, for the check'));
      return { before, after: d.fhrsGrid.rows.count(), text: document.querySelector('.freshness').textContent, className: document.querySelector('.freshness').className };
    })()`);
    check(failed.after === failed.before, 'live: a failed poll does not lose the table', `${failed.before} -> ${failed.after}`);
    check(/could not reach/i.test(failed.text), 'live: a failed poll is said out loud', failed.text);
    check(/failed/.test(failed.className), 'live: a failed poll is marked visually', failed.className);
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
