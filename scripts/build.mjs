import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'lib')
mkdirSync(outDir, { recursive: true })

const hostExternal = [
  '@deepseek-ai/*',
  'mysql2',
  'mysql2/promise',
  'pg',
  '@clickhouse/client',
  'zod',
]

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: hostExternal,
  sourcemap: true,
  legalComments: 'inline',
})

const client = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.svg': 'dataurl' },
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-connection/client',
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  write: false,
  sourcemap: false,
})

const source = client.outputFiles[0].text
const indented = source.split('\n').map(line => line === '' ? line : `    ${line}`).join('\n')
writeFileSync(join(outDir, 'client.js'), `window.__ModuleLoader__.load({
  id: "dsh-connect",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${indented}
    return module.exports;
  }
});\n`)

console.log('built lib/index.js and lib/client.js')
