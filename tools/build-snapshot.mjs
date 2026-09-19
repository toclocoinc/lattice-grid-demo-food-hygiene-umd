/**
 * Save a real run of the Food Standards Agency ratings API to `data/snapshot/`,
 * so the dashboard can also be opened with no network at all.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool:
 * nothing the page loads imports it.
 *
 * The feed code the page uses is a classic script, not a module, so it cannot
 * be imported. It is run here instead, in this process, exactly as the browser
 * runs it: the file leaves its functions on `globalThis.FoodDemo` and they are
 * read from there. One copy of the feed code, used by both.
 *
 * It saves the largest local authorities first until it reaches the target
 * row count, so each authority in the copy keeps its real, complete count
 * rather than a flat sample.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const feedFile = join(here, '..', 'src', 'fsa-feed.js');
runInThisContext(await readFile(feedFile, 'utf8'), { filename: feedFile });
const { fetchAuthorities, topAuthorities, fetchManyAuthorities, encodeRow, SNAPSHOT_COLUMNS, TARGET_ROWS } = globalThis.FoodDemo;

const started = Date.now();
console.log('Reading the list of local authorities...');
const authorities = await fetchAuthorities();
console.log(`  ${authorities.length} authorities, ${authorities.reduce((n, a) => n + a.count, 0)} businesses in total.`);

const chosen = topAuthorities(authorities, TARGET_ROWS);
console.log(`Taking the ${chosen.length} largest authorities (about ${chosen.reduce((n, a) => n + a.count, 0)} businesses).`);

const rows = await fetchManyAuthorities({
  authorities: chosen,
  concurrency: 2,
  onProgress: (done, total, received) => {
    process.stdout.write(`\r  ${done}/${total} authorities, ${received} rows received`);
  },
});
process.stdout.write('\n');

/* Sorted by id so the file is stable and diffable between runs. */
const values = rows.map(encodeRow);
values.sort((a, b) => a[0] - b[0]);

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  rows: values.length,
  authorities: chosen.length,
  totalAuthorities: authorities.length,
  totalBusinesses: authorities.reduce((n, a) => n + a.count, 0),
  source: 'Food Standards Agency food hygiene rating scheme (FHRS and FHIS)',
  sourceUrl: 'https://ratings.food.gov.uk/open-data',
  apiUrl: 'https://api.ratings.food.gov.uk',
  licence: 'Open Government Licence v3.0',
  columns: SNAPSHOT_COLUMNS,
  authoritiesList: chosen.map((a) => ({ name: a.name, count: a.count, scheme: a.scheme })),
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'establishments.json'), JSON.stringify(values));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

const bytes = (await stat(join(outDir, 'establishments.json'))).size;
console.log(`\nSaved ${values.length} businesses across ${chosen.length} authorities in ${seconds}s.`);
console.log(`establishments.json is ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
