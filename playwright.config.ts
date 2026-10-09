// Connected-journey checks against the real service code (built companion + MCP + SQLite) on a throwaway database, started
// through the TEST-ONLY server (tests/support/server.ts), never the product entry point.
// Interpretation is RECORDED (labeled software evidence, no paid calls); extraction replays the retained M2 readings plus
// recorded readings of the demo PDFs; swap cards are the hand-written RECORDED test fixtures (tests/fixtures/demo-cards.ts).
// Every owner-authored example recipe is listed, as in the product.
import { defineConfig } from '@playwright/test';

const port = 18791;
const db = `.artifacts/e2e/e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },   // the import screen paces its rows at 1.25 s each (≈9 s before the review opens)
  workers: 1,                       // one kitchen: the journeys share the service, as a cook would
  outputDir: '.artifacts/e2e/results',
  reporter: [['list'], ['json', { outputFile: '.artifacts/e2e/report.json' }]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run build:web && node --disable-warning=ExperimentalWarning tests/support/server.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    env: { CC_PORT: String(port), CC_DB: db, TEST_MODELS: 'fixtures', TEST_INTERPRETER: 'recorded', TEST_EXAMPLES: 'all', CC_OWNER_TOKEN: 'e2e-owner-key', TEST_ADMIN_TOKEN: 'e2e-admin-key' },
  },
});
