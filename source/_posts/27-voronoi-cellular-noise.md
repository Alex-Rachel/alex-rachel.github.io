# 第27篇｜Voronoi 与细胞噪声

## 摘要

**Voronoi 图案**基于距离最近特征点的原则产生自然的细胞结构，广泛用于裂纹、宝石、细胞等效果。

---

## 核心原理

### Worley Noise（Voronoi）

```glsl
float voronoi(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    float minDist = 1.0;
    
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(x, y);
            vec2 point = hash2(i + neighbor);
            float d = length(neighbor + point - f);
            minDist = min(minDist, d);
        }
    }
    
    return minDist;
}

// F2 - F1 边缘检测
float voronoiEdge(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    float f1 = 1.0, f2 = 1.0;
    
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 n = vec2(x, y);
            vec2 p = hash2(i + n);
            float d = length(n + p - f);
            
            if (d < f1) { f2 = f1; f1 = d; }
            else if (d < f2) { f2 = d; }
        }
    }
    
    return f2 - f1;
}
```

---

## 小结

Voronoi 是程序化自然图案的重要工具，F2-F1 边缘检测用于裂纹等效果。

---

## 延伸阅读

**前置知识**：程序化噪声（第 2 篇）

**下一篇**：第 28 篇「后处理特效」

---

## 知识点清单

- [ ] 理解 Voronoi 的最近点原则
- [ ] 掌握 F2-F1 边缘检测
