/// <reference path="../../src/vue.d.ts" />
/// <reference path="../../src/react.d.ts" />
import type { HTMLAttributes as ReactAttributes } from 'react'
import type { HTMLAttributes as VueAttributes } from 'vue'
import type { LiquidGlassAttributes } from '../../src/attributes'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  GLASS_ATTR,
  GLASS_CLIP_ATTR,
  GLASS_FADE_ATTR,
  GLASS_MODAL_ATTR,
  GLASS_PLACE_ATTR,
  GLASS_SCOPE_ATTR,
  GLASS_SCRIM_ATTR,
  STAGE_OVERLAY_ATTR,
} from '../../src/contract'
import { GLASS_OPTION_ATTRS } from '../../src/liquid-glass/options'

// 类型检查（`pnpm typecheck`）负责这些断言；运行时只确认清单本身。
const CONTRACT_ATTRS = [
  GLASS_ATTR,
  GLASS_CLIP_ATTR,
  GLASS_MODAL_ATTR,
  GLASS_SCRIM_ATTR,
  GLASS_FADE_ATTR,
  GLASS_SCOPE_ATTR,
  GLASS_PLACE_ATTR,
  STAGE_OVERLAY_ATTR,
] as const
type KnownAttribute = (typeof GLASS_OPTION_ATTRS)[number] | (typeof CONTRACT_ATTRS)[number]

describe('data-* 属性的类型', () => {
  it('与运行时读取的属性一一对应', () => {
    expectTypeOf<keyof LiquidGlassAttributes>().toEqualTypeOf<KnownAttribute>()
    expect(new Set([
      ...GLASS_OPTION_ATTRS,
      ...CONTRACT_ATTRS,
    ]).size).toBe(GLASS_OPTION_ATTRS.length + CONTRACT_ATTRS.length)
  })

  it('接受数字与数字字符串，拒绝无效写法', () => {
    expectTypeOf<{ 'data-glass-blur': 12 }>().toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-glass-blur': '0.5' }>().toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-glass-blur': 'soft' }>().not.toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-glass-radius': '20 20 0 0' }>().toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-glass-variant': 'frosted' }>().not.toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-glass-tint': 'fff' }>().not.toExtend<LiquidGlassAttributes>()
    // 框架把 false 渲染成 "false"，舞台把它当作没有这个属性。
    expectTypeOf<{ 'data-liquid-glass': false }>().toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-liquid-glass': boolean }>().toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-glass-morph': boolean }>().toExtend<LiquidGlassAttributes>()
    expectTypeOf<{ 'data-liquid-glass': 'yes' }>().not.toExtend<LiquidGlassAttributes>()
  })

  it('扩展 Vue 与 React 的原生元素属性', () => {
    expectTypeOf<VueAttributes['data-glass-variant']>().toEqualTypeOf<LiquidGlassAttributes['data-glass-variant']>()
    expectTypeOf<ReactAttributes<HTMLDivElement>['data-glass-variant']>().toEqualTypeOf<LiquidGlassAttributes['data-glass-variant']>()
  })
})
