// Bundle the MCP server + all deps into a single self-contained file (dist/orchestrator.mjs)
// so the plugin runs with no node_modules when installed from a marketplace.
//   npm install   (dev deps incl. esbuild)
//   npm run build
import { build } from 'esbuild'

await build({
  entryPoints: ['servers/orchestrator.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/orchestrator.mjs',
  banner: {
    js: "import{createRequire}from'module';import{fileURLToPath as __f}from'url';import{dirname as __d}from'path';const require=createRequire(import.meta.url);const __filename=__f(import.meta.url);const __dirname=__d(__filename);",
  },
})
console.log('built dist/orchestrator.mjs')
