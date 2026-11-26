import { dial } from '@avasapp/agent-bridge/dials'
import { StyleSheet, Text, View } from 'react-native'

import { useProducts } from '@/api'
import { Card, Screen } from '@/components/ui'
import { useColors } from '@/theme'

export default function ShopScreen() {
  const c = useColors()
  const { data: products } = useProducts()
  const gap = dial.number('shop.gap', 12, { min: 0, max: 28, label: 'Gap', group: 'Product grid', desc: 'Space between product cards' })
  const artHeight = dial.number('shop.artHeight', 110, { min: 60, max: 180, label: 'Height', group: 'Product grid / Picture', desc: 'Height of the product picture' })
  const artRadius = dial.number('shop.artRadius', 14, { min: 0, max: 40, label: 'Radius', group: 'Product grid / Picture', desc: 'Corner rounding of the product picture' })
  return (
    <Screen eyebrow="New this week" title="Shop" subtitle="Picked for your plants">
      <View style={[styles.grid, { gap }]}>
        {products?.map((p) => (
          <Card key={p.id} style={styles.item}>
            <View style={[styles.art, { backgroundColor: c.subtle, height: artHeight, borderRadius: artRadius }]}>
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
