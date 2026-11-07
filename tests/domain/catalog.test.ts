/// <reference types="node" />

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATEGORIES, countByCategory, PRODUCTS } from '@/domain/catalog'

describe('catalog', () => {
  it('has twelve unique ids and four objects in each category', () => {
    expect(PRODUCTS).toHaveLength(12)
    expect(new Set(PRODUCTS.map(product => product.id)).size).toBe(PRODUCTS.length)

    for (const category of CATEGORIES)
      expect(countByCategory(category.id)).toBe(4)
  })

  it('carries non-empty English and Chinese copy for every product', () => {
    for (const product of PRODUCTS) {
      for (const locale of ['en', 'zh'] as const) {
        expect(product.name[locale].trim()).not.toBe('')
        expect(product.blurb[locale].trim()).not.toBe('')
        expect(product.details[locale].trim()).not.toBe('')
        expect(product.specs.material[locale].trim()).not.toBe('')
        expect(product.specs.dimensions[locale].trim()).not.toBe('')
        expect(product.specs.care[locale].trim()).not.toBe('')
      }
    }
  })

  it('points every product at an existing WebP image under public', () => {
    for (const product of PRODUCTS) {
      expect(product.image).toMatch(/^\/products\/[a-z0-9-]+\.webp$/)
      expect(existsSync(join(process.cwd(), 'public', product.image))).toBe(true)
    }
  })
})
