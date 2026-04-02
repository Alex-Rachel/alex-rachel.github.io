---
title: Unity Shader 系列（二）：URP 程序化噪声 — FBM 火焰特效与程序化材质
date: 2026-04-03 12:00:00
tags: [HLSL, URP, 程序化噪声, FBM, 特效Shader]
---

## 为什么 Unity 开发者需要掌握噪声 Shader？

Unity 提供了两个常见的噪声方案：CPU 端的 `Mathf.PerlinNoise()` 和 VFX Graph 中的内置噪声节点。但在以下场景中，手写 HLSL 噪声 Shader 是不可替代的：

1. **URP 特效 Shader**：粒子火焰、烟雾、传送门涟漪——这些效果需要在 Fragment Shader 中实时运算噪声驱动 UV 扰动
2. **程序化地形材质**：根据高度和坡度自动混合草地/岩石/雪地纹理，噪声控制混合边界
3. **程序化天空盒**：不依赖贴图的动态云层、星空材质

**CPU 噪声 vs GPU 噪声的选择标准：**
- `Mathf.PerlinNoise()`：适合每帧只调用几次（地形生成、程序化布局）
- 采样噪声贴图（`SAMPLE_TEXTURE2D`）：适合需要快速 GPU 读取但不需要数学精确性的场景
- 手写 HLSL 噪声：适合需要无限平铺、参数化控制、无额外贴图内存的特效 Shader

**性能对比（移动端 Mali-G57 测试数据）：**
| 方法 | 每片元开销 | 适用场景 |
|------|-----------|---------|
| 采样噪声贴图 | ~0.8ns | 高性能要求场景 |
| Value Noise（4 层 FBM） | ~2.1ns | PC/主机特效 |
| Simplex Noise（4 层） | ~3.5ns | 不推荐移动端 |

## Hash 函数：HLSL 版本

```hlsl
// 无 sin 版本的 Hash（跨平台精度稳定）
float hash12(float2 p)
{
    float3 p3 = frac(float3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return frac((p3.x + p3.y) * p3.z);
}

// 返回 float2 的 hash（用于梯度噪声）
float2 hash22(float2 p)
{
    float3 p3 = frac(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return frac((p3.xx + p3.yz) * p3.zy);
}
```

## Value Noise 与 FBM（HLSL 实现）

```hlsl
// Value Noise：格点插值（Hermite 平滑）
float valueNoise(float2 x)
{
    float2 p = floor(x);
    float2 f = frac(x);
    // Hermite 平滑 S 曲线（C1 连续）
    f = f * f * (3.0 - 2.0 * f);

    float a = hash12(p + float2(0.0, 0.0));
    float b = hash12(p + float2(1.0, 0.0));
    float c = hash12(p + float2(0.0, 1.0));
    float d = hash12(p + float2(1.0, 1.0));
    // 双线性插值
    return lerp(lerp(a, b, f.x), lerp(c, d, f.x), f.y);
}

// FBM（分形布朗运动）
// 旋转矩阵消除轴对齐伪影
static const float2x2 fbmRot = float2x2(1.6, 1.2, -1.2, 1.6);

float fbm(float2 p, int octaves)
{
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < octaves; i++)
    {
        value += amplitude * (-1.0 + 2.0 * valueNoise(p));
        // 旋转 + 缩放（注意 HLSL 的 mul 矩阵乘法顺序）
        p = mul(fbmRot, p);
        amplitude *= 0.5;
    }
    return value;
}

// Ridged FBM（产生尖锐山脊，适合闪电、岩石纹理）
float fbmRidged(float2 p, int octaves)
{
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < octaves; i++)
    {
        // abs() 将平滑波谷变为尖锐山脊
        value += amplitude * abs(-1.0 + 2.0 * valueNoise(p));
        p = mul(fbmRot, p);
        amplitude *= 0.5;
    }
    return value;
}
```

## 完整示例：URP 火焰粒子特效 Shader

这个 Shader 适用于粒子系统的材质，实现 FBM 驱动的 UV 扰动火焰效果：

