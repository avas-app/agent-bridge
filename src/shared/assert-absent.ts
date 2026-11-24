import { readFile } from 'node:fs/promises'

import { DIALS_MARKER, RUNTIME_MARKER } from './protocol'

/** The files that contain the bridge runtime or the dials code. */
export async function bundlesWithBridge(files: string[]): Promise<string[]> {
  const found: string[] = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    if (text.includes(RUNTIME_MARKER) || text.includes(DIALS_MARKER)) found.push(file)
  }
  return found
}
