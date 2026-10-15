// Vitest runs the acceptance suite from the repo root (vite.config.ts roots Vite at src/web for the companion build).
import { defineConfig } from 'vitest/config';

// ponytail: one DynamoDB Local JVM serves every test file at once, so a slow emulator, not the code, decides the timeout there
export default defineConfig({ test: { include: ['tests/acceptance/**/*.test.ts'], testTimeout: process.env.CC_TEST_DYNAMO_ENDPOINT ? 30_000 : 10_000 } });
