# 第18篇｜体积渲染：云与雾的奥秘

## 摘要

**体积渲染（Volumetric Rendering）**通过在体积内部采样密度场来渲染云、雾、火焰等半透明介质。本篇讲解 **Beer-Lambert** 定律和体积光线步进。

---

## 核心原理

### Beer-Lambert 定律

光穿过介质时的衰减：

$$T = e^{-\int_0^d \sigma_t(s) ds}$$

其中 $\sigma_t$ 是消光系数。

### 体积光线步进

```glsl
vec4 volumeMarch(vec3 ro, vec3 rd, float maxDist) {
    vec3 col = vec3(0.0);
    float transmittance = 1.0;
    float stepSize = maxDist / 64.0;
    
    for (int i = 0; i < 64; i++) {
        float t = float(i) * stepSize;
        vec3 p = ro + rd * t;
        
        float density = densityField(p);
        float sigma_t = density * 0.1;
        
        // 吸收和散射
        vec3 scattering = sigma_t * vec3(1.0) * transmittance;
        col += scattering;
        transmittance *= exp(-sigma_t * stepSize);
        
        if (transmittance < 0.01) break;
    }
    
    return vec4(col, 1.0 - transmittance);
}
```

---

## 实战案例：程序化云

```glsl
float cloudDensity(vec3 p) {
    float base = fbm(p * 0.1);
    float detail = fbm(p * 0.3) * 0.5;
    float heightFade = 1.0 - smoothstep(0.0, 2.0, p.y);
    return max(0.0, base + detail - 0.5) * heightFade;
}
```

---

## 小结

体积渲染通过在介质内部步进采样密度场来模拟半透明效果，Beer-Lambert 定律描述光的衰减。

---

## 延伸阅读

**前置知识**：Ray Marching（第 12 篇）、程序化噪声（第 2 篇）

**下一篇**：第 19 篇「大气散射」

---

## 知识点清单（Checklist）

- [ ] 理解 Beer-Lambert 定律
- [ ] 掌握体积光线步进的基本流程
- [ ] 理解 transmittance 的物理含义
