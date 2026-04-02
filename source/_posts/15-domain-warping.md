# 第15篇｜域扭曲：有机形态的密码

## 摘要

**域扭曲（Domain Warping）**是用噪声函数扭曲空间坐标，产生有机、流动形态的技术。本篇讲解 FBM 驱动的扭曲、多重扭曲，以及在 SDF 中的应用。

---

## 核心原理

### 基本域扭曲

```glsl
vec3 warp(vec3 p) {
    // 用噪声偏移原始坐标
    float noise = perlinNoise(p.xy * 0.5);
    return p + vec3(noise, noise, 0.0);
}

// SDF 扭曲
float warpedSDF(vec3 p) {
    vec3 q = warp(p);
    return sdSphere(q, 0.5);
}
```

### FBM 域扭曲

```glsl
vec3 fbmWarp(vec3 p) {
    vec3 q;
    q.x = p.x + fbm(p + vec3(0.0, 0.0, 0.0));
    q.y = p.y + fbm(p + vec3(5.2, 1.3, 2.1));
    q.z = p.z + fbm(p + vec3(1.7, 9.2, 3.8));
    return q;
}
```

### 多重扭曲

```glsl
vec3 doubleWarp(vec3 p) {
    // 第一层扭曲
    vec3 q = fbmWarp(p);
    // 第二层扭曲
    q = fbmWarp(q + vec3(1.7, 9.2, 3.8));
    return q;
}
```

---

## 实战案例：有机地形

```glsl
float organicTerrain(vec3 p) {
    vec3 q = fbmWarp(p * 0.5);
    float terrain = p.y - fbm(q.xz * 2.0) * 0.5;
    return terrain;
}
```

---

## 小结

域扭曲是创建有机形态的核心技术，配合噪声和 FBM 可以产生丰富的自然效果。

---

## 延伸阅读

- Inigo Quilez - ["Domain Warping"](https://iquilezles.org/articles/warp/)

**前置知识**：程序化噪声（第 2 篇）、SDF 3D（第 6 篇）

**下一篇**：第 16 篇「SDF 技巧」

---

## 知识点清单（Checklist）

- [ ] 理解域扭曲的基本原理
- [ ] 掌握 FBM 驱动的多重扭曲
- [ ] 能用域扭曲创建有机形态
