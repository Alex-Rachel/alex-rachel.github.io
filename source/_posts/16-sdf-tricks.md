# 第16篇｜SDF 技巧：性能与精度的平衡

## 摘要

本篇讲解 SDF 开发中的高级技巧：**包围盒加速**、**二分搜索精化**、**中空化**、**层级细节**，帮助你在性能和效果间找到最佳平衡。

---

## 核心原理

### 1. 包围盒 (Bounding Volume)

```glsl
// 如果点在包围盒外，直接返回（加速）
float fastBoundingBox(vec3 p, vec3 boxCenter, vec3 boxSize) {
    vec3 q = abs(p - boxCenter) - boxSize;
    if (any(greaterThan(q, vec3(0.0)))) {
        return length(max(q, 0.0));  // 在包围盒外
    }
    return actualSDF(p);  // 在包围盒内，计算真实 SDF
}
```

### 2. 二分搜索精化

```glsl
float refineIntersect(vec3 ro, vec3 rd, float tmin, float tmax) {
    float t = tmin;
    for (int i = 0; i < 4; i++) {
        float mid = (tmin + tmax) * 0.5;
        float d = map(ro + rd * mid);
        if (abs(d) < 0.001) return mid;
        if (d < 0) tmin = mid;
        else tmax = mid;
    }
    return (tmin + tmax) * 0.5;
}
```

### 3. 中空化 (Hollowing)

```glsl
float hollowSphere(vec3 p, float outerR, float thickness) {
    return abs(sdSphere(p, outerR)) - thickness;
}
```

---

## 小结

SDF 技巧让复杂场景的实时渲染成为可能，包围盒是最重要的加速结构。

---

## 延伸阅读

**前置知识**：SDF 3D（第 6 篇）、Ray Marching（第 12 篇）

**下一篇**：第 17 篇「路径追踪与全局光照」

---

## 知识点清单（Checklist）

- [ ] 掌握包围盒加速的原理
- [ ] 理解二分搜索精化的收敛条件
- [ ] 掌握中空化的 SDF 实现
