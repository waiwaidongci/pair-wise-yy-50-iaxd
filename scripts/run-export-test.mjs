// 用 esbuild 把 TS 测试打包为临时 ESM 后在 Node 运行（不引入额外测试框架依赖）。
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const outfile = resolve('node_modules/.cache/export-test.mjs')

await build({
  entryPoints: ['test/export.test.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(outfile, { force: true })
}
