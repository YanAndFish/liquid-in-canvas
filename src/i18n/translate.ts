import type { MessageKey } from './messages'
import type { Locale } from '@/domain/types'
import { messages } from './messages'

export type MessageParams = Record<string, string | number>

export function translate(key: MessageKey, locale: Locale, params: MessageParams = {}): string {
  return messages[key][locale].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    return value === undefined
      ? placeholder
      : String(value)
  })
}
