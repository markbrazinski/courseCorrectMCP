// Import review → rescue continuity proof (no paid calls): the real companion, MCP tools and engine on a throwaway database.
// Reading and swap cards REPLAY the retained live probe for the same PDF bytes (labelled REPLAY_OF_LIVE_PROBES /
// REPLAY_OF_LIVE_CARD_PROBE in the server log); interpretation is RECORDED; nothing is a hand-written card fixture.
// TEST-ONLY server (tests/support/server.ts). The Recipe Book lists the risotto and shortcake examples; the scone comes in through import.
import { defineConfig } from '@playwright/test';

const port = 18795;
export default defineConfig({
  testDir: 'tests/review',
  timeout: 120_000,
  expect: { timeout: 15_000 },   // the import screen paces its rows at 1.25 s each (≈9 s before the review opens)
  workers: 1,
  retries: 0,
  outputDir: '.artifacts/review/results',
  reporter: [['list'], ['json', { outputFile: '.artifacts/review/report.json' }]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run build:web && node --disable-warning=ExperimentalWarning tests/support/server.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    env: { CC_PORT: String(port), CC_DB: `.artifacts/review/review-${new Date().toISOString().replace(/[:.]/g, '-')}.db`, TEST_MODELS: 'probes', TEST_INTERPRETER: 'recorded',
      TEST_EXAMPLES: 'risotto,shortcake', CC_OWNER_TOKEN: 'review-owner-key', TEST_ADMIN_TOKEN: 'review-admin-key' },
  },
});
