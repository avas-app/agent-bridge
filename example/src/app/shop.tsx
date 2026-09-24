import { StyleSheet, Text, View } from 'react-native'

import { useProducts } from '@/api'
import { Card, Screen } from '@/components/ui'
import { useColors } from '@/theme'

export default function ShopScreen() {
  const c = useColors()
  const { data: products } = useProducts()
  return (
    <Screen eyebrow="New this week" title="Shop" subtitle="Picked for your plants">
      <View style={styles.grid}>
        {products?.map((p) => (
          <Card key={p.id} style={styles.item}>
            <View style={[styles.art, { backgroundColor: c.subtle }]}>
              <Text style={styles.emoji}>{p.emoji}</Text>
            </View>
            <Text style={[styles.name, { color: c.text }]}>{p.name}</Text>
            <View style={styles.footer}>
              <Text style={[styles.price, { color: c.muted }]}>{p.price}</Text>
              <View style={[styles.add, { backgroundColor: c.accent }]}>
                <Text style={[styles.addText, { color: c.card }]}>Add</Text>
              </View>
            </View>
          </Card>
        ))}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  item: { width: '47.5%', gap: 10 },
  art: {
    height: 110,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 44 },
  name: { fontSize: 16, fontWeight: '700' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  price: { fontSize: 15, fontWeight: '600' },
  add: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  addText: { fontSize: 13, fontWeight: '700' },
})
