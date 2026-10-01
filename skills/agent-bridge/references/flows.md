# Batches and flows

## A batch of calls

For a sequence of ad-hoc calls, pipe them into `call --batch` (or `repl`, which
behaves the same when stdin isn't a terminal): one process and one connection,
one JSON line back per call.

```sh
printf '%s\n' 'router.navigate /inbox' 'screen.waitFor "Inbox"' 'screen.snapshot' \
  | npx agent-bridge call --batch --stop-on-error
# {"tool":"router.navigate","ok":true,"ms":1.8,"appMs":1,"value":...}
# {"tool":"screen.waitFor","ok":false,"ms":2003.1,"error":"..."}   (plus "logs"/"notice" when present)
```

Each line is `tool args` in the same syntax as `call`; blank lines and `#` lines are
skipped, and arguments that start like JSON (`[`, `{`, `"`) but don't parse come back
as an error line. Lines starting with `.` (`.tools`, `.time <call> xN`, `.pending`,
`.restore`, `.exit`) run locally. `ms` is the round trip, `appMs` the time inside
the app. It exits 1 if any call failed; `--stop-on-error` stops at the first.
Results over 32 KB are summarised as in `call`; `--full` prints them, and
`--out <dir>` (new or empty) writes each call's result to `<dir>/<n>-<tool>.json`
and puts the file summary in `value`. Lines take `@file` as their whole argument
list (see [large-data.md](large-data.md)).

Later calls can't use an earlier result, so decide on the next steps after
reading the output.

## A flow file

Write the steps into a flow file and run it when a step depends on an earlier
result, and for timing checks.

```js
export const scenario = 'signedIn'   // applied first, undone after, even on failure

export default async ({ step }) => {
  await step('open form', 'screen.press', 'add-plant')
  await step('save empty', 'screen.press', 'save-plant')
  await step('error shown', 'screen.waitFor', 'Name is required')
  await step('undo', 'bridge.restore')
}
```

```sh
npx agent-bridge run flow.mjs --strict    # --strict fails if the app logged an error
npx agent-bridge run flow.mjs --scenario signedIn   # add a scenario the flow doesn't declare
npx agent-bridge run flow.mjs --scenario 'signedIn={"user":{"name":"Ada"}}'   # with options
```

A flow can declare several scenarios, with options:
`export const scenarios = ['signedIn', { name: 'cart', options: { items: 2 } }]`.
`run` applies them before the flow and runs `bridge.restore` afterwards, even
when the flow fails. The flow gets what each scenario's `apply` returned as
`scenarios.signedIn`. A failed restorer makes the run exit non-zero.
`--scenario` replaces a declared one of the same name.

`step` takes the same argument shapes as `call`; see [state.md](state.md).

## Timing

Each separate CLI call is a new process (roughly 90-100 ms with the bin,
280-320 ms with `npx`; machine-dependent), while `run` and `--batch` pay that
once. `run` prints how long each step took, so read step times from its output
or from `ms`, not from wall time around separate calls.
