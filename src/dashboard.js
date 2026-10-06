/**
 * The dashboard: one stream of rated food businesses, and every view built on
 * top of it.
 *
 * The data router is the hub. Nothing here fetches anything and nothing here
 * reaches for the grid's globals: every factory is handed in, so this file is
 * the same whether the library arrived by script tag, as it does here, or by
 * import, as it does in the ESM edition of this demo.
 *
 * How the pieces fit together:
 *
 *   the API  ->  the router  ->  the FHRS grid  ->  the tiles
 *                             ->  the FHIS grid      the four charts
 *
 * The FHRS table (England, Wales and Northern Ireland, ratings 0-5) is the
 * primary view: the tiles and charts read it. The FHIS table (Scotland, "Pass"
 * or "Improvement Required") is a second dataset partitioned by the router on
 * `scheme`, so the two rating systems never share a column of figures.
 *
 * A classic script: it reads the constants from `FoodDemo`, put there by
 * `fsa-feed.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { RATING_ORDER, RATING_COLOURS, SCHEMES } = root.FoodDemo;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** One number, written the way a reader expects to see it. */
  function commas(value) {
    return Number(value || 0).toLocaleString('en-GB');
  }

  /** A clock time, local to whoever is reading. */
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /**
   * The position of a rating in the canonical order, so "5" sorts before "4"
   * and the non-numeric states come after the scale. Unknown labels go last.
   *
   * @param {string} label a rating label
   * @returns {number} its position
   */
  function ratingOrder(label) {
    const index = RATING_ORDER.indexOf(label);
    return index === -1 ? RATING_ORDER.length : index;
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The establishment columns, grouped under three headings.
   *
   * The rating column carries a comparator of its own, because a plain text
   * sort would put "0" before "5". The comparator orders by the canonical
   * rating order, so a sort and a group both run best first.
   *
   * @returns {object[]} the column definitions
   */
  function establishmentColumns() {
    return [
      {
        title: 'The business',
        columns: [
          {
            id: 'name',
            field: 'name',
            title: 'Business',
            filter: { type: 'text' },
            layout: { width: 300 },
          },
          {
            id: 'type',
            field: 'type',
            title: 'Business type',
            filter: { type: 'set' },
            layout: { width: 200 },
          },
          {
            id: 'postcode',
            field: 'postcode',
            title: 'Postcode',
            filter: { type: 'text' },
            layout: { width: 110, hidden: true },
          },
        ],
      },
      {
        title: 'The rating',
        columns: [
          {
            id: 'rating',
            field: 'rating',
            title: 'Rating',
            value: { compare: (a, b) => ratingOrder(a) - ratingOrder(b) },
            filter: { type: 'set' },
            layout: { width: 150 },
          },
          {
            id: 'score',
            field: 'score',
            title: 'Score',
            type: 'number',
            format: { decimals: 1 },
            filter: { type: 'number' },
            total: 'avg',
            groupTotal: 'avg',
            layout: { width: 90, hidden: true },
          },
          {
            id: 'scheme',
            field: 'scheme',
            title: 'Scheme',
            filter: { type: 'set' },
            layout: { width: 90, hidden: true },
          },
          {
            id: 'ratingDate',
            field: 'ratingDate',
            title: 'Rated',
            type: 'date',
            filter: { type: 'date' },
            layout: { width: 110 },
          },
          {
            id: 'ratingYear',
            field: 'ratingYear',
            title: 'Year rated',
            type: 'number',
            filter: { type: 'number' },
            layout: { width: 90, hidden: true },
          },
        ],
      },
      {
        title: 'Where',
        columns: [
          {
            id: 'authority',
            field: 'authority',
            title: 'Local authority',
            filter: { type: 'set' },
            layout: { width: 210 },
          },
          /* Always 1. It is what the charts and a group subtotal count. */
          {
            id: 'count',
            field: 'count',
            title: 'Businesses',
            type: 'number',
            total: 'sum',
            groupTotal: 'sum',
            filter: { type: 'none' },
            layout: { width: 90, hidden: true },
          },
        ],
      },
    ];
  }

  /**
   * The traffic lights on the rating column.
   *
   * These are conditional formatting rules the grid holds as runtime state, so
   * a reader can open the Formatting panel and change them.
   *
   * @returns {object} rules keyed by column id
   */
  function formattingRules() {
    const ratingRules = RATING_ORDER.filter((label) => RATING_COLOURS[label]).map((label) => ({
      id: `rating-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      label: `Rating ${label}`,
      when: { op: 'eq', value: label },
      style: { ...RATING_COLOURS[label], fontWeight: '600', textAlign: 'center' },
    }));
    return { rating: ratingRules };
  }

  /**
   * The shared grid settings both tables use.
   *
   * @param {string} title the table's heading
   * @returns {object} a partial grid config
   */
  function baseGridConfig(title) {
    return {
      rowKey: 'id',
      columns: establishmentColumns(),
      formatting: formattingRules(),
      theme: 'light',
      density: 'compact',
      stripedRows: true,
      columnMenu: true,
      groupPanel: true,
      statusBar: true,
      find: true,
      grandTotalRow: 'bottom',
      groupDefaultExpanded: 0,
      toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
      selection: 'multiple',
      /* A re-rated business lights up rather than changing silently. */
      highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
      title,
    };
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Build the whole page into `root`.
   *
   * @param {object} options
   * @param {HTMLElement} options.root where the dashboard is drawn
   * @param {Function} options.createGrid the grid factory
   * @param {Function} options.createChart the charts module's factory
   * @param {Function} options.createKPI the KPI module's factory
   * @param {Function} options.createTabs the tabs module's factory
   * @param {Function} options.createDataRouter the data router module's factory
   * @param {object[]} options.rows the businesses to start with
   * @param {object} options.meta where the data came from, and when
   * @returns {object} the pieces that were built, for a caller that wants them
   */
  function buildDashboard({
    root: host,
    createGrid,
    createChart,
    createKPI,
    createTabs,
    createDataRouter,
    rows,
    meta,
  }) {
    host.textContent = '';

    const built = {
      fhrsGrid: null,
      fhisGrid: null,
      router: null,
      kpi: null,
      charts: [],
      tabs: null,
      /* Everything the page currently holds, by id. The router drives the
         views; this is what the lazily-built Scotland table is filled from. */
      store: new Map(),
      status: { lastPoll: null, lastError: null, polls: 0, revisions: 0, arrivals: 0, dropped: 0 },
    };

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'Food hygiene ratings across the UK, as they stand'));
    heading.append(
      el(
        'p',
        'lede',
        'Every food business the Food Standards Agency has rated, grouped by local authority and rating, ' +
          'with the distributions drawn live. Over half a million businesses are rated nationwide; this page ' +
          'holds the largest local authorities, and each one keeps its real, complete count.',
      ),
    );
    if (meta.fellBack) {
      heading.append(
        el(
          'p',
          'notice',
          'The Food Standards Agency API could not be reached, so this is the saved copy. Reloading the page will try again.',
        ),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
    const liveDot = el('span', 'dot');
    if (meta.live) modePill.prepend(liveDot);
    const freshness = el('span', 'freshness', 'Waiting for the first update...');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the tiles ---------------- */

    const kpiHost = el('section', 'kpi-strip');
    kpiHost.setAttribute('aria-label', 'Headline figures');
    const panelHost = el('div', 'kpi-panel');
    const namedTile = el('div', 'kpi-named');
    const namedValue = el('div', 'kpi-named-value', 'No data');
    const namedLabel = el('div', 'kpi-named-label', 'Most common business type in view');
    namedTile.append(namedValue, namedLabel);
    kpiHost.append(panelHost, namedTile);
    host.append(kpiHost);

    /* ---------------- the charts ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'Charts');
    const chartBoxes = [];
    for (let i = 0; i < 4; i += 1) {
      const box = el('div', 'chart-box');
      chartHost.append(box);
      chartBoxes.push(box);
    }
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    /* ---------------- the tables ---------------- */

    const tabsHost = el('section', 'tabs-host');
    host.append(tabsHost);

    const tabs = createTabs(tabsHost, {
      createGrid,
      ariaLabel: 'Food hygiene views',
      tabs: [
        {
          id: 'fhrs',
          label: 'FHRS — England, Wales & NI',
          badge: true,
          config: {
            ...baseGridConfig('Food businesses rated by the FHRS (England, Wales and Northern Ireland)'),
            rows: [],
          },
        },
        {
          id: 'fhis',
          label: 'FHIS — Scotland',
          badge: true,
          config: {
            /* Scotland runs a different scheme: "Pass" or "Improvement Required"
               rather than a 0-5 score. It is partitioned off by the router, not
               filtered out of the first table, because the two scales do not mix. */
            ...baseGridConfig('Food businesses under the Scottish FHIS'),
            rows: [],
          },
        },
      ],
    });
    built.tabs = tabs;
    built.fhrsGrid = tabs.tab('fhrs');

    /* ---------------- the router ---------------- */

    /*
     * One stream in, two tables out, split on `scheme`. A business belongs to
     * exactly one scheme, so the two tables never claim the same row. The
     * counting subscriber below matches every row, though, which is what the
     * "N new, M re-rated" readout under the masthead reads; `overlap: true` is
     * what lets one row reach both its table and that subscriber.
     */
    const router = createDataRouter({
      key: (row) => (row.scheme === SCHEMES.FHIS ? 'fhis' : 'fhrs'),
      rowKey: 'id',
      overlap: true,
    });
    built.router = router;

    router.attach(built.fhrsGrid, (row) => row.scheme === SCHEMES.FHRS);

    /* A route that renders nothing: it counts what arrives, for the readout
       under the masthead. */
    router.subscribe(() => true, (change) => {
      built.status.arrivals += (change.add || []).length;
      built.status.revisions += (change.update || []).length;
    });

    /**
     * Put rows into the store and through the router.
     *
     * @param {object[]} incoming the rows to apply
     * @returns {number} how many rows were applied
     */
    const ingest = (incoming) => {
      if (!incoming || !incoming.length) return 0;
      for (const row of incoming) built.store.set(row.id, row);
      router.apply(incoming.map((row) => ({ op: 'upsert', row })));
      built.status.dropped = router.dropped || 0;
      return incoming.length;
    };

    /* The Scotland table is built the first time its tab is opened, so it is
       attached to the router at that moment and filled from the store. */
    const attachFhis = () => {
      if (built.fhisGrid) return;
      const grid = tabs.tab('fhis');
      if (!grid) return;
      built.fhisGrid = grid;
      router.attach(grid, (row) => row.scheme === SCHEMES.FHIS);
      /* A snapshot is a keyed diff, so this fills the new table without
         repainting the one that was already there. */
      router.load([...built.store.values()]);
    };
    tabs.on('tab:changed', (event) => {
      if (event.id === 'fhis') attachFhis();
    });

    /* The first load. A snapshot is a keyed diff, so calling this again later
       updates what changed rather than repainting everything. */
    for (const row of rows) built.store.set(row.id, row);
    router.load([...built.store.values()]);

    /* ---------------- the tiles, bound to the FHRS table ---------------- */

    const kpi = createKPI(panelHost, {
      /* Bound to the FHRS table. The panel reads what the table currently
         matches and follows it on its own, so a filter or a grouping moves the
         figures without the host handing it anything. */
      grid: built.fhrsGrid,
      rowKey: 'id',
      /* The columns the custom tiles and the named reading below need on each
         projected row. */
      fields: ['score', 'authority', 'type'],
      columns: 5,
      ariaLabel: 'Headline figures',
      tiles: [
        { id: 'businesses', label: 'Businesses in view', aggregation: 'count', format: 'number' },
        {
          id: 'rated5',
          label: 'Rated 5',
          aggregation: 'custom',
          format: 'number',
          compute: (tileRows) => tileRows.filter((row) => row.score === 5).length,
        },
        {
          id: 'share5',
          label: 'Share rated 5',
          aggregation: 'custom',
          format: { type: 'number', decimals: 1 },
          compute: (tileRows) => {
            const scored = tileRows.filter((row) => typeof row.score === 'number');
            if (!scored.length) return null;
            return (scored.filter((row) => row.score === 5).length / scored.length) * 100;
          },
        },
        {
          id: 'avgScore',
          label: 'Average score',
          aggregation: 'custom',
          format: { type: 'number', decimals: 2 },
          compute: (tileRows) => {
            const scored = tileRows.filter((row) => typeof row.score === 'number');
            if (!scored.length) return null;
            return scored.reduce((sum, row) => sum + row.score, 0) / scored.length;
          },
        },
        {
          id: 'authorities',
          label: 'Authorities in view',
          aggregation: 'custom',
          format: 'number',
          compute: (tileRows) => new Set(tileRows.map((row) => row.authority).filter(Boolean)).size,
        },
      ],
    });
    built.kpi = kpi;

    /**
     * Name the most common business type in view.
     *
     * A phrase rather than a number, so it is drawn by hand from the bound
     * panel's own rows rather than as a tile.
     */
    const refreshNamedTile = () => {
      const byType = new Map();
      kpi.rows.forEach((row) => {
        const type = row.type || 'Unlisted';
        byType.set(type, (byType.get(type) || 0) + 1);
      });
      let best = null;
      for (const [type, count] of byType) if (!best || count > best.count) best = { type, count };
      if (!best) {
        namedValue.textContent = 'No data';
        namedLabel.textContent = 'Most common business type in view';
        return;
      }
      namedValue.textContent = best.type;
      namedLabel.textContent = `Most common in view, ${commas(best.count)} businesses`;
    };
    kpi.on('change', refreshNamedTile);
    refreshNamedTile();

    /* ---------------- the charts, bound to the FHRS table ---------------- */

    const chartSpecs = [
      {
        type: 'histogram',
        /* The FHRS 0-5 score, binned into its own six buckets. Businesses
           that are exempt or awaiting inspection carry no score and are
           left out, because a number they do not have must not be invented. */
        y: 'score',
        buckets: 6,
        title: 'How many businesses at each rating',
        axis: { x: 'Rating (0–5)', y: 'Businesses' },
        legend: false,
      },
      {
        type: 'bar',
        x: 'rating',
        y: 'count',
        title: 'Businesses at each rating',
        axis: { y: 'Businesses', x: { labels: true } },
        legend: false,
      },
      {
        type: 'bar',
        x: 'ratingYear',
        y: 'count',
        title: 'When they were last inspected',
        axis: { y: 'Businesses', x: { labels: true, rotate: 'auto' } },
        legend: false,
      },
      {
        type: 'bar',
        x: 'authority',
        y: 'count',
        title: 'Businesses by local authority',
        axis: { y: 'Businesses', x: { labels: true, rotate: 'auto' } },
        legend: false,
      },
    ];

    chartSpecs.forEach((spec, index) => {
      try {
        built.charts.push(createChart({ grid: built.fhrsGrid, container: chartBoxes[index], ...spec }));
      } catch (error) {
        chartBoxes[index].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
        console.error('[food hygiene demo] chart', spec.type, error);
      }
    });

    /* ---------------- the controls ---------------- */

    const activeGrid = () => (tabs.activeId === 'fhis' ? built.fhisGrid : built.fhrsGrid);

    const button = (label, onClick, className) => {
      const node = el('button', className || 'action', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    };

    const group = (ids) => () => {
      const grid = activeGrid();
      if (grid) grid.columns.group(ids);
    };

    actions.append(el('span', 'actions-label', 'Group by'));
    actions.append(button('Local authority', group(['authority'])));
    actions.append(button('Rating', group(['rating'])));
    actions.append(button('Authority, then rating', group(['authority', 'rating'])));
    actions.append(button('No grouping', group([])));

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Order by'));
    actions.append(button('Name A–Z', () => activeGrid() && activeGrid().sort.set([{ col: 'name', dir: 'asc' }])));
    actions.append(button('Best rating first', () => activeGrid() && activeGrid().sort.set([{ col: 'rating', dir: 'desc' }])));
    actions.append(button('Most recently rated', () => activeGrid() && activeGrid().sort.set([{ col: 'ratingDate', dir: 'desc' }])));

    const worstButton = button('Only the worst ratings', () => {
      const on = worstButton.getAttribute('aria-pressed') === 'true';
      const grid = activeGrid();
      const worst = ['0', '1', '2', 'Improvement required'];
      /* A named row predicate: registering it activates it, and removing it by
         name leaves any other filter the reader has set untouched. */
      grid.filters.where('worst', on ? null : (row) => worst.includes(row.rating));
      worstButton.setAttribute('aria-pressed', String(!on));
      worstButton.classList.toggle('on', !on);
    }, 'action toggle');
    worstButton.setAttribute('aria-pressed', 'false');
    actions.append(el('span', 'actions-gap'));
    actions.append(worstButton);
    built.worstButton = worstButton;

    /* ---------------- the live readout ---------------- */

    /**
     * Say when the data last moved, and say plainly when it stopped.
     *
     * @param {object} state what the poller reported
     */
    const setFreshness = (state) => {
      if (!meta.live) {
        const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
        freshness.textContent = `A saved copy of the food hygiene data, taken on ${saved}.`;
        freshness.className = 'freshness';
        return;
      }
      if (built.status.lastError) {
        freshness.textContent = built.status.lastPoll
          ? `Could not reach the API. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
          : 'Could not reach the API.';
        freshness.className = 'freshness failed';
        return;
      }
      if (!built.status.lastPoll) {
        freshness.textContent = 'Waiting for the first update...';
        freshness.className = 'freshness';
        return;
      }
      const revised = built.status.revisions;
      freshness.textContent =
        `Updated ${clockText(built.status.lastPoll)}. ` +
        `${commas(built.status.arrivals)} new, ${commas(revised)} re-rated since the page opened.`;
      freshness.className = 'freshness';
    };
    built.setFreshness = setFreshness;

    /**
     * Take a poll's result: apply it, refresh the figures and say so.
     *
     * @param {object} result what `startPolling` reported
     */
    built.onPoll = (result) => {
      built.status.lastPoll = result.fetchedAt || Date.now();
      built.status.lastError = null;
      built.status.polls += 1;
      liveDot.classList.add('beat');
      setTimeout(() => liveDot.classList.remove('beat'), 900);
      ingest(result.rows);
      setFreshness();
    };

    /**
     * Take a failed poll: keep the table, say what happened.
     *
     * @param {Error} error what went wrong
     */
    built.onPollError = (error) => {
      built.status.lastError = String((error && error.message) || error);
      setFreshness();
      console.warn('[food hygiene demo] a poll failed:', built.status.lastError);
    };

    /* A hook for the verification script and for anyone poking at the page:
       push rows through exactly the path a poll uses. */
    built.ingest = ingest;

    setFreshness();

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const line = el('p', null, 'Ratings data from the ');
    const link = el('a', null, 'Food Standards Agency food hygiene rating scheme');
    link.href = 'https://ratings.food.gov.uk/open-data';
    link.rel = 'noopener';
    line.append(link);
    line.append(
      document.createTextNode(
        '. The data are published under the Open Government Licence and are free to use. ' +
          'England, Wales and Northern Ireland run the FHRS (ratings 0 to 5); Scotland runs the FHIS ' +
          '("Pass" or "Improvement Required"). Ratings are the local authority\u2019s most recent published decision.',
      ),
    );
    footer.append(line);

    const creditLine = el('p', null, 'Built with ');
    const creditLink = el('a', null, 'Lattice Grid');
    creditLink.href = 'https://www.latticegrid.dev/';
    creditLine.append(creditLink);
    creditLine.append(document.createTextNode('.'));
    footer.append(creditLine);

    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      kpi.destroy();
      router.destroy();
      tabs.destroy();
    };

    return built;
  }

  root.FoodDemo.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
