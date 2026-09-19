/**
 * The Food Standards Agency food hygiene rating feeds: reading the authority
 * list, paging each authority's establishments, and turning one record into a
 * flat row.
 *
 * Nothing here knows about the grid. It produces plain objects and hands them
 * to whoever asked, so the same code feeds the live page and the saved copy.
 *
 * The FHRS API is public and needs no key; every call carries the `x-api-version`
 * header the service requires. Scotland runs a different scheme (FHIS: "Pass"
 * or "Improvement Required") to England, Wales and Northern Ireland (FHRS:
 * "0" to "5"), so a record's scheme is kept alongside its rating.
 *
 * This is a classic script, not a module: there is no `import` or `export`
 * anywhere on this page. What this file offers is put on `FoodDemo`, a plain
 * object on the global, and the next script reads it from there. The snapshot
 * tool runs this same file under Node, which is why it looks for `globalThis`
 * rather than `window`.
 */
(function (root) {
  'use strict';

  const BASE = 'https://api.ratings.food.gov.uk';
  const API_VERSION = '2';

  /** How many of the largest authorities the live page reads. */
  const LIVE_AUTHORITY_COUNT = 6;

  /** How many rows the snapshot tool aims to save, reached by taking the
      largest authorities first. */
  const TARGET_ROWS = 100000;

  /** How often the live page asks the API for changes. Ratings are updated
      daily rather than by the minute, so this is deliberately slow. */
  const POLL_MS = 10 * 60 * 1000;

  /** The two schemes. Scotland runs FHIS; the rest of the UK runs FHRS. */
  const SCHEMES = {
    FHRS: 'FHRS',
    FHIS: 'FHIS',
  };

  /**
   * The canonical ratings, best first, with the numeric score each maps to.
   *
   * A score exists only for the FHRS 0-5 scale. Everything else — the Scottish
   * "Pass"/"Improvement required" pair and the shared "Exempt" and "Awaiting"
   * states — has no number, because putting one on it would be inventing a
   * figure the scheme does not publish.
   */
  const RATINGS = [
    { label: '5', score: 5 },
    { label: '4', score: 4 },
    { label: '3', score: 3 },
    { label: '2', score: 2 },
    { label: '1', score: 1 },
    { label: '0', score: 0 },
    { label: 'Pass', score: null },
    { label: 'Pass and Eat Safe', score: null },
    { label: 'Improvement required', score: null },
    { label: 'Exempt', score: null },
    { label: 'Awaiting inspection', score: null },
    { label: 'Awaiting publication', score: null },
  ];

  const RATING_ORDER = RATINGS.map((r) => r.label);

  /** Traffic-light colours for each rating, for the conditional formatting. */
  const RATING_COLOURS = {
    '5': { background: '#1b5e20', color: '#ffffff' },
    '4': { background: '#2e7d32', color: '#ffffff' },
    '3': { background: '#f9a825', color: '#1b1b1b' },
    '2': { background: '#ef6c00', color: '#1b1b1b' },
    '1': { background: '#d84315', color: '#ffffff' },
    '0': { background: '#b3261e', color: '#ffffff' },
    Pass: { background: '#1b5e20', color: '#ffffff' },
    'Pass and Eat Safe': { background: '#1b5e20', color: '#ffffff' },
    'Improvement required': { background: '#b3261e', color: '#ffffff' },
  };

  /** The order the snapshot stores its fields in, so a compact array can be
      decoded back into a row. Shared by the browser and the snapshot tool. */
  const SNAPSHOT_COLUMNS = ['id', 'name', 'authority', 'type', 'rating', 'score', 'scheme', 'postcode', 'ratingDate'];

  /** The headers every API call sends. No key: only the version the service asks for. */
  const HEADERS = {
    'x-api-version': API_VERSION,
    Accept: 'application/json',
  };

  /**
   * Fetch JSON from the API, retrying a moment later when the service asks us
   * to slow down or has a wobble. The FHRS API rate-limits bursts, so a quick
   * pause and retry is enough rather than giving up.
   *
   * @param {string} url the endpoint
   * @param {string} describe what is being read, for the error message
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<object>} the parsed body
   */
  async function requestJson(url, describe, opts = {}) {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { signal: opts.signal, cache: 'no-store', headers: HEADERS });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`The ${describe} answered ${response.status}.`);
    }
  }

  /**
   * Canonicalise a raw rating value into a label and a score.
   *
   * The API spells a few of these inconsistently ("AwaitingInspection" in one
   * scheme, "Awaiting Inspection" in the other), so they are matched on a
   * normalised form rather than assumed. Anything not recognised is kept as
   * it arrived, with no score.
   *
   * @param {string|null} value the raw RatingValue
   * @returns {{label: string, score: number|null}}
   */
  function canonRating(value) {
    if (value == null) return { label: 'Unknown', score: null };
    const raw = String(value).trim();
    if (/^[0-5]$/.test(raw)) return { label: raw, score: Number(raw) };
    const key = raw.toLowerCase().replace(/[^a-z]/g, '');
    const known = {
      pass: { label: 'Pass', score: null },
      improvementrequired: { label: 'Improvement required', score: null },
      exempt: { label: 'Exempt', score: null },
      awaitinginspection: { label: 'Awaiting inspection', score: null },
      awaitingpublication: { label: 'Awaiting publication', score: null },
    };
    return known[key] || { label: raw, score: null };
  }

  /** An ISO timestamp to a `YYYY-MM-DD` date, or null when there is not one. */
  function dateOnly(value) {
    if (value == null || value === '') return null;
    const text = String(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }

  /** The calendar year of a `YYYY-MM-DD` date, or null. */
  function yearOf(date) {
    return date ? Number(date.slice(0, 4)) : null;
  }

  /**
   * Turn one FHRS API establishment record into a flat row.
   *
   * The record carries a great deal the demo does not need — four address
   * lines, an email, a website, geocoding, the raw hygiene scores — so only
   * the fields the grid shows are read out, defensively, because a local
   * authority may leave any of them blank.
   *
   * @param {object} est one member of an `establishments` array
   * @returns {object|null} the row, or null when the record has no identity
   */
  function toRow(est) {
    if (!est || est.FHRSID == null) return null;
    const rating = canonRating(est.RatingValue);
    let ratingDate = dateOnly(est.RatingDate);
    /* "Awaiting inspection" records carry no real date: the API returns the
       year 1900 or 1901 as a placeholder. Treat those as unrated rather than
       letting them spike the "when inspected" chart two centuries back. */
    if (ratingDate && yearOf(ratingDate) <= 1901) ratingDate = null;
    return {
      id: Number(est.FHRSID),
      name: (est.BusinessName || '').trim() || '(unnamed)',
      authority: (est.LocalAuthorityName || '').trim(),
      type: (est.BusinessType || '').trim() || 'Unlisted',
      rating: rating.label,
      score: rating.score,
      scheme: est.SchemeType === 'FHIS' ? SCHEMES.FHIS : SCHEMES.FHRS,
      postcode: (est.PostCode || '').trim(),
      ratingDate,
      ratingYear: yearOf(ratingDate),
      /* Always 1. It is what the charts and the group subtotals add up. */
      count: 1,
    };
  }

  /**
   * Pack a row into the compact array form the snapshot stores.
   *
   * @param {object} row a row from {@link toRow}
   * @returns {Array} one value per {@link SNAPSHOT_COLUMNS}
   */
  function encodeRow(row) {
    return SNAPSHOT_COLUMNS.map((col) => (col === 'score' ? row.score : row[col]));
  }

  /**
   * Unpack a compact snapshot array back into a row, deriving the fields that
   * are not stored (`ratingYear`, `count`) from the ones that are.
   *
   * @param {Array} values one value per {@link SNAPSHOT_COLUMNS}
   * @returns {object} a row in the same shape {@link toRow} produces
   */
  function decodeRow(values) {
    const row = {};
    SNAPSHOT_COLUMNS.forEach((col, index) => {
      row[col] = values[index];
    });
    row.ratingYear = yearOf(row.ratingDate);
    row.count = 1;
    return row;
  }

  /** Read the list of local authorities, each with its establishment count. */
  async function fetchAuthorities(opts = {}) {
    const body = await requestJson(`${BASE}/Authorities/basic?pageSize=10000&pageNumber=1`, 'authorities list', opts);
    return (body.authorities || []).map((a) => ({
      id: a.LocalAuthorityId,
      name: a.Name,
      count: a.EstablishmentCount,
      scheme: a.SchemeType === 2 ? SCHEMES.FHIS : SCHEMES.FHRS,
    }));
  }

  /**
   * Read every establishment for one local authority, paging as needed.
   *
   * @param {object} authority an entry from {@link fetchAuthorities}
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<object[]>} the rows
   */
  async function fetchAuthorityRows(authority, opts = {}) {
    const rows = [];
    let page = 1;
    let totalPages = 1;
    do {
      const url = `${BASE}/Establishments?localAuthorityId=${authority.id}&pageSize=5000&pageNumber=${page}`;
      const body = await requestJson(url, `${authority.name} establishments`, opts);
      for (const est of body.establishments || []) {
        const row = toRow(est);
        if (row) rows.push(row);
      }
      totalPages = body.meta ? body.meta.totalPages : 1;
      page += 1;
    } while (page <= totalPages);
    return rows;
  }

  /**
   * The largest authorities first, until their combined count reaches the
   * target. Large authorities make for a richer grouping than a flat sample
   * of the same size, because each authority keeps its real, complete count.
   *
   * @param {object[]} authorities from {@link fetchAuthorities}
   * @param {number} targetRows the number of rows to reach
   * @returns {object[]} the authorities to fetch
   */
  function topAuthorities(authorities, targetRows) {
    const sorted = [...authorities].sort((a, b) => b.count - a.count);
    const chosen = [];
    let total = 0;
    for (const authority of sorted) {
      chosen.push(authority);
      total += authority.count;
      if (total >= targetRows) break;
    }
    return chosen;
  }

  /**
   * Fetch several authorities with a bounded number of requests in flight at
   * once, reporting each authority's rows as they arrive.
   *
   * @param {object} opts
   * @param {object[]} opts.authorities the authorities to read
   * @param {number} [opts.concurrency] how many requests to run at once
   * @param {(done: number, total: number, rows: number) => void} [opts.onProgress]
   * @param {(rows: object[]) => void} [opts.onBatch] called as each authority lands
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<object[]>} all rows, in arrival order
   */
  async function fetchManyAuthorities({ authorities, concurrency = 4, onProgress, onBatch, signal }) {
    const report = onProgress || (() => {});
    const batch = onBatch || (() => {});
    const rows = [];
    let done = 0;
    let next = 0;

    const workers = Array.from({ length: Math.min(concurrency, authorities.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= authorities.length) return;
        const authority = authorities[index];
        const authorityRows = await fetchAuthorityRows(authority, { signal });
        rows.push(...authorityRows);
        done += 1;
        report(done, authorities.length, rows.length);
        batch(authorityRows);
      }
    });

    await Promise.all(workers);
    return rows;
  }

  /**
   * Read the live page's starting data: the authority list, then the largest
   * handful of authorities' establishments.
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   * @returns {Promise<{rows: object[], authorities: object[], fetchedAuthorities: object[]}>}
   */
  async function fetchInitial(opts = {}) {
    const report = opts.onProgress || (() => {});
    report('Reading the list of local authorities...', 0.05);
    const authorities = await fetchAuthorities(opts);
    const chosen = [...authorities].sort((a, b) => b.count - a.count).slice(0, LIVE_AUTHORITY_COUNT);
    report(`Reading the ${chosen.length} largest authorities...`, 0.2);
    const rows = await fetchManyAuthorities({
      authorities: chosen,
      concurrency: 3,
      signal: opts.signal,
      onProgress: (done, total, received) => {
        report(`Reading the largest authorities (${done} of ${total})...`, 0.2 + 0.75 * (done / total));
      },
    });
    report('Building the dashboard...', 1);
    return { rows, authorities, fetchedAuthorities: chosen };
  }

  /**
   * Poll the same authorities for changes and report each result.
   *
   * Ratings change when a business is re-inspected, so a re-rating lands on
   * the row it belongs to rather than adding a second one. The router keyed
   * on the FHRSID handles that.
   *
   * @param {object} opts
   * @param {object[]} opts.authorities the authorities to re-read
   * @param {(result: object) => void} opts.onPoll called with each successful poll
   * @param {(error: Error) => void} [opts.onError] called when a poll fails
   * @param {number} [opts.intervalMs] how often to poll
   * @returns {{stop: Function, pollNow: Function}} a handle that stops the polling
   */
  function startPolling({ authorities, onPoll, onError, intervalMs = POLL_MS }) {
    let stopped = false;
    let timer = null;
    let polls = 0;
    const controller = new AbortController();

    const runOnce = async () => {
      if (stopped) return;
      polls += 1;
      try {
        const rows = await fetchManyAuthorities({
          authorities,
          concurrency: 3,
          signal: controller.signal,
        });
        if (!stopped) onPoll({ rows, fetchedAt: Date.now(), poll: polls });
      } catch (error) {
        if (!stopped && onError) onError(error);
      }
    };

    timer = setInterval(runOnce, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        controller.abort();
      },
      pollNow: runOnce,
    };
  }

  /** Read the saved copy that ships with the demo. */
  async function readSnapshot() {
    const [values, meta] = await Promise.all(
      ['establishments', 'meta'].map(async (name) => {
        const response = await fetch(`./data/snapshot/${name}.json`);
        if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
        return response.json();
      }),
    );
    return { rows: values.map(decodeRow), meta: { ...meta, live: false } };
  }

  root.FoodDemo = Object.assign(root.FoodDemo || {}, {
    BASE,
    API_VERSION,
    LIVE_AUTHORITY_COUNT,
    TARGET_ROWS,
    POLL_MS,
    SCHEMES,
    RATINGS,
    RATING_ORDER,
    RATING_COLOURS,
    SNAPSHOT_COLUMNS,
    canonRating,
    toRow,
    encodeRow,
    decodeRow,
    fetchAuthorities,
    fetchAuthorityRows,
    topAuthorities,
    fetchManyAuthorities,
    fetchInitial,
    startPolling,
    readSnapshot,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
