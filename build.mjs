#!/usr/bin/env node
/**
 * Build both halves of the plugin.
 *
 * - host: `tsc` emits one ES module per source file into `lib/host/` (decorators
 *   are the standard 2023 flavour, which is what the Typert gateway reads).
 *   Nothing is bundled: the host resolves `@deepseek-ai/*` from the running DSH
 *   installation, and the plugins run unbundled so stack traces stay readable.
 * - client: esbuild bundles the React plugin into one CJS body, which is then
 *   wrapped in the loader registration the Web kernel expects
 *   (`window.__ModuleLoader__.load({ id, factory })`).
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const ID = 'dsh-feishu-contact'
const OUT = 'lib'

await mkdir(OUT, { recursive: true })

// --- host -------------------------------------------------------------------
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
})

// --- host pinyin lookup (bundled) -------------------------------------------
// `pinyin.ts` pulls in pinyin-pro's dictionary. Bundling that one module keeps
// the Host free of a runtime dependency while the rest of the host tree stays
// one-file-per-module. Runs after tsc so the bundled output wins over the emit.
await build({
  entryPoints: ['src/host/pinyin.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: `${OUT}/host/pinyin.js`,
  logLevel: 'warning',
  legalComments: 'none',
  minify: true,
})

// --- client -----------------------------------------------------------------
// Type-check first: esbuild strips types without checking them, and a missing
// import would otherwise only surface as a runtime ReferenceError in the GUI.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json'], {
  stdio: 'inherit',
})

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  outfile: `${OUT}/.client.body.js`,
  logLevel: 'warning',
  legalComments: 'none',
})

const body = await readFile(`${OUT}/.client.body.js`, 'utf8')
const wrapped =
  `window.__ModuleLoader__.load({\n` +
  `  id: ${JSON.stringify(ID)},\n` +
  `  factory: (require) => {\n` +
  `    var module = { exports: {} };\n` +
  `    var exports = module.exports;\n` +
  `${body}\n` +
  `    return module.exports;\n` +
  `  },\n` +
  `});\n`

await writeFile(`${OUT}/client.js`, wrapped)
await rm(`${OUT}/.client.body.js`, { force: true })

// The bundled pinyin module must not leave a bare import behind: a `link:`
// install would still resolve it from this repo, but a packed install would not.
const pinyinBundle = await readFile(`${OUT}/host/pinyin.js`, 'utf8')
if (/from\s*["']pinyin-pro["']/.test(pinyinBundle)) {
  throw new Error('lib/host/pinyin.js still imports pinyin-pro — the bundling step did not run after tsc')
}

console.log(`built ${OUT}/host/index.js + ${OUT}/client.js`)
