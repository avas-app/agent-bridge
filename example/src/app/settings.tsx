import Ionicons from '@expo/vector-icons/Ionicons'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'

import { Section, Screen } from '@/components/ui'
import { type Theme, useSettings } from '@/settings'
import { useColors } from '@/theme'

const themes: { value: Theme; label: string; icon: 'sunny' | 'moon' | 'phone-portrait' }[] = [
  { value: 'light', label: 'Light', icon: 'sunny' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'phone-portrait' },
]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const c = useColors()
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: c.text }]}>{label}</Text>
      {children}
    </View>
  )
}

export default function SettingsScreen() {
  const c = useColors()
  const { theme, setTheme, reminders, setReminders } = useSettings()
  return (
    <Screen title="Settings">
      <Section title="Appearance">
        <View style={[styles.segments, { backgroundColor: c.subtle }]}>
          {themes.map((t) => {
            const on = t.value === theme
            return (
              <Pressable
                key={t.value}
                onPress={() => setTheme(t.value)}
                style={[styles.segment, on && { backgroundColor: c.card }]}
              >
                <Ionicons name={t.icon} size={16} color={on ? c.accent : c.muted} />
                <Text style={[styles.segmentText, { color: on ? c.text : c.muted }]}>
                  {t.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </Section>
      <Section title="Reminders">
        <Row label="Watering reminders">
          <Switch
            value={reminders}
            onValueChange={setReminders}
            trackColor={{ true: c.accent }}
          />
        </Row>
      </Section>
      <Section title="About">
        <Row label="Version">
          <Text style={{ color: c.muted }}>1.0.0</Text>
        </Row>
      </Section>
    </Screen>
  )
}

const styles = StyleSheet.create({
  segments: { flexDirection: 'row', borderRadius: 14, padding: 4, margin: 6 },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 11,
  },
  segmentText: { fontSize: 14, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingVertical: 10,
    minHeight: 48,
  },
  label: { fontSize: 16 },
})
