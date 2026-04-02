# 第9篇｜阴影技术：硬阴影到软阴影

## 摘要

**阴影（Shadows）**是增强场景深度感和真实感的关键技术。本篇将讲解从**硬阴影（Hard Shadows）**到**软阴影（Soft Shadows）**的技术演进，包括 **Ray Shadow**、**Penumbra Estimation**、**PCF (Percentage Closer Filtering)** 和 **PCSS (Percentage Closer Soft Shadows)** 的算法原理与实现。阴影技术直接决定了场景的空间层次感和光影质量。

---

## 核心原理

### 1. 硬阴影 (Hard Shadows)

光源被完全遮挡时产生清晰的阴影边界。

```glsl
float hardShadow(vec3 ro, vec3 rd, float mint, float maxt) {
    for (float t = mint; t < maxt;) {
        float h = map(ro + rd * t).x;
        if (h < 0.001) return 0.0;
        t += h;
    }
    return 1.0;
}
```

### 2. 软阴影 (Penumbra Estimation)

模拟真实世界中非理想光源产生的半影效果。

```glsl
float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
    float res = 1.0;
    float t = mint;
    for (int i = 0; i < 64; i++) {
        float h = map(ro + rd * t).x;
        res = min(res, k * h / t);
        t += clamp(h, 0.01, 0.2);
        if (res < 0.001 || t > maxt) break;
    }
    return clamp(res, 0.0, 1.0);
}
```

### 3. PCF (Percentage Closer Filtering)

对阴影距离场进行滤波，产生边缘柔和的效果。

```glsl
float PCFShadow(vec3 ro, vec3 rd, float bias, float radius, float samples) {
    float shadow = 0.0;
    for (float i = 0.0; i < samples; i++) {
        for (float j = 0.0; j < samples; j++) {
            vec2 offset = (vec2(i, j) - samples * 0.5) * radius;
            float dist = shadowMap(ro + vec3(offset.x, 0.0, offset.y), rd);
            shadow += (dist > bias) ? 1.0 : 0.0;
        }
    }
    return shadow / (samples * samples);
}
```

---

## 实战案例：完整阴影着色器

```glsl
void main() {
    vec3 p = hitPoint;
    vec3 n = calcNormal(p);
    
    vec3 lightPos = vec3(5.0, 8.0, 3.0);
    vec3 l = normalize(lightPos - p);
    
    // 计算阴影
    float shadow = softShadow(p + n * 0.01, l, 0.02, 20.0, 16.0);
    
    // PBR 光照
    vec3 col = PBR(p, n, v, lightPos, lightColor, albedo, metallic, roughness);
    col *= shadow;
    
    fragColor = vec4(col, 1.0);
}
```

---

## 小结

阴影技术从硬阴影到软阴影，核心是模拟光线被遮挡的程度。Penumbra Estimation 是 SDF 场景中最常用的软阴影方法。

---

## 延伸阅读

- Inigo Quilez - ["Soft Shadows"](https://iquilezles.org/articles/rmshadows/)

**前置知识**：光照模型（第 8 篇）

**下一篇**：第 10 篇「环境光遮蔽」将讲解 AO 技术。

---

## 知识点清单（Checklist）

- [ ] 理解硬阴影与软阴影的区别
- [ ] 掌握 Penumbra Estimation 的实现
- [ ] 理解 PCF 的滤波思想
- [ ] 知道 k 值对阴影柔和度的影响
