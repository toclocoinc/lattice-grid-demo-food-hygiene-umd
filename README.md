# Food hygiene ratings across the UK, as they stand

A dashboard of every food business the Food Standards Agency has rated, grouped
by local authority and rating, built on Lattice Grid loaded by `<script>` tag:
no npm install, no bundler, no build step, no `type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-food-hygiene-umd/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |
| The same demo as an ESM package | [lattice-grid-demo-food-hygiene](https://github.com/toclocoinc/lattice-grid-demo-food-hygiene) |

It is one stream of rated businesses with several views on it: a table for the
FHRS (England, Wales and Northern Ireland, ratings 0–5), a second table for the
FHIS (Scotland, "Pass" or "Improvement Required"), a strip of headline figures
and four distribution charts. They all read the same stream, so narrowing the
table moves everything else with it.

The point of the demo is scale and grouping. Over half a million businesses are
rated nationwide; this page holds the largest local authorities — about a
hundred thousand businesses — and each authority keeps its real, complete
count. Group the table by authority, by rating, or by both, and the
distributions above redraw over exactly the rows you are looking at.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.63.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build (`*.min.js`, beside the `*.esm.min.js`
the ESM edition imports) and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `setLicence` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | `createDataRouter` |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | `createTabs` |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything, so a tag that did not load
is reported as a sentence rather than as an error from inside the grid.

Every address names the exact release, `1.63.0`, and every tag carries the
`integrity` hash of the file it expects. The page cannot quietly pick up a
different build than the one it was checked against, and the browser refuses
a file that does not match. The hashes are the SHA-384 of the published files.

The demo's own code is four classic scripts, loaded in order after the
library: `src/licence.js`, `src/fsa-feed.js`, `src/dashboard.js`, `main.js`.
Each file wraps itself in a function and puts what it offers on one plain
object, `FoodDemo`, for the next file to read. `src/dashboard.js` is handed
the grid's factories as arguments and never touches a global itself.

## Running it

You need nothing but a browser and a way to serve the folder, because the
page fetches its data with `fetch()` and browsers will not do that from
`file://`. Any static server will do; one is included:

```
node tools/serve.mjs
```

That prints an address. Open it.

| Address | What you get |
| --- | --- |
| `/` | live, reading the FSA ratings API and polling for changes |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no API needed |

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

## What it shows

**One stream, two schemes.** The Food Standards Agency runs two rating systems
side by side: the FHRS in England, Wales and Northern Ireland (ratings 0 to 5),
and the FHIS in Scotland ("Pass" or "Improvement Required"). The data router
partitions the single stream on `scheme`, so the two tables never mix a
five-point scale with a pass/fail one. Each table is a real dataset, not a
filter over the other.

**A real, large dataset.** The saved copy holds the eighteen largest local
authorities — about a hundred thousand businesses, each with its true,
uncapped count. Group by authority and every group total is the authority's
actual number of businesses, not a sampled fraction.

**Distributions, not just a table.** Four charts draw straight from the FHRS
table's own rows: a histogram of the 0–5 scores, a bar of businesses at each
rating, a bar of when businesses were last inspected, and a bar of businesses
by local authority. Filter the table and every chart follows.

**Figures that follow the table.** The strip of tiles is a KPI panel bound to
the FHRS table, so it reads whatever the table currently matches: businesses
in view, how many are rated 5, the share rated 5, the average score, and how
many authorities are in view. Turn on "Only the worst ratings" and the counts,
the charts and the tiles all move together.

**Ratings that read as colours.** The rating column carries traffic-light
formatting rules the grid holds as runtime state, so a reader can open the
Formatting panel and change them. "Awaiting inspection" carries no score, and
the page never invents one for it.

**A feed that can fail.** If a poll cannot reach the FSA the page says so and
keeps showing what it already had. If the API cannot be reached when the page
first opens, it shows the saved copy instead and says so under the title.

## The data

Everything comes from the Food Standards Agency food hygiene rating scheme:

- <https://ratings.food.gov.uk/open-data>

The page reads the authority list and the establishments for the largest
authorities from the public API, which needs no key — only the `x-api-version`
header the service asks for:

- `https://api.ratings.food.gov.uk/Authorities/basic`
- `https://api.ratings.food.gov.uk/Establishments?localAuthorityId=…&pageSize=…&pageNumber=…`

The API returns JSON or XML; this demo asks for JSON. The data are published
under the Open Government Licence v3.0 and are free to use.

A few things worth knowing about the data:

- `FHRSID` is the unique identifier across the whole dataset. The router keys
  on it, so a re-rating lands on the business it belongs to rather than adding
  a second row.
- England, Wales and Northern Ireland use the FHRS (0–5); Scotland uses the
  FHIS ("Pass" or "Improvement Required"). A Scottish "Pass" is not converted
  into a number.
- "Exempt" and "Awaiting inspection" are real states, not gaps: a business can
  be exempt from the scheme or waiting for its first inspection. Neither has a
  score, and nothing on the page invents one.
- "Awaiting inspection" records carry no real date — the API returns the year
  1900 or 1901 as a placeholder. Those are treated as unrated, so they do not
  spike the "when inspected" chart two centuries back.
- Each establishment carries far more than the page shows (full address, email,
  website, geocoding, the raw hygiene scores). Only the fields the grid needs
  are read out, and the snapshot stores those compactly.

## Files

```
index.html                page shell, and the six library tags
main.js                   works out where the data comes from, then starts
src/licence.js            the key for this demo's own published address
src/fsa-feed.js           the API: authorities, establishments, parsing, polling
src/dashboard.js          the views: router, tables, tiles, charts, tabs
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works without the API
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

The saved copy is a compact array of arrays — one value per column, in the
order `meta.json` documents — so a hundred thousand businesses stay a
manageable download. The browser unpacks it with the same code that parses the
live API, so the two paths produce identical rows.

## Building the saved copy

```
node tools/build-snapshot.mjs
```

It reads the authority list, takes the largest authorities until it reaches
about a hundred thousand businesses, and writes the compact form to
`data/snapshot/`. Re-run it to refresh the copy.

## Checking it

```
node tools/verify.mjs   # open the page in a real browser and assert
node tools/verify.mjs --all   # also open the live API
```

`tools/verify.mjs` is not a smoke test. It first insists on how the library
arrived: no `type="module"` script anywhere on the page, five script tags
pointing at the pinned release on the CDN, each with an integrity hash, and
each leaving the global it documents. It then recomputes the headline figures
from the saved data and compares them with what the page is showing, narrows
the table and insists the tiles and charts moved with it, pushes a re-rating
through and insists the row count did not change, groups by authority and by
rating, opens the Scotland table and insists it holds only FHIS businesses, and
finally blocks the FSA API in the browser and insists the saved copy appears
with a notice saying why. The GitHub Pages workflow runs it before every
publish.

## Licence

The demo code is MIT. See `LICENSE`.

The ratings data is from the Food Standards Agency, published under the Open
Government Licence v3.0.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).
