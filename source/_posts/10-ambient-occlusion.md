# 第10篇｜环境光遮蔽：缝隙里的光

## 摘要

**环境光遮蔽（Ambient Occlusion, AO）**是一种模拟光线在复杂表面缝隙中衰减的技术。本篇将讲解 **SDF-Based AO**、**Screen-Space AO (SSAO)** 和 **Horizon-Based AO (HBAO+)** 的算法原理与实现。AO 不产生阴影，但增强了场景的接触阴影和缝隙深度感。

---

## 核心原理

### 1. SDF-Based AO

利用 SDF 的距离值直接估算遮蔽程度：

```glsl
float calcAO(vec3 p, vec3 n) {
    float occ = 0.0;
    float scale = 1.0;
    
    for (int i = 0; i < 5; i++) {
        float h = 0.01 + 0.12 * float(i);
        float d = map(p + h * n).x;
        occ += (h - d) * scale;
        scale *= 0.95;
    }
    
    return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
}
```

**原理**：SDF 值越小，说明周围有越多表面接近该点，光线越容易被遮挡。

### 2. Screen-Space AO (SSAO)

在屏幕空间中基于深度缓冲区估算 AO：

```glsl
float ssao(vec3 p, vec3 n, float radius) {
    float occ = 0.0;
    const int samples = 16;
    
    for (int i = 0; i < samples; i++) {
        // 在法线方向的半球内采样
        vec3 sampleDir = hemisphereSample-uniform(vec3(random()), n);
        vec3 samplePos = p + sampleDir * radius;
        float depth = getDepth(samplePos);
        float rangeCheck = smoothstep(0.0, 1.0, radius / abs(p.z - depth));
        occ += (depth < samplePos.z ? 1.0 : 0.0) * rangeCheck;
    }
    
    return 1.0 - occ / float(samples);
}
```

---

## 实战案例：AO 增强 PBR

```glsl
void main() {
    vec3 p = hitPoint;
    vec3 n = calcNormal(p);
    
    // 计算 AO
    float ao = calcAO(p, n);
    
    // 环境光
    vec3 ambient = ao * vec3(0.05) * albedo;
    
    // 直接光照
    vec3 direct = pbrLighting(p, n, v, lightPos, lightColor, albedo, metallic, roughness);
    
    vec3 col = ambient + direct;
    fragColor = vec4(col, 1.0);
}
```

---

## 小结

AO 通过估算表面周围的几何密度来模拟光线在缝隙中的衰减，是增强场景真实感的重要技术。

---

## 延伸阅读

- CryEngine SSAO Paper: ["Screen-Space Ambient Occlusion"](https://www.crytek.com/download/Ssao_pdf)

**前置知识**：阴影技术（第 9 篇）

**下一篇**：第 11 篇「解析射线追踪」将讲解光线与基本几何体的精确相交计算。

---

## 知识点清单（Checklist）

- [ ] 理解 AO 的物理意义：缝隙中光线的衰减
- [ ] 掌握 SDF-Based AO 的原理和实现
- [ ] 理解 SSAO 的屏幕空间方法
- [ ] 知道 AO 与直接光照的组合方式
