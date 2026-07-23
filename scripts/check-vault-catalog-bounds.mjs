import { readFile } from 'node:fs/promises';

const storagePath = 'src/storage/indexeddb-vault-catalog.ts';
const storage = await readFile(storagePath, 'utf8');
const main = await readFile('src/main.ts', 'utf8');
const snapshotManager = await readFile(
  'src/adapters/obsidian/snapshot-annotation-manager.ts',
  'utf8',
);

const failures = [];
for (const forbidden of ['.sortBy(', '.getAll(', '.keys(', '.primaryKeys(', '.snapshot(']) {
  if (storage.includes(forbidden)) failures.push(`${storagePath} contains ${forbidden}`);
}

let cursor = 0;
while ((cursor = storage.indexOf('.toArray()', cursor)) !== -1) {
  const prefix = storage.slice(Math.max(0, cursor - 320), cursor);
  if (!prefix.includes('.limit(')) {
    failures.push(`${storagePath} has a toArray() without a nearby limit() at byte ${cursor}`);
  }
  cursor += '.toArray()'.length;
}

for (const retired of [
  'VaultAnnotationIndex',
  'VaultIndexBuilder',
  'VaultIndexCache',
  'index.json',
]) {
  if (main.includes(retired)) failures.push(`src/main.ts still wires retired ${retired}`);
}
if (snapshotManager.includes('await this.input.onRecordsChanged')) {
  failures.push('Snapshot Done still awaits the disposable Vault Catalog callback');
}
if (/snapshot-annotations[^\n]+capture-/u.test(main)) {
  failures.push('The Catalog event matcher includes Snapshot capture assets');
}

if (failures.length > 0) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exitCode = 1;
} else {
  console.log('PASS Vault Catalog production query and wiring bounds');
}
