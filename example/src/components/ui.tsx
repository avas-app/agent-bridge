import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useColors } from '@/theme'

export function Screen({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string
  title: string
  subtitle?: string
  children: ReactNode
}) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      {eyebrow ? (
        <Text style={[styles.eyebrow, { color: c.accent }]}>{eyebrow}</Text>
      ) : null}
      <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: c.muted }]}>{subtitle}</Text>
      ) : null}
      <View style={styles.body}>{children}</View>
    </ScrollView>
  )
}

export function Card({
  children,
  style,
}: {
  children: ReactNode
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.card, borderColor: c.border },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const c = useColors()
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.muted }]}>{title}</Text>
      <Card style={styles.sectionCard}>{children}</Card>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 280 },
  eyebrow: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  title: { fontSize: 34, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { fontSize: 15, marginTop: 4 },
  body: { marginTop: 20, gap: 10 },
  card: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  section: { gap: 8, marginBottom: 14 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginLeft: 6,
  },
  sectionCard: { paddingVertical: 4 },
})
