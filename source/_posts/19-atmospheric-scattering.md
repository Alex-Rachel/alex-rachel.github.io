# 第19篇｜大气散射：从日出到黄昏

## 摘要

**大气散射（Atmospheric Scattering）**模拟光线穿过大气时的散射效果，产生天空色彩、日落、蓝天等自然现象。

---

## 核心原理

### Rayleigh vs Mie 散射

- **Rayleigh 散射**：短波长（蓝光）散射强 → 蓝天
- **Mie 散射**：所有波长类似散射 → 白色云雾

### 散射方程

$$L(\lambda) = L_{sun} \cdot P(\theta, \lambda) \cdot \int_0^\infty e^{-\frac{h}{H}} dh$$

```glsl
vec3 atmosphericScattering(vec3 rayDir, vec3 sunDir) {
    float mu = dot(rayDir, sunDir);
    
    // Rayleigh 散射
    float rayleigh = 1.0 + mu * mu;
    
    // Mie 散射
    float g = 0.76;
    float mie = pow(1.0 + g * g - 2.0 * g * mu, -1.5);
    
    // 组合
    vec3 rayleighColor = vec3(0.05, 0.15, 0.4) * rayleigh;
    vec3 mieColor = vec3(0.8) * mie;
    
    return rayleighColor + mieColor;
}
```

---

## 小结

大气散射是实现天空色彩的核心技术，Rayleigh 和 Mie 散射分别产生蓝天和云朵效果。

---

## 延伸阅读

- Sean O'Neil: ["Accurate Atmospheric Scattering"](https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-16-accurate-atmospheric-scattering)

**前置知识**：体积渲染（第 18 篇）

**下一篇**：第 20 篇「流体模拟」

---

## 知识点清单（Checklist）

- [ ] 理解 Rayleigh 和 Mie 散射的区别
- [ ] 掌握大气散射的基本公式
- [ ] 理解天空蓝色的物理原因
