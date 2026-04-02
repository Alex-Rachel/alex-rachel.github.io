# 第24篇｜地形渲染：程序化景观

## 摘要

**地形渲染（Terrain Rendering）**通过 FBM 噪声生成程序化地形，结合 **高度场 Ray Marching** 实现无限延伸的地景。

---

## 核心原理

### FBM 地形

```glsl
float terrainHeight(vec2 p) {
    float h = 0.0;
    float amplitude = 1.0;
    float frequency = 0.5;
    
    for (int i = 0; i < 6; i++) {
        h += amplitude * perlinNoise(p * frequency);
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return h * 2.0 - 1.0;  // [-1, 1] 范围
}

float mapTerrain(vec3 p) {
    return p.y - terrainHeight(p.xz);
}
```

### 高度场 Ray Marching

```glsl
float rayMarchTerrain(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 100; i++) {
        vec3 p = ro + rd * t;
        float h = mapTerrain(p);
        if (abs(h) < 0.01) return t;
        t += h * 0.5;  // 高度场步进
        if (t > 100.0) break;
    }
    return -1.0;
}
```

---

## 小结

地形渲染的核心是 FBM 高度场生成，配合高度场 Ray Marching 实现无限地形。

---

## 延伸阅读

**前置知识**：程序化噪声（第 2 篇）、Ray Marching（第 12 篇）

**下一篇**：第 25 篇「分形渲染」

---

## 知识点清单（Checklist）

- [ ] 掌握 FBM 地形的实现
- [ ] 理解高度场 Ray Marching 的步进策略
- [ ] 理解地形细节层级的 LOD
