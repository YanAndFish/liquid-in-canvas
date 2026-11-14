import { describe, expect, it } from 'vitest'
import { BLUR_SIGMAS } from '../../src/liquid-glass/gaussian'
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
})
