# 第17篇｜路径追踪与全局光照

## 摘要

**路径追踪（Path Tracing）**通过蒙特卡洛方法模拟光线的随机传播，实现真实的光照效果，包括**全局光照（GI）**、**焦散**、**间接光照**等。

---

## 核心原理

### 蒙特卡洛积分

光照在表面某点的反射能量：

$$L_o = \int_{\Omega} f_r(\omega_i, \omega_o) L_i(\omega_i) \cos\theta_i d\omega_i$$

用随机采样近似：

$$L_o \approx \frac{1}{N} \sum_{i=1}^{N} \frac{f_r \cdot L_i \cdot \cos\theta}{p(\omega_i)}$$

### Russian Roulette 终止

```glsl
float surviveProbability = 0.8;
if (random() > surviveProbability) return vec3(0.0);  // 光线终止
float weight = 1.0 / surviveProbability;
```

---

## 实战案例：简单路径追踪器

```glsl
vec3 pathtrace(vec3 ro, vec3 rd, int depth) {
    if (depth > 4) return vec3(0.0);  // 递归终止
    
    vec2 hit = rayMarch(ro, rd);
    if (hit.x < 0.0) return skyColor;
    
    vec3 p = ro + rd * hit.x;
    vec3 n = calcNormal(p);
    
    // 随机采样光线方向
    vec3 newDir = sampleHemisphere(n, random2());
    float NdotL = max(dot(n, newDir), 0.0);
    
    // 递归追踪
    vec3 incoming = pathtrace(p + n * 0.01, newDir, depth + 1);
    vec3 BRDF = albedo / 3.14159;
    
    return BRDF * incoming * NdotL;
}
```

---

## 小结

路径追踪是实现全局光照的数学基础，通过随机采样和递归追踪模拟真实光传播。

---

## 延伸阅读

- PBRT Book: ["Physically Based Rendering"](https://pbr-book.org/)

**前置知识**：光照模型（第 8 篇）

**下一篇**：第 18 篇「体积渲染」

---

## 知识点清单（Checklist）

- [ ] 理解蒙特卡洛积分在光照中的应用
- [ ] 掌握 Russian Roulette 终止技术
- [ ] 理解 BRDF 采样的重要性
