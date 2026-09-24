// The app's API client. Every screen loads through a query over fetch.
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

export const API_URL = 'https://api.sprout.example'

// The host never resolves: in development src/dev/fake-backend.ts answers.
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`)
  if (!res.ok) throw new Error(`GET ${path} failed with ${res.status}`)
  return (await res.json()) as T
}

export const usePlants = () =>
  useQuery({ queryKey: ['plants'], queryFn: () => get<Plant[]>('/plants') })

export const useFlags = () =>
  useQuery({ queryKey: ['flags'], queryFn: () => get<Flags>('/flags') })

export const useInbox = () =>
  useQuery({ queryKey: ['inbox'], queryFn: () => get<Message[]>('/inbox') })

export const useProducts = () =>
  useQuery({ queryKey: ['products'], queryFn: () => get<Product[]>('/products') })
