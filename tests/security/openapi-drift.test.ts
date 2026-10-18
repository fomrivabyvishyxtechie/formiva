import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildApp } from '../../apps/api/src/index.js';

// Report-only: the API contract is handwritten, so this lists live routes the contract does not
// mention. It never fails on drift; it only fails if the contract file cannot be read.
const { Pool } = createRequire(resolve('apps/api/package.json'))('pg') as typeof import('pg');

it('reports live routes missing from the handwritten API contract', async () => {
  const contract = readFileSync('docs/api/Formiva_API_Contract_v1.1.md', 'utf8');
  const app = await buildApp({ NODE_ENV: 'test' }, { pool: new Pool() });
  const missing = [...app.routeSecurity.keys()]
    .filter((key) => !key.startsWith('HEAD ') && key.split(' ')[1].startsWith('/v1'))
    .filter((key) => {
      const [method, path] = key.split(' ');
      return !contract.includes(`| ${method} | \`${path.replace(/:(\w+)/g, '{$1}')}\``);
    });
  if (missing.length > 0) console.warn(`API contract drift (report only):\n${missing.join('\n')}`);
  expect(contract.length).toBeGreaterThan(0);
  await app.close();
});
