import Ionicons from '@expo/vector-icons/Ionicons'
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query'
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { StatusBar } from 'expo-status-bar'
import { type ComponentProps, useEffect, useState } from 'react'
import { type ColorValue, View } from 'react-native'

import { type Message, useFlags, useInbox } from '@/api'
import { AgentBridge } from '@/dev/agent-bridge'
// Registers the fake backend's routes in development, before the first query.
import '@/dev/fake-backend'
import { AgentHud } from '@/dev/hud'
import { socket } from '@/realtime'
import { useColors, useScheme } from '@/theme'

const icon =
  (name: ComponentProps<typeof Ionicons>['name']) =>
  ({ color, size }: { color: ColorValue; size: number }) => (
    <Ionicons name={name} color={color} size={size} />
  )

// New messages from the realtime server go to the top of the inbox.
function useLiveInbox() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const onMessage = (message: Message) =>
      queryClient.setQueryData<Message[]>(['inbox'], (messages = []) => [
        message,
        ...messages.filter((m) => m.id !== message.id),
      ])
    socket.on('inbox:new', onMessage)
    return () => {
      socket.off('inbox:new', onMessage)
    }
  }, [queryClient])
}

function AppTabs() {
  useLiveInbox()
  const scheme = useScheme()
  const c = useColors()
  const { data: flags } = useFlags()
  const { data: inbox } = useInbox()
  const unread = inbox?.filter((m) => m.unread).length ?? 0
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: c.accent,
      background: c.background,
      card: c.card,
      text: c.text,
      border: c.border,
    },
  }

  return (
    <ThemeProvider value={theme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: c.accent,
          tabBarInactiveTintColor: c.muted,
          tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: 'Plants', tabBarIcon: icon('leaf') }}
        />
        <Tabs.Screen name="add" options={{ title: 'Add plant', href: null }} />
        <Tabs.Screen
          name="shop"
          options={{
            title: 'Shop',
            href: flags?.shop ? undefined : null,
            tabBarIcon: icon('bag-handle'),
          }}
        />
        <Tabs.Screen
          name="inbox"
          options={{
            title: 'Inbox',
            tabBarIcon: icon('notifications'),
            tabBarBadge: unread || undefined,
            tabBarBadgeStyle: { backgroundColor: c.danger },
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{ title: 'Settings', tabBarIcon: icon('settings') }}
        />
      </Tabs>
    </ThemeProvider>
  )
}

export default function RootLayout() {
  // In state, so a Fast Refresh of this file keeps the same client.
  const [queryClient] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={queryClient}>
      <View style={{ flex: 1 }}>
        <AppTabs />
        {__DEV__ ? <AgentHud /> : null}
      </View>
      {__DEV__ ? <AgentBridge /> : null}
    </QueryClientProvider>
  )
}
