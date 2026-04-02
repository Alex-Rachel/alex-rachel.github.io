# 第13篇｜CSG 布尔运算：形体的加减乘

## 摘要

**CSG（Constructive Solid Geometry）**通过布尔运算组合简单 SDF 形体创建复杂几何。本篇讲解 Union、Subtraction、Intersection 的 SDF 实现，以及平滑混合的数学原理。

---

## 核心原理

### 基本布尔运算

```glsl
float opUnion(float d1, float d2) {
    return min(d1, d2);
}

float opSubtraction(float d1, float d2) {
    return max(d1, -d2);
}

float opIntersection(float d1, float d2) {
    return max(d1, d2);
}
```

### 平滑布尔运算

**Polynomial Smooth Min (k = 融合系数)**：

```glsl
float opSmoothUnion(float d1, float d2, float k) {
    float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) - k * h * (1.0 - h);
}
```

---

## 实战案例：子弹形

```glsl
float bullet(vec3 p) {
    // 圆柱 + 半球头
    float cylinder = sdCylinder(p - vec3(0, 0.5, 0), vec3(0.3, 0.5, 0));
    float head = sdSphere(p - vec3(0, 1.0, 0), 0.3);
    
    return opSmoothUnion(cylinder, head, 0.1);
}
```

---

## 小结

CSG 布尔运算是创建复杂 SDF 形体的基础，熟练掌握 Union/Subtraction/Intersection 及平滑版本。

---

## 延伸阅读

**前置知识**：SDF 3D（第 6 篇）

**下一篇**：第 14 篇「空间重复」

---

## 知识点清单（Checklist）

- [ ] 掌握三种基本布尔运算的 SDF 形式
- [ ] 理解平滑 min 的多项式近似
- [ ] 能组合简单形体创建复杂形状
