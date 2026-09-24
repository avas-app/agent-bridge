export const PROTOCOL_VERSION = 1

/** `agent-bridge assert-absent` fails when a bundle contains this string. */
export const RUNTIME_MARKER = '@avasapp/agent-bridge/runtime'

/** Plugin name on Expo's dev-tools broadcast socket. */
export const PLUGIN_NAME = 'agent-bridge'

/** The one global the CDP transport installs. App code never touches it. */
export const CDP_GLOBAL = '__AGENT_BRIDGE__'

/** CDP binding the app calls to push a result back to the client. */
export const CDP_REPLY_BINDING = '__agentBridgeReply'

export type CallMessage = {
  id: string
  tool: string
  args?: unknown[]
  /** Device to run on. Expo's socket broadcasts, so every app sees every call. */
  to?: string
}

/** An error or warning the app logged, threw or left unhandled. */
export type LogEntry = {
  level: 'error' | 'warn'
  message: string
  /** First lines of the stack, when there was an Error. */
  stack?: string
  /** Date.now() in the app. */
  at: number
  /** The tool that was running when it was logged. */
  during?: string
  /** Otherwise, the last tool that had finished. */
  after?: string
}

/** `logs`: errors the app recorded since its previous reply. Old clients ignore it. */
export type ResultMessage = (
  | { id: string; from: string; ok: true; value: unknown; ms: number }
  | { id: string; from: string; ok: false; error: string; ms: number }
) & { logs?: LogEntry[] }

export type ToolInfo = { name: string; description?: string }

export type DeviceInfo = {
  deviceId: string
  name: string
  platform: string
  protocol: number
  tools: ToolInfo[]
}

/**
 * JSON with every non-ASCII UTF-16 unit escaped as \uXXXX. Hermes refuses to
 * compile an evaluated expression that contains an astral character, even as
 * an escape inside a string literal, but decodes these escapes in JSON.parse.
 */
export function toAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
