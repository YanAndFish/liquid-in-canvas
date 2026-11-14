import { describe, expect, it } from 'vitest'
import { glassOptionsSignature, parseGlassOptions } from '../../src/liquid-glass/options'

function makeElement(attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value)
  return element
}

function radius(raw: string): readonly number[] {
  return parseGlassOptions(makeElement({ 'data-glass-radius': raw }), 'dark').radius
}

function tint(raw: string, theme: 'light' | 'dark' = 'dark'): string {
  return parseGlassOptions(makeElement({ 'data-glass-tint': raw }), theme).tint
}

function anchor(raw: string): string | null {
  return parseGlassOptions(makeElement({ 'data-glass-anchor': raw }), 'dark').anchor
}

describe('parseGlassOptions', () => {
  it('returns the regular dark defaults', () => {
    expect(parseGlassOptions(makeElement(), 'dark')).toEqual({
      layer: 0,
      fusion: 32,
      elevation: 16,
      radius: [28, 28, 28, 28],
      blur: 18,
      refraction: 24,
      bevelWidth: 0.68,
      bevelHeight: 0.68,
      bevelCurve: 3,
      bottomBevel: 1,
      dispersion: 0.3,
      lens: 0.14,
      tint: '#171b20',
      tintAlpha: 0.28,
      specular: 0.7,
      shadow: 0.32,
      shadowSize: 32,
      variant: 'regular',
      anchor: null,
      morph: null,
      morphStretch: 1,
      morphBounce: 0.33,
      morphWobble: 0.35,
    })
  })

  it('returns the regular light defaults', () => {
    expect(parseGlassOptions(makeElement(), 'light')).toEqual({
      layer: 0,
      fusion: 32,
      elevation: 16,
      radius: [28, 28, 28, 28],
      blur: 18,
      refraction: 24,
      bevelWidth: 0.68,
      bevelHeight: 0.68,
      bevelCurve: 3,
      bottomBevel: 1,
      dispersion: 0.3,
      lens: 0.14,
      tint: '#f6f6f8',
      tintAlpha: 0.32,
      specular: 0.7,
      shadow: 0.32,
      shadowSize: 32,
      variant: 'regular',
      anchor: null,
      morph: null,
      morphStretch: 1,
      morphBounce: 0.33,
      morphWobble: 0.35,
    })
  })

  it('expands radius values in CSS order', () => {
    expect(radius('12')).toEqual([12, 12, 12, 12])
    expect(radius('12 20')).toEqual([12, 20, 12, 20])
    expect(radius('12, 20, 8')).toEqual([12, 20, 8, 20])
    expect(radius('1 2 3 4')).toEqual([1, 2, 3, 4])
  })

  it('clamps radius values to 0..2000', () => {
    expect(radius('-4 2100')).toEqual([0, 2000, 0, 2000])
    expect(radius('5000')).toEqual([2000, 2000, 2000, 2000])
  })

  it('falls back to the default radius for empty or invalid input', () => {
    expect(radius('')).toEqual([28, 28, 28, 28])
    expect(radius('wide')).toEqual([28, 28, 28, 28])
  })

  it('applies the clear dark preset', () => {
    expect(parseGlassOptions(makeElement({ 'data-glass-variant': 'clear' }), 'dark')).toEqual({
      layer: 0,
      fusion: 32,
      elevation: 16,
      radius: [28, 28, 28, 28],
      blur: 8,
      refraction: 20,
      bevelWidth: 0.68,
      bevelHeight: 0.68,
      bevelCurve: 3,
      bottomBevel: 1,
      dispersion: 0.4,
      lens: 0.22,
      tint: '#ffffff',
      tintAlpha: 0.01,
      specular: 0.9,
      shadow: 0.26,
      shadowSize: 28,
      variant: 'clear',
      anchor: null,
      morph: null,
      morphStretch: 1,
      morphBounce: 0.33,
      morphWobble: 0.35,
    })
  })

  it('applies the clear light tint', () => {
    expect(parseGlassOptions(makeElement({ 'data-glass-variant': 'clear' }), 'light')).toMatchObject({
      tint: '#f7f2e8',
      tintAlpha: 0.04,
      variant: 'clear',
    })
  })

  it('lets explicit attributes override the chosen preset', () => {
    const options = parseGlassOptions(makeElement({
      'data-glass-variant': 'clear',
      'data-glass-blur': '40',
      'data-glass-dispersion': '1',
      'data-glass-tint': '#abc',
      'data-glass-shadow-size': '90',
      'data-glass-lens': '0.5',
      'data-glass-morph': ' tab ',
    }), 'light')

    expect(options).toEqual({
      layer: 0,
      fusion: 32,
      elevation: 16,
      radius: [28, 28, 28, 28],
      blur: 40,
      refraction: 20,
      bevelWidth: 0.68,
      bevelHeight: 0.68,
      bevelCurve: 3,
      bottomBevel: 1,
      dispersion: 1,
      lens: 0.5,
      tint: '#aabbcc',
      tintAlpha: 0.04,
      specular: 0.9,
      shadow: 0.26,
      shadowSize: 90,
      variant: 'clear',
      anchor: null,
      morph: 'tab',
      morphStretch: 1,
      morphBounce: 0.33,
      morphWobble: 0.35,
    })
  })

  it('limits the lens strength and treats an empty morph as an unnamed transition', () => {
    const options = parseGlassOptions(makeElement({
      'data-glass-lens': '3',
      'data-glass-morph': '',
    }), 'light')
    expect(options.lens).toBe(0.6)
    expect(options.morph).toBe('')
  })

  it('reads and clamps the liquid flow tuning', () => {
    const options = parseGlassOptions(makeElement({
      'data-glass-morph': '',
      'data-glass-morph-stretch': '1.6',
      'data-glass-morph-bounce': '3',
      'data-glass-morph-wobble': '-1',
    }), 'light')
    expect(options.morphStretch).toBe(1.6)
    expect(options.morphBounce).toBe(1)
    expect(options.morphWobble).toBe(0)
  })

  it('falls back on invalid numbers and clamps valid ones', () => {
    const options = parseGlassOptions(makeElement({
      'data-glass-blur': 'wide',
      'data-glass-refraction': '',
      'data-glass-dispersion': 'NaN',
      'data-glass-tint-alpha': 'oops',
      'data-glass-specular': '9',
      'data-glass-shadow': '-1',
      'data-glass-shadow-size': '500',
    }), 'dark')

    expect(options).toMatchObject({
      blur: 18,
      refraction: 24,
      bevelWidth: 0.68,
      bevelHeight: 0.68,
      bevelCurve: 3,
      bottomBevel: 1,
      dispersion: 0.3,
      tintAlpha: 0.28,
      specular: 2,
      shadow: 0,
      shadowSize: 100,
    })
  })

  it('reads and clamps the cross-section attributes', () => {
    const options = parseGlassOptions(makeElement({
      'data-glass-bevel-width': '1.5',
      'data-glass-bevel-height': '2',
      'data-glass-bevel-curve': '0',
      'data-glass-bottom-bevel': '0.25',
    }), 'dark')

    expect(options).toMatchObject({
      bevelWidth: 1.5,
      bevelHeight: 1,
      bevelCurve: 1,
      bottomBevel: 0.25,
    })
  })

  it('falls back on invalid hex colors', () => {
    expect(tint('#12')).toBe('#171b20')
    expect(tint('#gggggg')).toBe('#171b20')
    expect(tint('red')).toBe('#171b20')
    expect(tint('#zzz', 'light')).toBe('#f6f6f8')
  })

  it('normalizes valid hex colors', () => {
    expect(tint('#ABC')).toBe('#aabbcc')
    expect(tint('#A1B2C3')).toBe('#a1b2c3')
  })

  it('trims anchors and treats blank values as null', () => {
    expect(anchor('  hero  ')).toBe('hero')
    expect(anchor('   ')).toBeNull()
    expect(parseGlassOptions(makeElement(), 'dark').anchor).toBeNull()
  })

  it('does not throw when the element has no attributes', () => {
    expect(() => parseGlassOptions(makeElement(), 'light')).not.toThrow()
  })
})

describe('glassOptionsSignature', () => {
  it('changes when a value changes', () => {
    const base = parseGlassOptions(makeElement({ 'data-glass-blur': '20' }), 'dark')
    const changed = parseGlassOptions(makeElement({ 'data-glass-blur': '21' }), 'dark')

    expect(glassOptionsSignature(base)).not.toBe(glassOptionsSignature(changed))
  })

  it('is stable for equivalent input', () => {
    const first = parseGlassOptions(makeElement({
      'data-glass-radius': '12 20',
      'data-glass-blur': '20',
      'data-glass-tint': '#ABC',
      'data-glass-anchor': 'hero',
    }), 'dark')
    const second = parseGlassOptions(makeElement({
      'data-glass-radius': ' 12,20 ',
      'data-glass-blur': ' 20 ',
      'data-glass-tint': '#aabbcc',
      'data-glass-anchor': '  hero  ',
    }), 'dark')

    expect(glassOptionsSignature(first)).toBe(glassOptionsSignature(second))
  })
})
