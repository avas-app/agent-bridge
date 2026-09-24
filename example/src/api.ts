// A fake backend with a little latency, so every screen loads through a query.
import { useQuery } from '@tanstack/react-query'

import type { Tint } from './theme'

export type Plant = {
  id: string
  name: string
  species: string
  emoji: string
  /** Days until the next watering; negative when overdue. */
  waterInDays: number
}

export type Flags = { shop: boolean }

export type Message = {
  id: string
  icon: 'water' | 'sunny' | 'leaf' | 'pricetag' | 'sparkles'
  tint: Tint
  title: string
  body: string
  time: string
  unread: boolean
}

export type Product = { id: string; name: string; emoji: string; price: string }

const plants: Plant[] = [
  { id: 'p1', name: 'Fern', species: 'Nephrolepis exaltata', emoji: '🌿', waterInDays: 0 },
  { id: 'p2', name: 'Basil', species: 'Ocimum basilicum', emoji: '🍃', waterInDays: 1 },
  { id: 'p3', name: 'Monstera', species: 'Monstera deliciosa', emoji: '🪴', waterInDays: 2 },
  { id: 'p4', name: 'Snake plant', species: 'Dracaena trifasciata', emoji: '🌱', waterInDays: 9 },
  { id: 'p5', name: 'Barrel cactus', species: 'Ferocactus', emoji: '🌵', waterInDays: 21 },
]

const messages: Message[] = [
  { id: 'm1', icon: 'water', tint: 'info', title: 'Fern is thirsty', body: 'Water it today to keep the fronds green.', time: '8:30', unread: true },
  { id: 'm2', icon: 'sunny', tint: 'amber', title: 'Move Basil to the window', body: 'Sunny all afternoon.', time: 'Yesterday', unread: true },
  { id: 'm3', icon: 'leaf', tint: 'accent', title: 'Snake plant is thriving', body: 'No water needed for 9 days.', time: 'Mon', unread: false },
  { id: 'm4', icon: 'pricetag', tint: 'violet', title: 'Pots are 20% off', body: 'Until Sunday.', time: 'Sun', unread: false },
]

const products: Product[] = [
  { id: 'x1', name: 'Terracotta pot', emoji: '🏺', price: '$18' },
  { id: 'x2', name: 'Watering can', emoji: '🚿', price: '$24' },
  { id: 'x3', name: 'Grow light', emoji: '💡', price: '$39' },
  { id: 'x4', name: 'Plant food', emoji: '🧪', price: '$12' },
]

const later = <T,>(value: T, ms = 400) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

export const usePlants = () =>
  useQuery({ queryKey: ['plants'], queryFn: () => later([...plants]) })

export type NewPlant = { name: string; species?: string; waterEveryDays: number }

const emojis = ['🌱', '🌿', '🪴', '🌵', '🍃']

/** Adds a plant that was just watered. */
export function addPlant(input: NewPlant): Promise<Plant> {
  const plant: Plant = {
    id: `p${Date.now()}`,
    name: input.name,
    species: input.species ?? '',
    emoji: emojis[plants.length % emojis.length] ?? '🌱',
    waterInDays: input.waterEveryDays,
  }
  return later(plant, 300).then((saved) => {
    plants.push(saved)
    return saved
  })
}

export const useFlags = () =>
  useQuery({ queryKey: ['flags'], queryFn: () => later<Flags>({ shop: true }) })

export const useInbox = () =>
  useQuery({ queryKey: ['inbox'], queryFn: () => later(messages) })

export const useProducts = () =>
  useQuery({ queryKey: ['products'], queryFn: () => later(products) })
