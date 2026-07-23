/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const commands = [
  ['npm', ['run', 'check:vault-catalog-bounds']],
  [
    'npx',
    [
      'vitest',
      'run',
      'src/storage/indexeddb-vault-catalog.gate.test.ts',
      '--coverage=false',
      '--maxWorkers=1',
    ],
  ],
  ['npm', ['run', 'build']],
];
const commandResults = [];
for (const [command, args] of commands) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  commandResults.push({
    command: [command, ...args].join(' '),
    durationMs: Date.now() - startedAt,
    exitCode: result.status ?? 1,
  });
  if (result.status !== 0) break;
}

const root = 'docs/delivery/slices/S35-vault-catalog-local-gate';
await mkdir(`${root}/raw`, { recursive: true });
const metrics = await readJson('.vault-catalog-gate-metrics.json');
await unlink('.vault-catalog-gate-metrics.json').catch(() => undefined);
const files = [
  'package-lock.json',
  'package.json',
  'src/application/vault-catalog.ts',
  'src/storage/indexeddb-vault-catalog.ts',
  'src/main.ts',
];
const digests = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ]),
  ),
);
const passed =
  commandResults.length === commands.length &&
  commandResults.every(({ exitCode }) => exitCode === 0);
const capture = {
  commands: commandResults,
  environment: 'Node + fake-indexeddb production-adapter qualification',
  metrics,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  timestamp: new Date().toISOString(),
};
await writeFile(`${root}/raw/capture.json`, `${JSON.stringify(capture, null, 2)}\n`);
await writeFile(
  `${root}/results.json`,
  `${JSON.stringify({ digests, metrics, status: passed ? 'PASS' : 'FAIL' }, null, 2)}\n`,
);
await writeFile(
  `${root}/README.md`,
  `# S35 Vault Catalog local Gate\n\nStatus: **${passed ? 'PASS' : 'FAIL'}** for the production adapter under fake-indexeddb.\n\nThis run proves deterministic 100k adapter bounds and the production bundle/static wiring checks. It does not replace the separately required interactive installed-Obsidian host observation.\n`,
);
await writeFile(
  `${root}/performance.md`,
  `# Performance\n\n\`\`\`json\n${JSON.stringify(metrics, null, 2)}\n\`\`\`\n`,
);
await writeFile(
  `${root}/test-results.md`,
  `# Test results\n\n${commandResults.map((item) => `- ${item.exitCode === 0 ? 'PASS' : 'FAIL'} \`${item.command}\` (${item.durationMs} ms)`).join('\n')}\n`,
);
await writeFile(
  `${root}/risk-register.md`,
  '# Risk register\n\n- Installed desktop Obsidian and mobile WebKit resource observations remain a release qualification step; fake-indexeddb cannot prove host heap or input-frame budgets.\n',
);
await writeFile(
  `${root}/source-manifest.md`,
  `# Source Manifest\n\n${files.map((file) => `- \`${file}\`: \`${digests[file]}\``).join('\n')}\n`,
);
process.exitCode = passed ? 0 : 1;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
