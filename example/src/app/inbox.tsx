import Ionicons from '@expo/vector-icons/Ionicons'
import { StyleSheet, Text, View } from 'react-native'

import { type Message, useInbox } from '@/api'
import { Card, Screen } from '@/components/ui'
import { tint, useColors } from '@/theme'

function Row({ message }: { message: Message }) {
  const c = useColors()
  const t = tint(c, message.tint)
  return (
    <Card style={styles.row}>
      <View style={[styles.icon, { backgroundColor: t.bg }]}>
        <Ionicons name={message.icon} size={20} color={t.fg} />
      </View>
      <View style={styles.text}>
        <View style={styles.top}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
            {message.title}
          </Text>
          <Text style={[styles.time, { color: c.muted }]}>{message.time}</Text>
        </View>
        <Text style={[styles.body, { color: c.muted }]}>{message.body}</Text>
      </View>
      {message.unread ? (
        <View style={[styles.dot, { backgroundColor: c.accent }]} />
      ) : null}
    </Card>
  )
}

export default function InboxScreen() {
  const { data: messages } = useInbox()
  const unread = messages?.filter((m) => m.unread).length ?? 0
  return (
    <Screen
      eyebrow="Updates"
      title="Inbox"
      subtitle={messages ? `${unread} unread` : 'Loading…'}
    >
      {messages?.map((m) => <Row key={m.id} message={m} />)}
    </Screen>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '700' },
  time: { fontSize: 13 },
  body: { fontSize: 14 },
  dot: { width: 9, height: 9, borderRadius: 5 },
})
