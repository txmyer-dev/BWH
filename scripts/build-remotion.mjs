import {rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bundle} from '@remotion/bundler';

const entryPoint = resolve('src/features/film/remotion-root.tsx');
const outDir = resolve(process.env.REMOTION_BUNDLE_PATH ?? 'remotion-bundle');

await rm(outDir, {recursive: true, force: true});
await bundle({entryPoint, outDir});
