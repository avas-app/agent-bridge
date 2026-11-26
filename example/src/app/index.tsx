import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { dial } from '@avasapp/agent-bridge/dials'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { type Plant, usePlants } from '@/api'
import { Card, Screen } from '@/components/ui'
import { type Colors, useColors } from '@/theme'

function waterPill(c: Colors, days: number) {
  if (days < 0)
    return { label: `${-days} days late`, fg: c.danger, bg: c.dangerSoft }
  if (days === 0) return { label: 'Today', fg: c.info, bg: c.infoSoft }
  if (days === 1) return { label: 'Tomorrow', fg: c.muted, bg: c.subtle }
  return { label: `In ${days} days`, fg: c.muted, bg: c.subtle }
}

function PlantAvatar({ plant }: { plant: Plant }) {
  const c = useColors()
  const g = { group: 'Plant card / Avatar' }
  const bg = dial.token('avatar.bg', 'colors.accentSoft', c.accentSoft, { label: 'Background', desc: 'Fill behind the plant emoji', ...g })
  const radius = dial.number('avatar.radius', 16, { min: 0, max: 26, label: 'Radius', desc: 'Corner rounding of the emoji tile', ...g })
  return (
    <View style={[styles.avatar, { backgroundColor: bg, borderRadius: radius }]}>
      <Text style={styles.emoji}>{plant.emoji}</Text>
    </View>
  )
}

function PlantName({ plant }: { plant: Plant }) {
  const c = useColors()
  const g = { group: 'Plant card / Name' }
  const size = dial.number('name.size', 17, { min: 12, max: 24, label: 'Size', desc: 'Plant name text size', ...g })
  const weight = dial.enum('name.weight', '700', ['400', '500', '600', '700', '800'], { label: 'Weight', desc: 'Plant name boldness', ...g })
  const color = dial.token('name.color', 'colors.text', c.text, { label: 'Colour', desc: 'Plant name text colour', ...g })
  return (
    <Text style={[styles.name, { color, fontSize: size, fontWeight: weight }]}>{plant.name}</Text>
  )
}

function RoomyCard({ plant }: { plant: Plant }) {
  const c = useColors()
  const pill = waterPill(c, plant.waterInDays)
  const gap = dial.number('card.gap', 14, { min: 0, max: 32, label: 'Gap', group: 'Plant card / Card', desc: 'Space between the emoji tile and the text' })
  return (
    <Card style={{ ...styles.row, gap }}>
      <PlantAvatar plant={plant} />
      <View style={styles.text}>
        <PlantName plant={plant} />
        {plant.species ? (
          <Text style={[styles.species, { color: c.muted }]}>
            {plant.species}
          </Text>
        ) : null}
      </View>
      <View style={[styles.pill, { backgroundColor: pill.bg }]}>
        <Ionicons name="water" size={12} color={pill.fg} />
        <Text style={[styles.pillText, { color: pill.fg }]}>{pill.label}</Text>
      </View>
    </Card>
  )
}

function CompactCard({ plant }: { plant: Plant }) {
  const c = useColors()
  const pill = waterPill(c, plant.waterInDays)
  return (
    <View style={[styles.compact, { borderColor: c.subtle }]}>
      <Text style={styles.compactEmoji}>{plant.emoji}</Text>
      <View style={styles.text}>
        <PlantName plant={plant} />
      </View>
      <Text style={[styles.pillText, { color: pill.fg }]}>{pill.label}</Text>
    </View>
  )
}

function AddButton() {
  const c = useColors()
  return (
    <Pressable
      testID="add-plant"
      accessibilityLabel="Add plant"
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => router.navigate('/add')}
      style={({ pressed }) => [
        styles.add,
        { backgroundColor: c.accent, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Ionicons name="add" size={26} color={c.background} />
    </Pressable>
  )
}

export default function PlantsScreen() {
  const { data: plants } = usePlants()
  const due = plants?.filter((p) => p.waterInDays <= 0).length ?? 0
  const PlantCard = dial.variant('plant.card', { roomy: RoomyCard, compact: CompactCard }, 'roomy', { label: 'Layout', group: 'Plant card / Card', desc: 'Roomy or compact plant card' })
  return (
    <Screen
      eyebrow="Good morning"
      title="My plants"
      action={<AddButton />}
      subtitle={
        plants ? `${plants.length} plants · ${due} to water today` : 'Loading…'
      }
    >
      {plants?.map((plant) => <PlantCard key={plant.id} plant={plant} />)}
    </Screen>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 28 },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '700' },
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  compactEmoji: { fontSize: 20 },
  species: { fontSize: 14, fontStyle: 'italic' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pillText: { fontSize: 13, fontWeight: '600' },
  add: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