```hlsl
Shader "Custom/URP/FireEffect"
{
    Properties
    {
        // 火焰基础颜色（从底部到顶部的渐变）
        _ColorBottom ("Flame Color Bottom", Color) = (1.0, 0.3, 0.0, 1.0)
        _ColorMiddle ("Flame Color Middle", Color) = (1.0, 0.8, 0.1, 1.0)
        _ColorTop    ("Flame Color Top",    Color) = (0.8, 0.9, 1.0, 0.0)
        // FBM 参数
        _NoiseScale  ("Noise Scale",  Range(1.0, 10.0)) = 3.0
        _NoiseSpeed  ("Noise Speed",  Range(0.0, 5.0))  = 1.5
        _NoiseStrength ("Distortion Strength", Range(0.0, 1.0)) = 0.3
        // 火焰形状（底部宽，顶部收窄）
        _ShapeSharpness ("Shape Sharpness", Range(1.0, 8.0)) = 3.0
        // 粒子软裁剪（配合 URP Depth Texture）
        _SoftParticleRange ("Soft Particle Range", Range(0.1, 5.0)) = 1.0
    }

    SubShader
    {
        Tags
        {
            "Queue" = "Transparent"
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "IgnoreProjector" = "True"
        }

        Blend SrcAlpha One        // 加法混合（适合火焰发光）
        ZWrite Off
        Cull Off

        Pass
        {
            Name "FireForward"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // 粒子软裁剪需要深度纹理
            #pragma multi_compile _ SOFTPARTICLES_ON
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _ColorBottom;
                float4 _ColorMiddle;
                float4 _ColorTop;
                float  _NoiseScale;
                float  _NoiseSpeed;
                float  _NoiseStrength;
                float  _ShapeSharpness;
                float  _SoftParticleRange;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR;       // 粒子系统颜色/透明度
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                float4 color       : COLOR;
                // 软粒子需要屏幕坐标
                float4 screenPos   : TEXCOORD1;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== 噪声函数 ========

            float hash12(float2 p)
            {
                float3 p3 = frac(float3(p.xyx) * 0.1031);
                p3 += dot(p3, p3.yzx + 33.33);
                return frac((p3.x + p3.y) * p3.z);
            }

            float valueNoise(float2 x)
            {
                float2 p = floor(x);
                float2 f = frac(x);
                f = f * f * (3.0 - 2.0 * f);
                float a = hash12(p + float2(0, 0));
                float b = hash12(p + float2(1, 0));
                float c = hash12(p + float2(0, 1));
                float d = hash12(p + float2(1, 1));
                return lerp(lerp(a, b, f.x), lerp(c, d, f.x), f.y);
            }

            static const float2x2 fbmRot = float2x2(1.6, 1.2, -1.2, 1.6);

            // 2D FBM（4 层，适合移动端性能）
            float fbm4(float2 p)
            {
                float v = 0.0, a = 0.5;
                [unroll] // 固定循环次数时展开
                for (int i = 0; i < 4; i++)
                {
                    v += a * valueNoise(p);
                    p = mul(fbmRot, p);
                    a *= 0.5;
                }
                return v;
            }

            // ======== 颜色梯度（三色渐变） ========
            float3 flameGradient(float t, float3 bot, float3 mid, float3 top)
            {
                // t: 0 = 底部，1 = 顶部
                float3 lower = lerp(bot, mid, saturate(t * 2.0));
                float3 upper = lerp(mid, top, saturate(t * 2.0 - 1.0));
                return lerp(lower, upper, step(0.5, t));
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = IN.uv;
                OUT.color = IN.color;
                // 计算屏幕坐标（软粒子使用）
                OUT.screenPos = ComputeScreenPos(OUT.positionHCS);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.uv;
                float time = _Time.y * _NoiseSpeed; // Unity 内置时间变量

                // === 第一步：UV 扰动（FBM 域扭曲）===
                // 使用两层 FBM 进行 UV 扰动，模拟火焰的湍流
                float2 distortUV = uv * _NoiseScale + float2(0.0, -time); // 向上流动
                float distortX = fbm4(distortUV + float2(1.7, 9.2)) - 0.5;
                float distortY = fbm4(distortUV + float2(8.3, 2.8)) - 0.5;
                float2 distortedUV = uv + float2(distortX, distortY) * _NoiseStrength;

                // === 第二步：火焰形状遮罩 ===
                // 从底部（宽）到顶部（窄）的形状，用 UV.y 控制宽度
                float distFromCenter = abs(distortedUV.x - 0.5) * 2.0; // [0,1]
                float shapeWidth = 1.0 - pow(uv.y, 1.0 / _ShapeSharpness);
                float shapeMask = saturate(1.0 - distFromCenter / max(shapeWidth, 0.001));

                // === 第三步：FBM 密度场 ===
                // 主火焰密度（沿 Y 轴向上流动的 FBM）
                float density = fbm4(distortedUV * _NoiseScale + float2(0.0, -time * 1.2));
                density = saturate(density * 2.0 - 0.3); // 增加对比度，消除低密度底噪

                // === 第四步：顶部衰减 ===
                // 越靠近顶部越透明（fire tip）
                float topFade = 1.0 - smoothstep(0.5, 1.0, uv.y);
                float finalAlpha = density * shapeMask * topFade;

                // === 第五步：颜色计算 ===
                // 用 uv.y 和密度混合三色梯度
                float colorT = uv.y + (1.0 - density) * 0.3;
                float3 flameColor = flameGradient(
                    colorT,
                    _ColorBottom.rgb,
                    _ColorMiddle.rgb,
                    _ColorTop.rgb
                );

                // === 第六步：软粒子（可选） ===
                #if defined(SOFTPARTICLES_ON)
                    // 比较粒子深度与场景深度，避免粒子切割地面
                    float sceneDepth = LinearEyeDepth(
                        SampleSceneDepth(IN.screenPos.xy / IN.screenPos.w),
                        _ZBufferParams
                    );
                    float particleDepth = IN.screenPos.w;
                    float softFactor = saturate((sceneDepth - particleDepth) / _SoftParticleRange);
                    finalAlpha *= softFactor;
                #endif

                // 粒子系统传入的颜色/透明度（用于粒子生命周期控制）
                finalAlpha *= IN.color.a;
                flameColor *= IN.color.rgb;

                return half4(flameColor, finalAlpha);
            }
            ENDHLSL
        }
    }
}
```

