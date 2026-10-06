// PAID live verification (owner-authorized M3 budget, ≤ $0.10): Nova interpretation and Polly speech through the real
// companion. Run deliberately with `npm run e2e:live`; never part of `npm run e2e`. Every call is in the shared ledger.
import { defineConfig } from '@playwright/test';

const port = 18792;
export default defineConfig({
  testDir: 'tests/live',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  outputDir: '.artifacts/e2e-live/results',
  reporter: [['list'], ['json', { outputFile: '.artifacts/e2e-live/report.json' }]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, trace: 'on', video: 'on' },
  webServer: {
    command: 'npm run build:web && node --disable-warning=ExperimentalWarning src/service/main.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { CC_PORT: String(port), CC_DB: `.artifacts/e2e-live/live-${Date.now()}.db`, CC_LIVE: '1', CC_INTERPRETER: 'nova', CC_SPEECH: 'polly', CC_EXTRACTOR: 'replay', CC_ADMIN_TOKEN: 'live-admin-key' },
  },
});
