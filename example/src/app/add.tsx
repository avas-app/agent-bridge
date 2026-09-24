import { useMutation, useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'
import { useState } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native'

import { type Plant, addPlant } from '@/api'
import { Screen } from '@/components/ui'
import { useColors } from '@/theme'

function Field({ label, ...input }: { label: string } & TextInputProps) {
  const c = useColors()
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.muted }]}>{label}</Text>
      <TextInput
        placeholderTextColor={c.muted}
        style={[
          styles.input,
          { backgroundColor: c.card, borderColor: c.border, color: c.text },
        ]}
        {...input}
      />
    </View>
  )
}

const EMPTY = { name: '', species: '', days: '7' }

function problemWith(form: typeof EMPTY): string | null {
  if (!form.name.trim()) return 'Name is required'
  const days = Number(form.days)
  if (!Number.isInteger(days) || days < 1 || days > 60)
    return 'Water every 1–60 days'
  return null
}

export default function AddPlantScreen() {
  const c = useColors()
  const queryClient = useQueryClient()
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof EMPTY) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }))

  const save = useMutation({
    mutationFn: addPlant,
    onSuccess: (plant) => {
      queryClient.setQueryData<Plant[]>(['plants'], (old) =>
        old ? [...old, plant] : old,
      )
      void queryClient.invalidateQueries({ queryKey: ['plants'] })
      setForm(EMPTY)
      setError(null)
      router.navigate('/')
    },
    onError: (e) => setError(e.message),
  })

  const onSave = () => {
    const problem = problemWith(form)
    setError(problem)
    if (problem) return
    save.mutate({
      name: form.name.trim(),
      species: form.species.trim() || undefined,
      waterEveryDays: Number(form.days),
    })
  }

  return (
    <Screen eyebrow="New plant" title="Add plant">
      <Field
        testID="plant-name"
        label="Name"
        placeholder="e.g. Fiddle leaf fig"
        value={form.name}
        onChangeText={set('name')}
        autoCapitalize="words"
      />
      <Field
        testID="plant-species"
        label="Species (optional)"
        placeholder="e.g. Ficus lyrata"
        value={form.species}
        onChangeText={set('species')}
        autoCapitalize="none"
      />
      <Field
        testID="water-days"
        label="Water every … days"
        placeholder="7"
        value={form.days}
        onChangeText={set('days')}
        keyboardType="number-pad"
        maxLength={2}
      />
      {error ? (
        <Text style={[styles.error, { color: c.danger, backgroundColor: c.dangerSoft }]}>
          {error}
        </Text>
      ) : null}
      <Pressable
        testID="save-plant"
        accessibilityRole="button"
        disabled={save.isPending}
        onPress={onSave}
        style={({ pressed }) => [
          styles.save,
          { backgroundColor: c.accent, opacity: pressed || save.isPending ? 0.7 : 1 },
        ]}
      >
        <Text style={[styles.saveText, { color: c.background }]}>
          {save.isPending ? 'Saving…' : 'Save plant'}
        </Text>
      </Pressable>
      <Pressable onPress={() => router.navigate('/')} style={styles.cancel}>
        <Text style={[styles.cancelText, { color: c.muted }]}>Cancel</Text>
      </Pressable>
    </Screen>
  )
}

const styles = StyleSheet.create({
  field: { gap: 6, marginBottom: 6 },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginLeft: 6,
  },
  input: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 17,
  },
  error: {
    fontSize: 15,
    fontWeight: '600',
    borderRadius: 12,
    overflow: 'hidden',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  save: {
    marginTop: 8,
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
  },
  saveText: { fontSize: 17, fontWeight: '700' },
  cancel: { alignItems: 'center', paddingVertical: 12 },
  cancelText: { fontSize: 16, fontWeight: '600' },
})
