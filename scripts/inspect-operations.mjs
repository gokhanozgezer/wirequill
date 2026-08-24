/**
 * Prints what WireQuill discovered, and scans the database for markers that
 * must never appear in it. Used by the manual Windows smoke test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const databasePath = process.argv[2];
const markers = process.argv.slice(3);

const db = new DatabaseSync(databasePath);

console.log('operations:');
for (const row of db
  .prepare(
    'SELECT method, path_template, operation_id, observed_count FROM operations ORDER BY path_template',
  )
  .all()) {
  const method = String(row.method).padEnd(7);
  const template = String(row.path_template).padEnd(40);
  const id = String(row.operation_id).padEnd(30);
  console.log('  ' + method + template + id + 'n=' + String(row.observed_count));
}

const total = db.prepare('SELECT COUNT(*) AS c FROM observations').get();
const linked = db
  .prepare('SELECT COUNT(*) AS c FROM observations WHERE operation_id IS NOT NULL')
  .get();
console.log('observations: total=' + String(total.c) + ' linked=' + String(linked.c));

db.close();

const contents = readFileSync(databasePath).toString('latin1');
console.log('secret scan:');
for (const marker of markers) {
  const count = contents.split(marker).length - 1;
  console.log('  ' + marker + ': ' + String(count));
}
