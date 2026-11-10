import type { FlowRun } from './flow'

const escape = (s: string) =>
  s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

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
    const open = `<testcase classname="agent-bridge" name="${escape(r.name)}" file="${escape(r.file)}" time="${(r.ms / 1000).toFixed(3)}"`
    if (r.status === 'skipped') return `${open}><skipped/></testcase>`
    if (r.status === 'passed') return `${open}/>`
    const screen = r.state?.screen?.length ? `\non screen:\n${r.state.screen.join('\n')}` : ''
    const route = r.state?.route !== undefined ? `\nroute: ${JSON.stringify(r.state.route)}` : ''
    return `${open}><failure message="${escape(r.error ?? 'failed')}">${escape((r.error ?? '') + route + screen)}</failure></testcase>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="agent-bridge" tests="${runs.length}" failures="${failed}" skipped="${skipped}" time="${time.toFixed(3)}">\n${cases.join('\n')}\n</testsuite>\n`
}
