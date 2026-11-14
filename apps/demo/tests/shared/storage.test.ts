import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPreference, writePreference } from '@/shared/storage'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('偏好存储', () => {
  it('只读取允许的取值', () => {
    window.localStorage.setItem('k', 'light')
    expect(readPreference('k', ['light', 'dark'])).toBe('light')
    window.localStorage.setItem('k', 'sepia')
    expect(readPreference('k', ['light', 'dark'])).toBeNull()
  })

  it('存储不可用时不抛出', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(readPreference('k', ['a'])).toBeNull()
    expect(() => writePreference('k', 'a')).not.toThrow()
  })
})
