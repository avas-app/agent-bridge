// Checks every entries/*.cjs gate after a build:
// - both branches point at files that exist,
// - the production stub requires nothing and never contains the runtime marker,
// - the stub exports every value the real module exports (so a release build
//   can't crash on a missing export), apart from RUNTIME_MARKER itself.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const MARKER = '@avasapp/agent-bridge/runtime'
const require = createRequire(import.meta.url)
const problems = []

const exportNames = (cjsText) => {
  const block = cjsText.match(/__export\(\w+, \{([\s\S]*?)\}\);/)
  return block ? [...block[1].matchAll(/(\w+): \(\) =>/g)].map((m) => m[1]) : []
}

for (const gate of readdirSync('entries')) {
  const text = readFileSync(`entries/${gate}`, 'utf8')
  const [noop, real] = [
    ...text.matchAll(/require\('\.\.\/(dist\/[^']+)'\)/g),
  ].map((m) => m[1])
  if (!noop || !real) {
    problems.push(
      `${gate}: expected a production branch and a development branch`,
    )
    continue
  }
  for (const file of [noop, real])
    if (!existsSync(file)) problems.push(`${gate}: ${file} is missing`)
  if (!existsSync(noop) || !existsSync(real)) continue

  const noopText = readFileSync(noop, 'utf8')
  if (noopText.includes('require('))
    problems.push(`${gate}: ${noop} requires another module`)
  if (noopText.includes(MARKER))
    problems.push(`${gate}: ${noop} contains the runtime marker`)

  const stub = require(`../${noop}`)
  for (const name of exportNames(readFileSync(real, 'utf8'))) {
    if (name !== 'RUNTIME_MARKER' && !(name in stub))
      problems.push(`${gate}: stub is missing export "${name}"`)
  }
}

if (!readFileSync('dist/runtime/index.cjs', 'utf8').includes(MARKER)) {
  problems.push(
    'dist/runtime/index.cjs lost the runtime marker; assert-absent would pass on anything',
  )
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`Entry gates OK (${readdirSync('entries').length}).`)
