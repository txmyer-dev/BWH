import {build} from 'esbuild';

await build({
  entryPoints: ['src/workers/render-film.ts'],
  outfile: 'dist/render-film.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  alias: {'@': './src'}
});
