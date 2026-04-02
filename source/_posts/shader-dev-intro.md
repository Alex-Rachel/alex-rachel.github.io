---
title: Shader Craft - 我的 GLSL Shader 学习笔记
date: 2026-04-02 16:30:00
tags: [Unity, Shader, GLSL, 学习笔记]
---

# Shader Craft - 我的 GLSL Shader 学习笔记 🎨

最近在整理一个 GLSL Shader 的学习技能库，涵盖了 36 种核心技术。这些内容主要面向 **Unity HDRP/URP** 环境，虽然示例代码是 GLSL 风格，但核心概念和数学原理是相通的，稍作适配即可在 Unity 中使用。

## 仓库地址

🔗 [Alex-Rachel/skills - shader-dev](https://github.com/Alex-Rachel/skills/tree/main/skills/shader-dev)

## 为什么学 GLSL Shader

学习 GLSL Shader 对于 Unity Shader 开发非常有帮助：

1. **概念相通** - Unity 的 ShaderLab 背后的 HLSL/CG 语法与 GLSL 非常相似
2. **实时预览** - ShaderToy 可以快速验证想法，调试方便
3. **资料丰富** - GLSL 社区有大量优秀的 shader 案例可以学习
4. **数学基础** - 射线追踪、SDF、光照模型等核心概念在任何 Shader 环境都适用

## 技术分类笔记

### 🏗️ 几何与距离函数 (SDF)

**SDF (Signed Distance Functions)** 是非常重要的概念：

- **sdf-2d** - 2D 距离函数，理解圆形、矩形等基本形状的数学定义
- **sdf-3d** - 3D 距离函数，是 Ray Marching 的基础
- **csg-boolean-operations** - 用数学方式实现模型的并集、差集、交集
- **domain-repetition** - 无限重复，用于创建规律的物体排列
- **domain-warping** - 用噪声扭曲形状，创建有机的效果

> 💡 **Unity 应用**：在 Unity 中可以用 SDF 做体积渲染、海龟汤（Turtle）图形等

### 🔦 光线追踪与光照

**Ray Marching** 是用数学方式"画"出 3D 场景的核心算法：

- **ray-marching** - 球追踪，理解光线如何在场景中前进
- **analytic-ray-tracing** - 解析方式计算光线与几何体的精确相交
- **lighting-model** - 必学！Phong、Blinn-Phong、PBR (Cook-Torrance) 光照模型
- **shadow-techniques** - 硬阴影、软阴影（半影）的实现
- **ambient-occlusion** - 环境光遮蔽，让物体接触处更自然

> 💡 **Unity 应用**：在 Unity Shader 中实现自定义光照、PBR 材质、地形阴影等

### 🌊 模拟与物理

- **fluid-simulation** - Navier-Stokes 流体模拟的核心原理
- **simulation-physics** - GPU 并行计算在物理模拟中的应用
- **particle-system** - 粒子系统的数学模型（火、雨、爆炸效果）
- **cellular-automata** - 细胞自动机，生命游戏、反应扩散系统

> 💡 **Unity 应用**：自定义粒子系统、特效 Shader、GPU Instancing

### 🌍 自然现象

- **water-ocean** - Gerstner 波、FFT 海洋模拟
- **terrain-rendering** - FBM 地形生成，理解噪声在程序化地形中的应用
- **atmospheric-scattering** - Rayleigh/Mie 散射，天空颜色、大气效果
- **volumetric-rendering** - 体积渲染，云、雾、火焰

> 💡 **Unity 应用**：实现水体 Shader、程序化地形、天空盒

### 🎲 程序化生成

**程序化生成**是创建无限内容的关键：

- **procedural-noise** - Value Noise、Perlin、Simplex、Worley、FBM，图形学最核心的数学工具
- **procedural-2d-pattern** - 砖块、六边形、伊斯兰花纹等规律图案
- **voronoi-cellular-noise** - Voronoi 图，用于裂纹、细胞、宝石等效果
- **fractal-rendering** - 分形，Mandelbrot、Julia、Mandelbulb

> 💡 **Unity 应用**：程序化纹理、地形侵蚀效果、装饰性图案

### ✨ 后处理与效果

- **post-processing** - Bloom、泛光、色调映射、色差等后处理效果
- **color-palette** - 调色技巧，余弦调色板、HSL 色彩空间
- **anti-aliasing** - 抗锯齿，SSAA、FXAA、TAA 等方法

## 学习路径建议

### 入门路线

1. **第一步**：理解 SDF 和 2D 形状 - sdf-2d
2. **第二步**：学习 Ray Marching - ray-marching + sdf-3d
3. **第三步**：掌握光照模型 - lighting-model + shadow-techniques
4. **第四步**：学习噪声 - procedural-noise（这是最核心的）
5. **第五步**：进阶主题 - fluid-simulation、terrain-rendering 等

### Unity 适配要点

GLSL 代码迁移到 Unity 时主要注意：

| GLSL | Unity (HLSL) |
|------|-------------|
| `varying` | `in` / `out` |
| `texture2D()` | `tex2D()` |
| `gl_FragCoord.xy` | `i.uv` 或屏幕坐标 |
| `#version 300 es` | 不需要，Unity 自动处理 |

Unity 中使用 CG/HLSL 编写，语法与 GLSL 相似度很高。

## 典型案例解析

### 照片级 3D 场景

```
几何建模(sdf-3d) + 射线追踪(ray-marching) 
→ 法线计算(normal-estimation) 
→ 光照(lighting-model) + 阴影(shadow-techniques) 
→ 环境光遮蔽(ambient-occlusion) 
→ 大气效果(atmospheric-scattering)
```

### 程序化地形

```
FBM噪声(terrain-rendering) 
→ 地形纹理(texture-mapping-advanced) 
→ 天空大气(atmospheric-scattering) 
→ 水面效果(water-ocean)
```

## 性能注意事项

在实际项目中需要注意性能：

- Ray Marching 主循环：≤ 128 步
- FBM 噪声：≤ 6 层（过多的层数影响性能）
- 体积采样：≤ 32 步

## 调试技巧

| 调试内容 | 方法 |
|---------|------|
| 法线是否正确 | `col = normal * 0.5 + 0.5` 看平滑程度 |
| 步进次数 | 用颜色显示，越红说明步进越多 |
| SDF 距离场 | 用条纹显示，观察是否均匀 |

## 资源推荐

- [ShaderToy](https://www.shadertoy.com) - 最好的 shader 学习平台
- [Inigo Quilez's Blog](https://iquilezles.org) - SDF 之父，文章极具价值
- [The Book of Shaders](https://thebookofshaders.com) - 程序化图形入门经典

## 总结

学习 GLSL Shader 是一个非常有趣的过程，核心在于：

1. **理解数学** - 向量、矩阵、噪声等数学工具
2. **多看多练** - ShaderToy 是最好的练习场
3. **循序渐进** - 从简单的 2D 形状开始，逐步深入

希望这个技能库能帮助到同样想学习 Shader 的朋友们！

---

*仓库地址: https://github.com/Alex-Rachel/skills*
