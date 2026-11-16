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
    // 外观的合并权重按平面距离算，与剖面光学相同。
    const material = /fn glass_material\(p: vec3f\) -> Material \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? ''
    expect(material).toContain('glass_outline(xy, m)')
  })

  it('混合光路的投影距离与三维求交用同一个合并截面', () => {
    const code = createHybridVolumeShader(3)
    expect(code).toContain('outline = max(glass_section(b.planar, 0.0, b), b.clip);')
    expect(code).toContain('return max(glass_section(b.planar, 0.0, b), b.clip);')
  })
})
