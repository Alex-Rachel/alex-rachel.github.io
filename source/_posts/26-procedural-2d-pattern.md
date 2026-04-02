# 第26篇｜2D 程序化图案：砖块与伊斯兰花纹

## 摘要

**2D 程序化图案**通过数学函数生成砖块、Truchet 瓦片、伊斯兰几何花纹等。本篇讲解各种图案的生成算法。

---

## 核心原理

### 砖块图案

```glsl
vec3 brickPattern(vec2 uv, float rows, float cols) {
    vec2 brickUV = vec2(uv.x * cols, uv.y * rows);
    vec2 brick = fract(brickUV);
    
    // 灰浆缝隙
    float mortar = smoothstep(0.0, 0.02, brick.x) * smoothstep(0.0, 0.02, brick.y);
    
    return vec3(mortar);
}
```

### Truchet 瓦片

```glsl
float truchetPattern(vec2 uv) {
    vec2 tile = floor(uv);
    vec2 local = fract(uv);
    
    // 随机选择方向
    float choice = hash(tile).x > 0.5 ? 1.0 : 0.0;
    
    float d;
    if (choice > 0.5) {
        d = abs(length(local) - 0.5);
    } else {
        d = abs(length(1.0 - local) - 0.5);
    }
    
    return smoothstep(0.02, 0.01, d);
}
```

---

## 小结

2D 程序化图案通过简单的数学规则创建丰富的视觉图案。

---

## 延伸阅读

**前置知识**：SDF 2D（第 1 篇）

**下一篇**：第 27 篇「Voronoi 与细胞噪声」

---

## 知识点清单

- [ ] 掌握砖块图案的 UV 变换
- [ ] 理解 Truchet 瓦片的随机方向选择
