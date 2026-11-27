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
      blur: 14,
      refraction: 80,
      bevelWidth: 0.8,
      bevelHeight: 1,
      bevelCurve: 2.75,
      bottomBevel: 1,
      dispersion: 0.14,
      ior: 1.45,
      lens: 0,
      saturation: 1.35,
      brightness: 1,
      tint: '#171b20',
      tintAlpha: 0.24,
      specular: 0.7,
      shadow: 0.16,
      shadowSize: 32,
      variant: 'regular',
      anchor: null,
      morph: null,
      morphFrom: [],
      morphTo: [],
      morphStretch: 1,
      morphBounce: 0.4,
      morphWobble: 0.1,
      morphSpeed: 1,
      morphContent: 'static',
      materialize: true,
    })
  })

  it('returns the regular light defaults', () => {
    expect(parseGlassOptions(makeElement(), 'light')).toEqual({
      layer: 0,
      fusion: 32,
      elevation: 16,
      radius: [28, 28, 28, 28],
      blur: 14,
      refraction: 80,
      bevelWidth: 0.8,
      bevelHeight: 1,
      bevelCurve: 2.75,
      bottomBevel: 1,
      dispersion: 0.14,
      ior: 1.45,
      lens: 0,
      saturation: 1.35,
      brightness: 1.06,
      tint: '#f6f6f8',
      tintAlpha: 0.26,
      specular: 0.7,
      shadow: 0.16,
      shadowSize: 32,
      variant: 'regular',
      anchor: null,
      morph: null,
      morphFrom: [],
      morphTo: [],
      morphStretch: 1,
      morphBounce: 0.4,
      morphWobble: 0.1,
      morphSpeed: 1,
      morphContent: 'static',
      materialize: true,
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
      blur: 0,
      refraction: 80,
      bevelWidth: 0.8,
      bevelHeight: 1,
      bevelCurve: 2.75,
      bottomBevel: 1,
      dispersion: 0.2,
      ior: 1.45,
      lens: 0,
      saturation: 1.15,
      brightness: 1,
      tint: '#ffffff',
      tintAlpha: 0.01,
      specular: 0.9,
      shadow: 0.12,
      shadowSize: 28,
      variant: 'clear',
      anchor: null,
      morph: null,
      morphFrom: [],
      morphTo: [],
      morphStretch: 1,
      morphBounce: 0.4,
      morphWobble: 0.1,
      morphSpeed: 1,
      morphContent: 'static',
      materialize: true,
    })
  })

  it('applies the clear light tint', () => {
    expect(parseGlassOptions(makeElement({ 'data-glass-variant': 'clear' }), 'light')).toMatchObject({
      tint: '#ffffff',
      tintAlpha: 0.01,
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
      refraction: 80,
      bevelWidth: 0.8,
      bevelHeight: 1,
      bevelCurve: 2.75,
      bottomBevel: 1,
      dispersion: 1,
      ior: 1.45,
      lens: 0.5,
      saturation: 1.15,
      brightness: 1,
      tint: '#aabbcc',
      tintAlpha: 0.01,
      specular: 0.9,
      shadow: 0.12,
      shadowSize: 90,
      variant: 'clear',
      anchor: null,
      morph: 'tab',
      morphFrom: [],
      morphTo: [],
      morphStretch: 1,
      morphBounce: 0.4,
      morphWobble: 0.1,
      morphSpeed: 1,
      morphContent: 'static',
      materialize: true,
    })
  })

  it('分裂与合并的名字按空格拆分，缺省一侧时互相补齐', () => {
    const both = parseGlassOptions(makeElement({
      'data-glass-morph': 'submit',
      'data-glass-morph-from': ' clear  card ',
      'data-glass-morph-to': 'card',
    }), 'dark')
    expect(both.morphFrom).toEqual(['clear', 'card'])
    expect(both.morphTo).toEqual(['card'])

    const from = parseGlassOptions(makeElement({ 'data-glass-morph': 'card', 'data-glass-morph-from': 'trigger' }), 'dark')
    expect(from.morphTo).toEqual(['trigger'])
    const to = parseGlassOptions(makeElement({ 'data-glass-morph': 'card', 'data-glass-morph-to': 'trigger' }), 'dark')
    expect(to.morphFrom).toEqual(['trigger'])

    const unnamed = parseGlassOptions(makeElement({ 'data-glass-morph-from': 'trigger' }), 'dark')
    expect(unnamed.morph).toBe('')
    expect(parseGlassOptions(makeElement({ 'data-glass-morph-from': '  ' }), 'dark').morph).toBeNull()
  })

  it('分裂与合并的名字不从作用域继承', () => {
    const scope = makeElement({ 'data-glass-scope': '', 'data-glass-morph-from': 'trigger', 'data-glass-morph-to': 'trigger' })
    const element = makeElement({})
    scope.append(element)
    const options = parseGlassOptions(element, 'dark')
    expect(options.morph).toBeNull()
    expect(options.morphFrom).toEqual([])
    expect(options.morphTo).toEqual([])
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
      blur: 14,
      refraction: 80,
      bevelWidth: 0.8,
      bevelHeight: 1,
      bevelCurve: 2.75,
      bottomBevel: 1,
      dispersion: 0.14,
      ior: 1.45,
      tintAlpha: 0.24,
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

  it('treats "true" as an unnamed morph and "false" as off, so booleans from JSX never share a name', () => {
    expect(parseGlassOptions(makeElement({ 'data-glass-morph': 'true' }), 'dark').morph).toBe('')
    expect(parseGlassOptions(makeElement({ 'data-glass-morph': 'false' }), 'dark').morph).toBeNull()
    expect(parseGlassOptions(makeElement({ 'data-glass-morph': 'tab' }), 'dark').morph).toBe('tab')
  })

  it('parses the morph content mode and falls back to static', () => {
    const mode = (raw: string) => parseGlassOptions(makeElement({ 'data-glass-morph-content': raw }), 'dark').morphContent
    expect(mode(' Follow ')).toBe('follow')
    expect(mode('clip')).toBe('clip')
    expect(mode('stretch')).toBe('static')
  })

  it('turns materialize off with "false"', () => {
    expect(parseGlassOptions(makeElement({ 'data-glass-materialize': 'false' }), 'dark').materialize).toBe(false)
    expect(parseGlassOptions(makeElement({ 'data-glass-materialize': 'true' }), 'dark').materialize).toBe(true)
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

describe('data-glass-scope', () => {
  function tree(): { outer: HTMLElement, inner: HTMLElement, element: HTMLElement } {
    const outer = makeElement({
      'data-glass-scope': '',
      'data-glass-blur': '10',
      'data-glass-layer': '2',
      'data-glass-variant': 'clear',
      'data-glass-morph': 'tab',
    })
    const inner = makeElement({ 'data-glass-scope': '', 'data-glass-blur': '20' })
    const element = makeElement({ 'data-liquid-glass': '' })
    outer.append(inner)
    inner.append(element)
    return { outer, inner, element }
  }

  it('uses the nearest scope, then outer scopes, then the defaults', () => {
    const { element } = tree()
    const options = parseGlassOptions(element, 'dark')
    expect(options.blur).toBe(20)
    expect(options.layer).toBe(2)
    expect(options.variant).toBe('clear')
    expect(options.shadow).toBe(0.12)
  })

  it('lets the element override its scopes', () => {
    const { element } = tree()
    element.setAttribute('data-glass-blur', '4')
    expect(parseGlassOptions(element, 'dark').blur).toBe(4)
  })

  it('does not pass morph names down', () => {
    const { element } = tree()
    expect(parseGlassOptions(element, 'dark').morph).toBeNull()
  })

  it('ignores ancestors without data-glass-scope and scopes set to "false"', () => {
    const { outer, inner, element } = tree()
    inner.setAttribute('data-glass-scope', 'false')
    expect(parseGlassOptions(element, 'dark').blur).toBe(10)
    outer.removeAttribute('data-glass-scope')
    expect(parseGlassOptions(element, 'dark').blur).toBe(14)
  })
})

describe('折射率', () => {
  it('读取 data-glass-ior 并限制在 1–2.5', () => {
    const element = document.createElement('div')
    expect(parseGlassOptions(element, 'dark').ior).toBe(1.45)
    element.setAttribute('data-glass-ior', '1.8')
    expect(parseGlassOptions(element, 'dark').ior).toBe(1.8)
    element.setAttribute('data-glass-ior', '9')
    expect(parseGlassOptions(element, 'dark').ior).toBe(2.5)
    element.setAttribute('data-glass-ior', '0.5')
    expect(parseGlassOptions(element, 'dark').ior).toBe(1)
  })
})
