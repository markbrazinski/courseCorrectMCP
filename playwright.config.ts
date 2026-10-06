// Connected-journey checks against the real service (built companion + MCP + SQLite) on a throwaway database.
// Interpretation is RECORDED (labeled software evidence, no paid calls); extraction replays the retained M2 readings plus
// recorded readings of the demo PDFs; swap cards are the hand-written RECORDED test fixtures (tests/fixtures/demo-cards.ts).
// The approved hand-authored recipes are listed as test fixtures (CC_FIXTURE_RECIPES=1) for the engine journeys.
import { defineConfig } from '@playwright/test';

const port = 18791;
const db = `.artifacts/e2e/e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,                       // one kitchen: the journeys share the service, as a cook would
  outputDir: '.artifacts/e2e/results',
  reporter: [['list'], ['json', { outputFile: '.artifacts/e2e/report.json' }]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run build:web && node --disable-warning=ExperimentalWarning src/service/main.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    env: { CC_PORT: String(port), CC_DB: db, CC_INTERPRETER: 'recorded', CC_EXTRACTOR: 'replay', CC_ANALYZER: 'recorded', CC_FIXTURE_RECIPES: '1', CC_OWNER_TOKEN: 'e2e-owner-key', CC_DEMO: '1', CC_ADMIN_TOKEN: 'e2e-admin-key' },
  },
});
