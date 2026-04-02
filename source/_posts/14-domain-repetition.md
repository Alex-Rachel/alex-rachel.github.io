# 第14篇｜空间重复：无限的复制与折叠

## 摘要

**空间重复（Domain Repetition）**是程序化生成无限规律结构的核心技术。本篇讲解 1D/2D/3D 重复、有限重复、以及 **Folding** 操作。

---

## 核心原理

### 1. 无限重复

```glsl
// 1D 重复
float repeat1D(float p, float period) {
    return mod(p, period) - period * 0.5;
}

// 3D 重复
vec3 repeat3D(vec3 p, vec3 period) {
    return mod(p, period) - period * 0.5;
}
```

### 2. 有限重复

```glsl
float limitedRepeat(vec3 p, float period, vec3 limit) {
    return p - period * clamp(round(p / period), -limit, limit);
}
```

### 3. Folding（对称折叠）

```glsl
// 平面折叠
float foldX(vec3 p) {
    return vec3(abs(p.x), p.y, p.z);
}

// 角折叠
vec3 foldAlongAxis(vec3 p, float foldAngle) {
    float a = foldAngle;
    mat3 foldMat = mat3(
        -cos(2*a), sin(2*a), 0,
        sin(2*a), cos(2*a), 0,
        0, 0, 1
    );
    return p.z < 0.0 ? foldMat * p : p;
}
```

---

## 实战案例：无限柱列

```glsl
float infiniteColumns(vec3 p, float radius) {
    // 无限重复 XY 平面
    vec2 q = repeat2D(p.xy, vec2(2.0));
    float d = sdCylinder(vec3(q.x, p.y, q.y), vec3(radius, 1.0, 0));
    return d;
}
```

---

## 小结

空间重复是创建无限规律结构的关键，配合 CSG 可以创建建筑、森林等程序化场景。

---

## 延伸阅读

**前置知识**：SDF 3D（第 6 篇）

**下一篇**：第 15 篇「域扭曲」

---

## 知识点清单（Checklist）

- [ ] 掌握 mod() 实现重复的原理
- [ ] 理解有限重复的 clamp 限制
- [ ] 掌握 Folding 的对称操作
