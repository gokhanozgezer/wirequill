/**
 * Builds the OpenAPI document from a WireQuill database and prints it, then
 * scans it for values that must never appear. Used by the manual smoke test.
 */
import { DatabaseSync } from 'node:sqlite';
import { OpenApiService, SqliteStorage, loadConfig } from '../packages/wirequill/dist/index.js';

const projectRoot = process.argv[2];
const target = process.argv[3];
const markers = process.argv.slice(4);

const config = loadConfig({ target }, { cwd: projectRoot, env: {} });
const storage = new SqliteStorage({ databasePath: config.storage.databasePath });
storage.initialize();

const db = new DatabaseSync(config.storage.databasePath);
const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get();
db.close();

const service = new OpenApiService({
  config,
  storage,
  workspaceId: String(workspace.id),
});

const document = service.getDocument();
const json = JSON.stringify(document, null, 2);

console.log(json);
console.log('');
console.log('paths: ' + String(Object.keys(document.paths).length));
console.log('revision: ' + String(document['x-wirequill'].revision));
console.log('');
console.log('value scan:');
for (const marker of markers) {
  console.log('  ' + marker + ': ' + String(json.split(marker).length - 1));
}

storage.close();
