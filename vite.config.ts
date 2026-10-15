// Builds the companion (src/web) into dist/web, which the service serves at / on the same origin as /mcp.
import { cpSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2022' },
  // the sample recipe PDF Add recipe offers (served after sign-in at /sample/scones-explicit.pdf)
  plugins: [{ name: 'cc-sample', closeBundle() { cpSync('samples/scones-explicit.pdf', 'dist/web/sample/scones-explicit.pdf'); } }],
  oxc: { jsx: { runtime: 'automatic' } },
});
