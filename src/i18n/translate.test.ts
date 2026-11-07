import { describe, expect, it } from 'vitest'
import { messages } from './messages'
import { translate } from './translate'

describe('translate', () => {
  it('returns the requested language', () => {
    expect(translate('nav.bag', 'en')).toBe('Bag')
    expect(translate('nav.bag', 'zh')).toBe('购物袋')
  })

  it('replaces named parameters', () => {
    expect(translate('collection.eyebrow', 'en', { count: 3 })).toBe('Collection 01 · 3 objects')
    expect(translate('collection.eyebrow', 'zh', { count: 3 })).toBe('系列 01 · 3 件')
  })

  it('leaves a missing parameter visible', () => {
    expect(translate('collection.eyebrow', 'en')).toBe('Collection 01 · {count} objects')
  })

  it('has non-empty English and Chinese text for every message', () => {
    for (const value of Object.values(messages)) {
      expect(value.en.trim()).not.toBe('')
      expect(value.zh.trim()).not.toBe('')
    }
  })
})
