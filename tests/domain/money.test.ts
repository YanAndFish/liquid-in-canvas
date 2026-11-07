import { describe, expect, it } from 'vitest'
import { FLAT_SHIPPING_CENTS, formatCents, FREE_SHIPPING_CENTS } from '@/domain/money'

describe('formatCents', () => {
  it('omits cents for whole dollar amounts', () => {
    expect(formatCents(0)).toBe('$0')
    expect(formatCents(14800)).toBe('$148')
    expect(formatCents(FREE_SHIPPING_CENTS)).toBe('$150')
    expect(formatCents(FLAT_SHIPPING_CENTS)).toBe('$12')
  })

  it('shows two decimal places for cent amounts', () => {
    expect(formatCents(14850)).toBe('$148.50')
    expect(formatCents(1)).toBe('$0.01')
    expect(formatCents(999)).toBe('$9.99')
  })
})
