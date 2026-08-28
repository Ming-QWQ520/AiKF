#!/usr/bin/env node
// Refresh the vendored ArtPlayer Anich Edition bundle from GitHub
// Releases. Run this whenever the upstream `WIP` branch on
// github.com/Ming-QWQ520/ArtPlayer gets a new build.
//
// Usage:  node scripts/refresh-artplayer-anich.mjs
//
// Steps:
//   1. Fetch anichsdk.zip from the GitHub release tagged
//      `anich-edition-wip`.
//   2. Wipe ./third_party/artplayer-anich/{dist,types}.
//   3. Extract the new artifacts into dist/ and types/.
//   4. Bump ./third_party/artplayer-anich/package.json to match
//      the version reported by the zip's `package.artplayer.json`.
//
// No external deps — uses Node 20+ built-in fetch + zlib + path.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AIKF_ROOT = path.resolve(__dirname, '..')
const VENDOR_DIR = path.join(AIKF_ROOT, 'third_party/artplayer-anich')
const ZIP_URL = 'https://github.com/Ming-QWQ520/ArtPlayer/releases/download/anich-edition-wip/anichsdk.zip'

async function main() {
  console.log(`Fetching ${ZIP_URL} ...`)
  const resp = await fetch(ZIP_URL, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  console.log(`Downloaded ${buf.length} bytes`)

  // Wipe dist + types so removed files don't linger
  fs.rmSync(path.join(VENDOR_DIR, 'dist'), { recursive: true, force: true })
  fs.rmSync(path.join(VENDOR_DIR, 'types'), { recursive: true, force: true })
  fs.mkdirSync(path.join(VENDOR_DIR, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(VENDOR_DIR, 'types'), { recursive: true })

  // Use system unzip — it's universally available on dev/CI machines
  const tmp = path.join(AIKF_ROOT, '.cache', 'anichsdk.zip')
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, buf)
  const extractDir = path.join(AIKF_ROOT, '.cache', 'anichsdk_extracted')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  execSync(`unzip -o ${tmp} -d ${extractDir}`, { stdio: 'inherit' })

  // Move dist files
  for (const f of fs.readdirSync(extractDir)) {
    const src = path.join(extractDir, f)
    const dest = f.startsWith('artplayer.') && f.endsWith('.js') || f.endsWith('.mjs')
      ? path.join(VENDOR_DIR, 'dist', f)
      : f.endsWith('.d.ts')
        ? path.join(VENDOR_DIR, 'types', f)
        : null
    if (dest) {
      fs.copyFileSync(src, dest)
      console.log(`  wrote ${path.relative(AIKF_ROOT, dest)}`)
    }
  }

  // Bump version in package.json from package.artplayer.json
  const metaPath = path.join(extractDir, 'package.artplayer.json')
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    const pkgPath = path.join(VENDOR_DIR, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    pkg.version = meta.version
    pkg.anich = pkg.anich || {}
    pkg.anich.bundledAt = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`  bumped vendored artplayer to v${meta.version}`)
  }

  // Cleanup
  fs.rmSync(path.join(AIKF_ROOT, '.cache'), { recursive: true, force: true })
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
