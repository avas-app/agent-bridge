import type { FlowRun } from './flow'

// Whole ANSI sequences (colours, cursor moves) go first; then what XML 1.0 can't hold.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const escape = (s: string) =>
  s
    .replace(ANSI, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The folder a flow file sits in, shown as the JUnit classname. */
const classname = (file: string) => {
  const at = file.lastIndexOf('/')
  return at > 0 ? file.slice(0, at) : 'agent-bridge'
}

/** The `--reporter json` document. */
export function renderJson(runs: FlowRun[]): string {
  const count = (s: FlowRun['status']) => runs.filter((r) => r.status === s).length
  return JSON.stringify(
    { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), flows: runs },
    null,
    2,
  )
}

/** The `--reporter junit` document: one testcase per flow. */
export function renderJunit(runs: FlowRun[]): string {
  const failed = runs.filter((r) => r.status === 'failed').length
  const skipped = runs.filter((r) => r.status === 'skipped').length
  const time = runs.reduce((t, r) => t + r.ms, 0) / 1000
  const cases = runs.map((r) => {
    const open = `<testcase classname="${escape(classname(r.file))}" name="${escape(r.name)}" file="${escape(r.file)}" time="${(r.ms / 1000).toFixed(3)}"`
    if (r.status === 'skipped') return `${open}><skipped/></testcase>`
    if (r.status === 'passed') return `${open}/>`
    const screen = r.state?.screen?.length ? `\non screen:\n${r.state.screen.join('\n')}` : ''
    const route = r.state?.route !== undefined ? `\nroute: ${JSON.stringify(r.state.route)}` : ''
    return `${open}><failure message="${escape(r.error ?? 'failed')}">${escape((r.error ?? '') + route + screen)}</failure></testcase>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="agent-bridge" tests="${runs.length}" failures="${failed}" skipped="${skipped}" time="${time.toFixed(3)}">\n${cases.join('\n')}\n</testsuite>\n`
}
