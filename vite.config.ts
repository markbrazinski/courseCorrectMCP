// Builds the companion (src/web) into dist/web, which the service serves at / on the same origin as /mcp.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2022' },
  oxc: { jsx: { runtime: 'automatic' } },
});
