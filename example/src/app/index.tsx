import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
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

function PlantCard({ plant }: { plant: Plant }) {
  const c = useColors()
  const pill = waterPill(c, plant.waterInDays)
  return (
    <Card style={styles.row}>
      <View style={[styles.avatar, { backgroundColor: c.accentSoft }]}>
        <Text style={styles.emoji}>{plant.emoji}</Text>
      </View>
      <View style={styles.text}>
        <Text style={[styles.name, { color: c.text }]}>{plant.name}</Text>
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
