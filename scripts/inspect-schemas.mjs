/**
 * Prints the schemas WireQuill materialised from an operation row, and scans
 * the database for values that must never be in it.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { materializeSchema } from '../packages/wirequill/dist/index.js';

const databasePath = process.argv[2];
const markers = process.argv.slice(3);

const db = new DatabaseSync(databasePath);
const rows = db
  .prepare(
    'SELECT method, path_template, observed_count, request_bodies_evidence_json, responses_evidence_json FROM operations ORDER BY path_template',
  )
  .all();
db.close();

function show(label, evidence) {
  const schema = JSON.stringify(materializeSchema(evidence), null, 2);
  console.log('  ' + label);
  for (const line of schema.split('\n')) {
    console.log('    ' + line);
  }
}

for (const row of rows) {
  console.log('');
  console.log(row.method + ' ' + row.path_template + '  (observed ' + row.observed_count + ')');

  for (const [mediaType, bucket] of Object.entries(JSON.parse(row.request_bodies_evidence_json))) {
    show(
      'request ' +
        mediaType +
        '  seen=' +
        bucket.observedCount +
        ' analyzed=' +
        bucket.analyzableCount,
      bucket.schemaEvidence,
    );
  }

  for (const [status, entry] of Object.entries(JSON.parse(row.responses_evidence_json))) {
    const mediaTypes = Object.entries(entry.content);

    if (mediaTypes.length === 0) {
      console.log('  response ' + status + '  (no content)');
      continue;
    }

    for (const [mediaType, bucket] of mediaTypes) {
      show('response ' + status + ' ' + mediaType, bucket.schemaEvidence);
    }
  }
}

const contents = readFileSync(databasePath).toString('latin1');
console.log('');
console.log('value scan:');
for (const marker of markers) {
  console.log('  ' + marker + ': ' + String(contents.split(marker).length - 1));
}