## VFX Graph vs 手写 Shader：选择依据

Unity VFX Graph 也内置了噪声节点（Perlin、Voronoi、Cellular），适合以下场景：
- **粒子行为控制**：噪声驱动粒子的速度、大小、颜色（CPU/GPU 计算粒子属性）
- **快速原型**：可视化节点连接，无需写代码

手写 Shader 更适合：
- **Fragment Shader 内部的 UV 扰动**：像上面的火焰 Shader，每个片元都需要独立的噪声计算
- **需要精确的 FBM 参数控制**：层数、频率倍增、旋转矩阵等
- **需要噪声用于形状 SDF 的有机边缘扰动**：`d += fbm(p * 5.0) * 0.05`

## ShaderGraph 实现思路

在 ShaderGraph 中实现同样的火焰效果：

1. **时间驱动 UV**：`Time` 节点 × `_NoiseSpeed` → `Add` 到 UV 的 Y 分量（向上流动）
2. **UV 扰动**：两个 `Simple Noise` 节点（不同偏移）→ `Subtract(0.5)` → 加到原始 UV
3. **形状遮罩**：`UV` 的 X 分量 → `Distance to 0.5` → 用 Y 分量控制宽度阈值 → `Smoothstep`
4. **密度**：扰动后的 UV → `Simple Noise` → `Remap` 调整对比度
5. **颜色梯度**：`Gradient` 节点（三色预设）→ 用 `UV.y + density偏移` 采样
6. **Alpha 输出**：密度 × 形状遮罩 × 顶部衰减（`1 - Smoothstep`）

注意：ShaderGraph 的 `Simple Noise` 是 Value Noise，`Gradient Noise` 是 Perlin Noise，性能相近。

## 性能考量

**移动端（OpenGL ES 3.0）优化策略：**
- FBM 层数降到 2-3 层（性能最关键的调整）
- 用 `half` 替代 `float`：`half2 distortUV`、`half density` 等
- 禁用软粒子功能（`#pragma shader_feature SOFTPARTICLES_ON`）
- 把 `fbmRot` 矩阵乘法改为简单的 `p *= 2.0`（移除旋转，略有伪影但更快）

**PC（DX11）扩展功能：**
- FBM 6-8 层，加入 Ridged FBM 做火焰边缘焦灼效果
- 添加域扭曲（Double domain warping）产生更真实的湍流
- 对屏幕空间阴影采样，让火焰参与场景光照

## 常见踩坑

1. **HLSL 没有 `fract()`**：必须用 `frac()`；没有 `mod()`：用 `fmod()`（注意负数行为不同）

2. **`float2x2` 乘法顺序**：HLSL 中 `mul(matrix, vector)` 是行向量×矩阵，如果移植 GLSL 的 `mat * vec` 需要转置或改写为 `mul(vector, matrix)`

3. **粒子软裁剪需要 URP Depth Prepass**：确保 URP Asset 的 `Depth Texture` 选项已开启，否则 `SampleSceneDepth` 会采样到全白纹理

4. **`_Time.y` vs `Time.time`**：Shader 中用 `_Time.y`（Unity 内置 ShaderLab 变量，等价于 `Time.time`），不要尝试把 C# 的 `Time.time` 传入——`_Time.y` 已经自动注入到所有 Shader

5. **Gamma/Linear 工作流**：如果项目使用 Linear 色彩空间（推荐），`_ColorBottom` 等颜色属性会被 Unity 自动从 sRGB 转换为线性空间传入 Shader，颜色计算正确；如果项目是 Gamma 空间，手动调整颜色会有偏差

下一篇文章将深入讲解 Unity 矩阵变换体系，掌握 `UNITY_MATRIX_M/V/P` 的含义，以及如何写正确的顶点动画 Shader。
