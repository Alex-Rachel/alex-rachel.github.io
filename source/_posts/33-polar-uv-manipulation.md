# 第33篇｜极坐标与万花筒

## 摘要

**极坐标变换**在图形学中有广泛应用。本篇讲解 **极坐标/对数极坐标**、**万花筒效果**、**螺旋映射**。

---

## 核心原理

### 极坐标变换

```glsl
vec2 cartesian2polar(vec2 uv) {
    return vec2(length(uv), atan(uv.y, uv.x));
}

vec2 polar2cartesian(vec2 polar) {
    return vec2(polar.x * cos(polar.y), polar.x * sin(polar.y));
}
```

### 万花筒

```glsl
vec2 kaleidoscope(vec2 uv, int segments) {
    float angle = atan(uv.y, uv.x);
    float r = length(uv);
    
    float segmentAngle = 2.0 * 3.14159 / float(segments);
    angle = mod(angle, segmentAngle);
    
    // 折叠到第一段
    if (angle > segmentAngle * 0.5) {
        angle = segmentAngle - angle;
    }
    
    return vec2(r * cos(angle), r * sin(angle));
}
```

---

## 小结

极坐标变换是创建放射对称、万花筒效果的基础。

---

## 延伸阅读

**前置知识**：SDF 2D（第 1 篇）

**下一篇**：第 34 篇「物理模拟」

---

## 知识点清单

- [ ] 掌握极坐标与笛卡尔坐标的转换
- [ ] 理解万花筒的角度折叠原理
