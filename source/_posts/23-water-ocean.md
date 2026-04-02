# 第23篇｜海洋与水体：Gerstner 波与 FFT

## 摘要

**海洋渲染（Ocean Rendering）**结合 **Gerstner 波**和 **FFT** 创建真实的海面效果。本篇讲解波函数、波浪叠加和水面着色。

---

## 核心原理

### Gerstner 波

$$\vec{P}(x, z, t) = \begin{pmatrix} 
\frac{W_x}{k} \sin(k \cdot \vec{D} \cdot \vec{P}_0 - \omega t) \\
A \sin(k \cdot \vec{D} \cdot \vec{P}_0 - \omega t) \\
\frac{W_z}{k} \sin(k \cdot \vec{D} \cdot \vec{P}_0 - \omega t)
\end{pmatrix}$$

其中 $k = |\vec{W}|$ 是波数，$\omega = \sqrt{gk}$ 是角频率。

```glsl
vec3 gerstnerWave(vec3 pos, vec2 dir, float steepness, float wavelength) {
    float k = 2.0 * 3.14159 / wavelength;
    float c = sqrt(9.8 / k);
    vec2 d = normalize(dir);
    float f = k * (dot(d, pos.xz) - c * iTime);
    float a = steepness / k;
    
    return vec3(
        d.x * a * cos(f),
        a * sin(f),
        d.y * a * cos(f)
    );
}
```

### FFT 海洋

```glsl
// 简化 FFT 高度场
float fftOcean(vec2 pos, float time) {
    float height = 0.0;
    for (int i = 0; i < 64; i++) {
        vec2 k = hash2(vec2(i)) * 2.0 - 1.0;
        float phase = dot(k, pos) + time;
        height += sin(phase) / float(i + 1);
    }
    return height;
}
```

---

## 小结

海洋渲染结合 Gerstner 波的物理准确性和 FFT 的细节叠加。

---

## 延伸阅读

**前置知识**：程序化噪声（第 2 篇）、光照模型（第 8 篇）

**下一篇**：第 24 篇「地形渲染」

---

## 知识点清单（Checklist）

- [ ] 理解 Gerstner 波的数学形式
- [ ] 掌握波浪叠加产生复杂海面
- [ ] 理解 FFT 海洋的优缺点
