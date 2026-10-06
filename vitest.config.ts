// Vitest runs the acceptance suite from the repo root (vite.config.ts roots Vite at src/web for the companion build).
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/acceptance/**/*.test.ts'] } });
