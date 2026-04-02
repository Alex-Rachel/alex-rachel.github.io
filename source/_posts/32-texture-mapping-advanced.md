# 第32篇｜高级纹理映射：告别重复感

## 摘要

**高级纹理映射**解决纹理重复感问题。本篇讲解 **Triplanar Mapping**、**No-Tile 纹理**、**Ray Differentials**。

---

## 核心原理

### Triplanar Mapping

```glsl
vec3 triplanar(vec3 p, vec3 n, sampler2D tex) {
    // 三轴投影
    vec3 xproj = texture(tex, p.yz).rgb;
    vec3 yproj = texture(tex, p.xz).rgb;
    vec3 zproj = texture(tex, p.xy).rgb;
    
    // 按法线加权
    vec3 weights = abs(n);
    weights = weights / (weights.x + weights.y + weights.z);
    
    return xproj * weights.x + yproj * weights.y + zproj * weights.z;
}
```

### No-Tile 纹理

```glsl
vec3 noTile(sampler2D tex, vec2 uv) {
    vec2 i = floor(uv);
    vec2 f = fract(uv);
    
    // 相邻 tile 偏移
    float a = hash(i).x;
    float b = hash(i + vec2(1,0)).x;
    float c = hash(i + vec2(0,1)).x;
    float d = hash(i + vec2(1,1)).x;
    
    // 避免边界重复
    vec2 u = f * f * (3.0 - 2.0 * f);
    
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
```

---

## 小结

高级纹理映射解决贴图重复和接缝问题，是高品质渲染的必要技术。

---

## 延伸阅读

**前置知识**：纹理采样（第 4 篇）

**下一篇**：第 33 篇「极坐标与万花筒」

---

## 知识点清单

- [ ] 理解 Triplanar 的三轴投影原理
- [ ] 掌握 No-Tile 的边界处理
