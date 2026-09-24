// Dev-only overlay that shows each agent step and its round trip, so a
// recording can show what the agent did. The agent drives it with hud.* tools.
import type { Tools } from '@avasapp/agent-bridge'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { create } from 'zustand'

import { mono } from '@/theme'

type Line = { label: string; ms: number | null }
type Hud = { visible: boolean; title: string; lines: Line[] }

const useHud = create<Hud>()(() => ({ visible: false, title: '', lines: [] }))

const withLastMs = (lines: Line[], ms?: number | null): Line[] => {
  const last = lines[lines.length - 1]
  if (ms == null || !last) return lines
  return [...lines.slice(0, -1), { ...last, ms }]
}

export const hideHud = () =>
  useHud.setState({ visible: false, title: '', lines: [] })

export const hudTools: Tools = {
  'hud.show': {
    description: 'Show the step overlay with a title.',
    run: (title: string) => useHud.setState({ visible: true, title, lines: [] }),
  },
  'hud.push': {
    description:
      "Add a step line. Pass the previous step's round trip to fill it in.",
    run: (label: string, previousMs?: number | null) =>
      useHud.setState((s) => ({
        lines: [...withLastMs(s.lines, previousMs), { label, ms: null }],
      })),
  },
  'hud.roundTrip': {
    description: "Fill in the last step's round trip.",
    run: (ms: number) =>
      useHud.setState((s) => ({ lines: withLastMs(s.lines, ms) })),
  },
  'hud.setTitle': {
    description: "Replace the title, e.g. with a summary. Optionally fills the last round trip.",
    run: (title: string, lastMs?: number | null) =>
      useHud.setState((s) => ({ title, lines: withLastMs(s.lines, lastMs) })),
  },
  'hud.hide': {
    description: 'Hide the overlay.',
    run: hideHud,
  },
}

const TAB_BAR = 49

export function AgentHud() {
  const { visible, title, lines } = useHud()
  const insets = useSafeAreaInsets()
  if (!visible) return null
  return (
    <View
      pointerEvents="none"
      style={[styles.panel, { bottom: insets.bottom + TAB_BAR + 10 }]}
    >
      <Text style={styles.title}>{title}</Text>
      {lines.map((line, i) => (
        <View key={i} style={styles.row}>
          <Text style={[styles.text, styles.n]}>
            {String(i + 1).padStart(2, '0')}
          </Text>
          <Text style={[styles.text, styles.label]} numberOfLines={1}>
            {line.label}
          </Text>
          <Text style={[styles.text, styles.ms]}>
            {line.ms == null ? '…' : `${line.ms.toFixed(1)} ms`}
          </Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 12,
    right: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(24, 28, 32, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  title: {
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '700',
    color: '#7CE0A8',
    marginBottom: 6,
  },
  row: { flexDirection: 'row', gap: 10 },
  text: { fontFamily: mono, fontSize: 12.5, lineHeight: 18 },
  n: { color: 'rgba(255, 255, 255, 0.4)' },
  label: { flex: 1, color: '#F1F2F3' },
  ms: { color: '#7CE0A8', minWidth: 64, textAlign: 'right' },
})
