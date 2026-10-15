// TEST-ONLY: the deployed web handler with sign-in (gate.ts) on a local port, over the SQLite store, for trying external MCP
// clients (MCP Inspector, mcp-remote, the Python SDK, curl) without AWS. Paid services off. Usage:
//   CC_PORT=18900 CC_TEST_CODE=<code> node tests/support/gated-server.ts
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Authoring } from '../../src/authoring/drafts.ts';
import { offExtractor } from '../../src/authoring/extract.ts';
import { KvLedger, LEDGER } from '../../src/authoring/nova.ts';
import { Service } from '../../src/service/commands.ts';
import { loadContent } from '../../src/service/content.ts';
import { Gate } from '../../src/service/gate.ts';
import { app } from '../../src/service/http.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { maintenanceMode } from '../../src/service/kv.ts';
import { SqliteKv } from '../../src/service/kv-sqlite.ts';

const port = Number(process.env.CC_PORT ?? 18900), code = process.env.CC_TEST_CODE ?? 'gated-test-code';
const content = loadContent(), kv = new SqliteKv(join(mkdtempSync(join(tmpdir(), 'cc-gated-')), 'g.kv'));
await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', id: 'gated-test', grantedBy: 'test', at: '', maxCalls: {}, maxUsd: 0, projectCeilingUsd: 0, priorProjectUsd: 0, maxNewWorkspacesPerDay: 1000, v: 1 } }]);
const gate = new Gate({ kv, ledger: new KvLedger(kv), codeHashes: [createHash('sha256').update(code).digest('hex')], sessionKey: randomBytes(32), secure: false });
const workspace = (ws: string) => {
  const svc = new Service({ kv, ws, content, interpreter: noneInterpreter });
  const authoring = new Authoring({ kv, ws, content, extractor: offExtractor });
  svc.catalog = (t) => authoring.catalogIn(t);
  return { svc, authoring };
};
const handle = app({ workspace, gate, health: { interpreter: 'NONE' }, origins: (u) => [u.origin], maintenance: () => maintenanceMode(kv), webRoot: join(import.meta.dirname, '../../dist/web') });
createServer(getRequestListener((r) => handle(r), { overrideGlobalObjects: false }) as never).listen(port, '127.0.0.1', () => console.log(`GATED test server on http://127.0.0.1:${port}/`));
