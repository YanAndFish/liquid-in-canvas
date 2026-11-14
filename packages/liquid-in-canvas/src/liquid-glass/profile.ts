/**
 * 玻璃实体的截面：一块上下两面平行的平板，四周的边缘按超椭圆弧倒角。
 *
 * 截面由五个量决定：半厚度、倒角宽度、倒角高度、曲线指数和底面倒角比例。
 * 体积着色器、SVG 滤镜回退和调参面板的截面图都从这里取值，三者的形状保持一致。
 */

/** 决定截面形状的材质参数。 */
export interface GlassProfileOptions {
  /** 三维实体的半厚度参考值，实际厚度受控件短边限制。 */
  refraction: number
  /** 倒角的水平宽度与半厚度之比。 */
  bevelWidth: number
  /** 倒角的垂直高度与半厚度之比，1 表示侧面没有竖直部分。 */
  bevelHeight: number
  /** 倒角曲线的超椭圆指数：1 是直线斜面，2 是椭圆弧，越大越接近直角。 */
  bevelCurve: number
  /** 底面倒角相对顶面倒角的比例，0 表示底面是带直角边的平面。 */
  bottomBevel: number
}

/** 一块玻璃实际使用的截面，长度单位为 CSS 像素。 */
export interface GlassProfile {
  /** 半厚度。 */
  halfDepth: number
  /** 顶面倒角的水平宽度。 */
  bevelWidth: number
  /** 顶面倒角的垂直高度。 */
  bevelHeight: number
  /** 倒角曲线的超椭圆指数。 */
  curve: number
  /** 底面倒角相对顶面倒角的比例。 */
  bottomBevel: number
}

/** 倒角的最小尺寸。底面倒角为 0 时也保留这个尺寸，距离场不会除以零。 */
export const MIN_BEVEL = 0.5

/** 半厚度：`refraction` 受控件短边限制。 */
export function profileHalfDepth(refraction: number, width: number, height: number): number {
  return Math.max(2, Math.min(refraction, width * 0.3, height * 0.3))
}

/** 顶面倒角的水平宽度，尚未按控件尺寸限制。 */
export function profileBevelWidth(halfDepth: number, ratio: number): number {
  return Math.max(MIN_BEVEL, halfDepth * ratio)
}

/** 顶面倒角的垂直高度，不超过半厚度。 */
export function profileBevelHeight(halfDepth: number, ratio: number): number {
  return Math.min(halfDepth, Math.max(MIN_BEVEL, halfDepth * ratio))
}

/**
 * 按控件尺寸算出实际截面。倒角宽度不超过短边的一半，与体积着色器按压后的限制一致。
 * 不传尺寸时得到不受控件尺寸限制的截面。
 */
export function glassProfile(options: GlassProfileOptions, width = Infinity, height = Infinity): GlassProfile {
  const halfDepth = profileHalfDepth(options.refraction, width, height)
  return {
    halfDepth,
    bevelWidth: Math.min(profileBevelWidth(halfDepth, options.bevelWidth), Math.max(MIN_BEVEL, Math.min(width, height) / 2)),
    bevelHeight: profileBevelHeight(halfDepth, options.bevelHeight),
    curve: options.bevelCurve,
    bottomBevel: options.bottomBevel,
  }
}

/**
 * 宽 `width`、高 `height`、指数 `power` 的顶面倒角在距轮廓 `inset` 处的倾斜程度，即表面法线与屏幕法线夹角的正弦：轮廓处为 1，倒角以内为 0。
 *
 * 超椭圆 uᵖ + vᵖ = 1 的坡度为 (u / v)ᵖ⁻¹，再按倒角的高宽比换算成实际坡度。
 */
export function glassEdgeTilt(inset: number, width: number, height: number, power: number): number {
  if (inset >= width)
    return 0
  const u = Math.min(1, Math.max(0, 1 - inset / width))
  const v = (1 - u ** power) ** (1 / power)
  if (v <= 0)
    return 1
  const slope = height / width * (u / v) ** (power - 1)
  return slope / Math.sqrt(1 + slope * slope)
}

/**
 * 截面左侧边缘的轮廓线，用于绘制截面图。
 *
 * 横坐标是到轮廓的距离（向内为正），纵坐标是到背景平面的高度。
 * 点从底面 `reach` 处出发，经底面倒角、竖直侧面、顶面倒角，到顶面 `reach` 处结束。
 * 每段倒角用 `samples` 段折线近似。
 */
export function glassProfileOutline(profile: GlassProfile, elevation: number, reach: number, samples = 32): [number, number][] {
  const { halfDepth, bevelWidth, bevelHeight, curve, bottomBevel } = profile
  const bottomWidth = Math.max(MIN_BEVEL, bevelWidth * bottomBevel)
  const bottomHeight = Math.max(MIN_BEVEL, bevelHeight * bottomBevel)
  const top = elevation + halfDepth * 2
  const exponent = 2 / curve
  const points: [number, number][] = [
    [
      Math.max(reach, bottomWidth),
      elevation,
    ],
  ]
  for (let i = samples; i >= 0; i--) {
    const t = i / samples * Math.PI / 2
    points.push([
      bottomWidth * (1 - Math.cos(t) ** exponent),
      elevation + bottomHeight * (1 - Math.sin(t) ** exponent),
    ])
  }
  for (let i = 0; i <= samples; i++) {
    const t = i / samples * Math.PI / 2
    points.push([
      bevelWidth * (1 - Math.cos(t) ** exponent),
      top - bevelHeight + bevelHeight * Math.sin(t) ** exponent,
    ])
  }
  points.push([
    Math.max(reach, bevelWidth),
    top,
  ])
  return points
}
