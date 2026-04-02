# 第20篇｜流体模拟：Navier-Stokes 揭秘

## 摘要

**流体模拟（Fluid Simulation）**通过数值求解 Navier-Stokes 方程实现烟雾、水面等流体效果。本篇讲解 **平流**、**压力投影** 和 GPU 上的高效实现。

---

## 核心原理

### Navier-Stokes 方程

$$\frac{\partial \vec{u}}{\partial t} + (\vec{u} \cdot \nabla)\vec{u} = -\nabla p + \nu \nabla^2 \vec{u} + \vec{f}$$

三项分别代表：1. 平流（对流）、2. 压力、3. 扩散、外力。

### GPU 平流 (Advection)

```glsl
// 通过速度场平流密度
vec4 advect(sampler2D velocity, sampler2D density, vec2 texCoord, float dt) {
    vec2 vel = texture(velocity, texCoord).xy;
    vec2 prevCoord = texCoord - vel * dt;
    return texture(density, prevCoord);
}
```

### 压力投影

保证速度场无散度（$\nabla \cdot \vec{u} = 0$）：

```glsl
// Jacobi 迭代求解压力
for (int i = 0; i < 20; i++) {
    float pL = texture(pressure, coord - vec2(1,0)).x;
    float pR = texture(pressure, coord + vec2(1,0)).x;
    float pB = texture(pressure, coord - vec2(0,1)).x;
    float pT = texture(pressure, coord + vec2(0,1)).x;
    
    float divergence = 0.5 * ((pR - pL) + (pT - pB));
    pressure = (pL + pR + pB + pT - divergence) * 0.25;
}
```

---

## 小结

流体模拟通过平流和压力投影实现连续介质效果，多 pass 渲染是 GPU 实现的关键。

---

## 延伸阅读

- Jos Stam: ["Stable Fluids"](https://www.dgp.toronto.edu/projects/stam-stable-fluids/)

**前置知识**：多 Pass 缓冲

**下一篇**：第 21 篇「粒子系统」

---

## 知识点清单（Checklist）

- [ ] 理解 Navier-Stokes 方程三项的物理含义
- [ ] 掌握 GPU 平流的实现
- [ ] 理解压力投影的目的
