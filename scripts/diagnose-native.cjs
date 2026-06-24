#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

require('../src/preload-sodium.cjs')

const root = path.join(__dirname, '..')
const host = `${process.platform}-${process.arch}`
const addons = [
  { name: 'rocksdb-native', packageMain: 'rocksdb-native', binary: 'rocksdb-native.node' },
  { name: 'udx-native', packageMain: 'udx-native', binary: 'udx-native.node' }
]
const packages = ['hypercore-crypto', 'corestore', 'hyperswarm']

let failed = false

console.log('ZapCast gateway native dependency diagnostics')
console.log(`node=${process.version}`)
console.log(`platform=${process.platform}`)
console.log(`arch=${process.arch}`)
console.log(`release=${os.release()}`)
if (process.report && process.report.getReport) {
  const report = process.report.getReport()
  if (report.header) {
    console.log(`glibcRuntime=${report.header.glibcVersionRuntime || '-'}`)
    console.log(`glibcCompiler=${report.header.glibcVersionCompiler || '-'}`)
  }
}
console.log('')

for (const addon of addons) {
  const packageRoot = resolvePackageRoot(addon.packageMain)
  const binaryPath = path.join(packageRoot, 'prebuilds', host, addon.binary)

  console.log(`[${addon.name}]`)
  console.log(`packageRoot=${packageRoot}`)
  console.log(`binary=${binaryPath}`)
  console.log(`binaryExists=${fs.existsSync(binaryPath) ? 'yes' : 'no'}`)

  if (fs.existsSync(binaryPath)) {
    const stat = fs.statSync(binaryPath)
    console.log(`binaryBytes=${stat.size}`)
    runLdd(binaryPath)
    tryRequire(binaryPath, `${addon.name} prebuild`)
  } else {
    failed = true
  }

  tryRequire(addon.packageMain, addon.name)
  console.log('')
}

for (const pkg of packages) {
  tryRequire(pkg, pkg)
}

if (failed) {
  console.error('')
  console.error('One or more native dependencies failed to load.')
  console.error('On Debian/Ubuntu, first install libatomic1. If ldd reports missing GLIBC symbols, use Debian 12/Ubuntu 22.04+ or a bookworm-based Node Docker image.')
  process.exit(1)
}

console.log('')
console.log('native dependency diagnostics ok')

function resolvePackageRoot (packageName) {
  const mainPath = require.resolve(packageName, { paths: [root] })
  let current = path.dirname(mainPath)

  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current
    current = path.dirname(current)
  }

  throw new Error(`Could not resolve package root for ${packageName}`)
}

function runLdd (binaryPath) {
  if (process.platform !== 'linux') return

  const result = spawnSync('ldd', [binaryPath], { encoding: 'utf8' })
  if (result.error) {
    console.log(`lddError=${result.error.message}`)
    return
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (!output) {
    console.log('ldd=-')
    return
  }

  console.log('ldd:')
  for (const line of output.split('\n')) console.log(`  ${line}`)
}

function tryRequire (specifier, label) {
  try {
    require(specifier)
    console.log(`require:${label}=ok`)
  } catch (err) {
    failed = true
    console.log(`require:${label}=failed`)
    printError(err, '  ')
  }
}

function printError (err, indent) {
  if (!err) return

  console.log(`${indent}${err.name || 'Error'}: ${err.message}`)
  if (err.code) console.log(`${indent}code=${err.code}`)

  if (err.cause) {
    console.log(`${indent}cause:`)
    printError(err.cause, `${indent}  `)
  }
}
