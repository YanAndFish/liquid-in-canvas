import { describe, expect, it } from 'vitest'
import { BLUR_SIGMAS } from '../../src/liquid-glass/gaussian'
import { createHybridVolumeShader } from '../../src/liquid-glass/volume-hybrid-shader'
import { createVolumeShader, VOLUME_MEMBER_FLOATS, VOLUME_TEXTURES } from '../../src/liquid-glass/volume-shader'

describe('体积着色器', () => {
  it('按成员数量展开，成员结构与 uniform 布局一致', () => {
    for (const count of [1, 2, 5]) {
      const code = createVolumeShader(count)
      expect(code).toContain(`members: array<Member, ${count}>`)
      expect(code).toContain(`u.members[${count - 1}]`)
      expect(code).not.toContain(`u.members[${count}]`)
      const member = /struct Member \{([^}]*)\}/.exec(code)?.[1] ?? ''
      expect((member.match(/: vec4f/g) ?? []).length * 4).toBe(VOLUME_MEMBER_FLOATS)
    }
  })

  it('取样背景和每一级模糊', () => {
    const code = createVolumeShader(1)
    expect(VOLUME_TEXTURES).toBe(BLUR_SIGMAS.length + 1)
    for (let i = 0; i < VOLUME_TEXTURES; i++)
      expect(code).toContain(`@group(1) @binding(${i})`)
  })

  it('融合实体先合并平面轮廓，再对合并轮廓求一次截面', () => {
    const code = createVolumeShader(3)
    const body = /fn glass_distance\(p: vec3f\) -> f32 \{([^}]*)\}/.exec(code)?.[1] ?? ''
    expect(body).toContain('glass_body(p.xy)')
    expect(body.match(/glass_section\(/g)).toHaveLength(1)
    // 不再逐成员求三维实体后合并：倒角会在连接处相交出折痕。
    expect(code).not.toContain('glass_solid')
    // 截面参数与外观都由较厚成员主导：按顶面次序依次并入，权重只看较厚成员轮廓附近的距离。
    const fused = /fn glass_body\(xy: vec2f\) -> Body \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? ''
    const material = /fn glass_material\(p: vec3f\) -> Material \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? ''
    for (const part of [fused, material]) {
      expect(part).toContain('fusion_order()')
      expect(part).toContain('fusion_ramp(dist[index] + inset, width + inset)')
    }
    // 平面平滑合并的权重只用来合并距离与裁剪，不再混合厚度。
    expect(fused).not.toMatch(/b\.half_depth = mix\([^)]*, h\)/)
    // 每名成员的轮廓距离只算一次。
    expect(fused.match(/glass_outline\(/g)).toHaveLength(3)
  })

  it('斜着走的出射光线按方向缩小步长，竖直的入射光线与到达表面的判断仍用原值', () => {
    const code = createVolumeShader(2)
    expect(code).toContain('return vec2f(d, d / (abs(direction.z) + b.lipschitz * length(direction.xy)));')
    // 截面对高度的导数不超过 1：竖直的入射光线按原距离前进。
    const entry = /fn glass_entry\(xy: vec2f\) -> vec4f \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? ''
    expect(entry).toContain('let d = glass_distance(p);')
    expect(entry).toContain('max(d * 0.85, 0.025)')
    const exit = /fn glass_exit\([^)]*\) -> vec4f \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? ''
    expect(exit).toContain('let d = glass_march(p, direction);')
    expect(exit).toContain('if (d.x > -0.025)')
    expect(exit).toContain('max(-d.y * 0.85, 0.035)')
    // 法线仍按原距离场的有限差分求。
    expect(code).toMatch(/fn glass_normal[\s\S]*?glass_distance\(p \+ vec3f\(e, 0\.0, 0\.0\)\)/)
  })

  it('成员按顶面从低到高排序，顶面一样高时下标小的在前', () => {
    const code = createVolumeShader(3)
    expect(code).toContain('fn fusion_order() -> array<i32, 3>')
    expect(code).toContain('order[select(0, 1, t1 < t0) + select(0, 1, t2 < t0)] = 0;')
    expect(code).toContain('order[select(0, 1, t0 <= t1) + select(0, 1, t2 < t1)] = 1;')
    expect(code).toContain('order[select(0, 1, t0 <= t2) + select(0, 1, t1 <= t2)] = 2;')
    // 只有一名成员时不需要排序。
    expect(createVolumeShader(1)).toContain('order[0] = 0;')
  })

  it('混合光路的投影距离与三维求交用同一个合并截面', () => {
    const code = createHybridVolumeShader(3)
    expect(code).toContain('outline = max(glass_section(b.planar, 0.0, b), b.clip);')
    expect(code).toContain('return max(glass_section(b.planar, 0.0, b), b.clip);')
  })
})
