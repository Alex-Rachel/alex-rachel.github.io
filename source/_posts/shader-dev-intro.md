---
title: Shader Craft - 我的 GLSL Shader 开发技能库
date: 2026-04-02 16:30:00
tags: [GLSL, Shader, Graphics, 技术]
---

# Shader Craft - 我的 GLSL Shader 开发技能库 🎨

最近整理了一个比较完整的 GLSL Shader 技能库 **Shader Craft**，涵盖了 36 种 shader 核心技术，支持 ShaderToy 风格编写，可直接适配 WebGL2。

## 仓库地址

🔗 [Alex-Rachel/skills - shader-dev](https://github.com/Alex-Rachel/skills/tree/main/skills/shader-dev)

## 整体架构

```
shader-dev/
├── SKILL.md                      # 核心技能文件
├── techniques/                   # 36 个技术实现指南
│   ├── ray-marching.md           # 球追踪与 SDF
│   ├── sdf-3d.md                 # 3D 距离函数
│   ├── lighting-model.md         # PBR、Phong、卡通着色
│   ├── procedural-noise.md       # Perlin、Simplex、FBM
│   ├── fluid-simulation.md       # 流体模拟
│   └── ...                       # 共 36 个技术文件
└── reference/                    # 深入参考文档
    ├── ray-marching.md           # 数学推导与高级模式
    ├── sdf-3d.md                 # 扩展 SDF 理论
    └── ...                       # 34 个参考文件
```

## 技术分类一览

### 🏗️ 几何与 SDF
| 技术 | 描述 |
|------|------|
| **sdf-2d** | 2D 距离函数，用于形状、UI、抗锯齿渲染 |
| **sdf-3d** | 3D 距离函数，实时隐式曲面建模 |
| **csg-boolean-operations** | 构造实体几何：并集、差集、交集、平滑混合 |
| **domain-repetition** | 无限空间重复、折叠、有限平铺 |
| **domain-warping** | 用噪声扭曲域，产生有机流动形状 |
| **sdf-tricks** | SDF 优化、包围盒、二分搜索精化 |

### 🔦 光线投射与光照
| 技术 | 描述 |
|------|------|
| **ray-marching** | 球追踪，用 SDF 渲染 3D 场景 |
| **analytic-ray-tracing** | 解析射线与几何体的精确相交计算 |
| **path-tracing-gi** | 蒙特卡洛路径追踪，实现真实全局光照 |
| **lighting-model** | Phong、Blinn-Phong、PBR (Cook-Torrance)、卡通着色 |
| **shadow-techniques** | 硬阴影、软阴影（半影估计） |
| **ambient-occlusion** | 基于 SDF 的环境光遮蔽 |
| **normal-estimation** | 有限差分法、四面体法计算法线 |

### 🌊 模拟与物理
| 技术 | 描述 |
|------|------|
| **fluid-simulation** | Navier-Stokes 流体求解器，包含平流、扩散、压力投影 |
| **simulation-physics** | GPU 物理模拟：弹簧、布料、N-body 引力、碰撞 |
| **particle-system** | 无状态/有状态粒子系统（火、雨、火花、星系） |
| **cellular-automata** | 生命游戏、反应扩散（图灵斑图）、沙粒模拟 |

### 🌍 自然现象
| 技术 | 描述 |
|------|------|
| **water-ocean** | Gerstner 波、FFT 海洋、焦散、水下雾效 |
| **terrain-rendering** | 高度场射线追踪、FBM 地形的侵蚀效果 |
| **atmospheric-scattering** | Rayleigh/Mie 散射、上帝之光、SSS 近似 |
| **volumetric-rendering** | 体积射线追踪，用于云、雾、火、爆炸 |

### 🎲 程序化生成
| 技术 | 描述 |
|------|------|
| **procedural-noise** | Value Noise、Perlin、Simplex、Worley、FBM、山脊噪声 |
| **procedural-2d-pattern** | 砖块、六边形、Truchets、伊斯兰几何图案 |
| **voronoi-cellular-noise** | Voronoi 图、Worley 噪声、裂纹、晶体 |
| **fractal-rendering** | Mandelbrot、Julia 集、3D 分形（Mandelbox、Mandelbulb） |
| **color-palette** | 余弦调色板、HSL/HSV/Oklab、动态色彩映射 |

### ✨ 后处理与基础设施
| 技术 | 描述 |
|------|------|
| **post-processing** | Bloom、色调映射（ACES、Reinhard）、暗角、色差、故障效果 |
| **multipass-buffer** | Ping-pong FBO 设置，跨帧状态持久化 |
| **texture-sampling** | 双线性、双三次、Mipmap、程序化纹理查询 |
| **matrix-transform** | 相机 LookAt、投影、旋转、轨道控制器 |
| **polar-uv-manipulation** | 极坐标/对数极坐标、万花筒、螺旋映射 |
| **anti-aliasing** | SSAA、SDF 解析 AA、时间性 AA (TAA)、FXAA |
| **camera-effects** | 景深（薄透镜）、运动模糊、镜头畸变、胶片颗粒 |

### 🔊 音频
| 技术 | 描述 |
|------|------|
| **sound-synthesis** | GLSL 程序化音频：振荡器、包络、滤波器、FM 合成 |

## 典型组合配方

### 照片级 SDF 场景
1. **几何**: sdf-3d + csg-boolean-operations
2. **渲染**: ray-marching + normal-estimation
3. **光照**: lighting-model + shadow-techniques + ambient-occlusion
4. **大气**: atmospheric-scattering
5. **后处理**: post-processing + anti-aliasing + camera-effects

### 程序化地形
1. **地形**: terrain-rendering + procedural-noise
2. **纹理**: texture-mapping-advanced
3. **天空**: atmospheric-scattering
4. **水面**: water-ocean + lighting-model

### 有机/生物形态
1. **几何**: sdf-3d + csg-boolean + domain-warping
2. **细节**: procedural-noise (FBM with derivatives)
3. **表面**: lighting-model (SSS approximation)

## WebGL2 适配要点

从 ShaderToy 迁移到独立 WebGL2 页面需要注意：

```glsl
// Shader 版本与输出
#version 300 es
precision highp float;
out vec4 fragColor;

// 片段坐标 - 使用 gl_FragCoord.xy
vec2 uv = (2.0 * gl_FragCoord.xy - iResolution.xy) / iResolution.y;

// main() 包装器
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // shader code...
}
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
}
```

## 性能预算

在树莓派等低性能设备上需要控制复杂度：

- Ray marching 主循环：≤ 128 步
- 体积采样/光照内循环：≤ 32 步
- FBM 倍频数：≤ 6 层
- 每像素嵌套循环总迭代：≤ 1000

## 常见调试技巧

| 检查内容 | 代码 | 观察要点 |
|----------|------|----------|
| 表面法线 | `col = nor * 0.5 + 0.5;` | 平滑渐变 = 正确，带状 = epsilon 太大 |
| 步进次数 | `col = vec3(float(steps) / float(MAX_STEPS));` | 红点热点 = 性能瓶颈 |
| SDF 距离场 | `col = (d > 0.0 ? vec3(0.9,0.6,0.3) : vec3(0.4,0.7,0.85)) * (0.8 + 0.2*cos(150.0*d));` | 可视化 SDF 带和零交叉 |
| 材质 ID | `col = palette(matId / maxMatId);` | 验证材质分配 |

## 路由表（按需查找）

| 想创建... | 主要技术 | 配合使用 |
|----------|---------|---------|
| 3D 物体/场景 | ray-marching + sdf-3d | lighting-model, shadow-techniques |
| 复杂 3D 形状 | csg-boolean-operations | sdf-3d, ray-marching |
| 无限重复图案 | domain-repetition | sdf-3d, ray-marching |
| 有机/扭曲形状 | domain-warping | procedural-noise |
| 流体/烟雾/墨迹 | fluid-simulation | multipass-buffer |
| 粒子效果 | particle-system | procedural-noise, color-palette |
| 物理模拟 | simulation-physics | multipass-buffer |
| 海洋/水面 | water-ocean | atmospheric-scattering, lighting-model |
| 地形/景观 | terrain-rendering | atmospheric-scattering, procedural-noise |
| 云/雾/体积火 | volumetric-rendering | procedural-noise, atmospheric-scattering |
| 天空/日落 | atmospheric-scattering | volumetric-rendering |
| Voronoi 图案 | voronoi-cellular-noise | color-palette |
| 分形 | fractal-rendering | color-palette, polar-uv-manipulation |

## 后续计划

- 继续补充更多shader案例
- 添加更多WebGL2适配的最佳实践
- 完善调试工具链

---

*项目地址: https://github.com/Alex-Rachel/skills*
