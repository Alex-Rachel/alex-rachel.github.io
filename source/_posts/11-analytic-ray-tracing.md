# 第11篇｜解析射线追踪：精确相交计算

## 摘要

**解析射线追踪（Analytic Ray Tracing）**通过数学公式直接计算射线与几何体的精确交点，无需迭代逼近。本篇讲解射线与球体、平面、盒子的闭合解计算，是理解光线投射和 Ray Marching 的数学基础。

---

## 核心原理

### 射线参数方程

$$\vec{R}(t) = \vec{O} + t\vec{D}$$

其中 $\vec{O}$ 是射线原点，$\vec{D}$ 是方向向量，$t \geq 0$ 是参数。

### 1. 射线与球体相交

解二次方程：

```
P(t) = O + tD
|S - P(t)|² = r²

→ t²|D|² - 2tD·(O-S) + |O-S|² - r² = 0
```

```glsl
bool intersectSphere(vec3 ro, vec3 rd, vec3 center, float radius, out float t) {
    vec3 oc = ro - center;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - radius * radius;
    float discriminant = b * b - c;
    
    if (discriminant < 0.0) return false;
    
    t = -b - sqrt(discriminant);
    if (t < 0.0) t = -b + sqrt(discriminant);
    return t >= 0.0;
}
```

### 2. 射线与平面相交

```glsl
bool intersectPlane(vec3 ro, vec3 rd, vec3 normal, float height, out float t) {
    float denom = dot(rd, normal);
    if (abs(denom) < 0.0001) return false;
    
    t = (height - dot(ro, normal)) / denom;
    return t >= 0.0;
}
```

---

## 小结

解析相交比 Ray Marching 更精确更快，适用于简单几何体。

---

## 延伸阅读

**前置知识**：矩阵变换（第 3 篇）

**下一篇**：第 12 篇「球追踪：Ray Marching 入门」

---

## 知识点清单（Checklist）

- [ ] 理解射线参数方程
- [ ] 掌握射线-球体相交的二次方程解法
- [ ] 掌握射线-平面相交的闭合解
