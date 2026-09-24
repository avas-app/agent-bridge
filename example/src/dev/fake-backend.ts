// Sprout's backend, faked in the app: app mocks answer every request to
// API_URL with a little latency. Development only; agents can override any
// route with net.mock, and net.restore brings these back.
import { type MockMatch, mockRequests } from '@avasapp/agent-bridge/network'

import { API_URL, type Flags, type Message, type Plant, type Product } from '@/api'

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

const flags: Flags = { shop: true }

const NEW_PLANT_EMOJI = ['🌷', '🌻', '🌾', '🍀', '🌼', '🎍']

type NewPlant = { name?: unknown; species?: unknown; waterEveryDays?: unknown }

function addPlant(input: NewPlant) {
  if (typeof input.name !== 'string' || !input.name.trim())
    return { status: 400, json: { error: 'name is required' } }
  if (typeof input.waterEveryDays !== 'number' || input.waterEveryDays < 0)
    return { status: 400, json: { error: 'waterEveryDays must be a number of days' } }
  const n = plants.length + 1
  const plant: Plant = {
    id: `p${n}`,
    name: input.name.trim(),
    species: typeof input.species === 'string' ? input.species : '',
    emoji: NEW_PLANT_EMOJI[(n - 1) % NEW_PLANT_EMOJI.length]!,
    // Just watered: the next one is a full interval away.
    waterInDays: input.waterEveryDays,
  }
  // Newest first, like the list shows them.
  plants.unshift(plant)
  return { status: 201, json: plant }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// Exactly API_URL + path, with or without a query string.
const route = (method: string, path: string): MockMatch => ({
  url: new RegExp(`^${escape(API_URL + path)}(\\?.*)?$`),
  method,
})

// Same latency as before the app moved onto fetch.
const options = (id: string) => ({ id: `sprout ${id}`, delayMs: 400 })

if (__DEV__) {
  mockRequests([
    { match: route('GET', '/plants'), response: () => ({ json: plants }), options: options('GET /plants') },
    {
      match: route('POST', '/plants'),
      response: (request) => addPlant((request.json() ?? {}) as NewPlant),
      options: options('POST /plants'),
    },
    { match: route('GET', '/flags'), response: () => ({ json: flags }), options: options('GET /flags') },
    { match: route('GET', '/inbox'), response: () => ({ json: messages }), options: options('GET /inbox') },
    { match: route('GET', '/products'), response: () => ({ json: products }), options: options('GET /products') },
  ])
}
