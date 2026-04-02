---
title: Unity Shader 系列（十六）：URP Shader 性能优化实战
date: 2026-04-17 12:00:00
tags: [HLSL, URP, Shader优化, 性能, SDF技巧]
---

Shader 性能优化是 Unity 游戏开发中最具影响力、也最容易被忽视的技术方向。一个写得好的 Shader 可以在同等视觉质量下比粗糙实现快 5-10 倍，这在移动端上往往是游戏能否流畅运行的关键。本文从 Unity 官方工具（Frame Debugger、Shader Profiler、RenderDoc）的实际使用方法出发，深入讲解每一种优化技术，并提供完整的优化版 SDF UI Shader 作为综合案例。

## 工具篇：先量化，再优化

优化的第一原则是：**不要盲目猜测瓶颈**。Unity 提供了完整的分析工具链。

### Frame Debugger

Window → Analysis → Frame Debugger，可以逐 Draw Call 查看每一步的渲染结果：

- 检查 **overdraw**：半透明物体叠加过多层（透明粒子是最常见的 overdraw 来源）
- 查看 **Shader 变体**：每个 Draw Call 右侧显示使用的 Shader 和关键字，快速发现变体膨胀
- 验证 **深度测试**：确认 Depth Priming 是否生效（Early-Z 优化）

### GPU Usage（Profiler）

Window → Analysis → Profiler，切换到 GPU 标签页：

- **VS Time**（顶点着色器时间）高：检查顶点数量、顶点着色器复杂度
- **FS Time**（片段着色器时间）高：检查 overdraw、片段着色器复杂度、纹理采样数
- **Memory Bandwidth**（内存带宽）高：检查纹理尺寸、Mipmap 设置

### RenderDoc 集成

在 Unity 中安装 RenderDoc 插件后，可以 Capture 单帧并在 RenderDoc 中查看每个 Draw Call 的：
- 实际执行的 DXBC/SPIRV 指令数
- 各纹理单元的采样计数
- ALU（算术逻辑单元）和 TEX（纹理单元）的使用比例

## 核心优化技术

### 技术一：精度优化（half vs float）

在 HLSL 中，`float` 是 32 位，`half` 是 16 位。移动端 GPU 对 `half` 的计算速度是 `float` 的两倍。

**精度选择原则**：

```hlsl
// 高精度 float（必须使用 float）：
// - 世界坐标、矩阵变换
// - 深度值计算
// - 精确的射线求交

// 中精度 half（通常足够）：
// - 颜色值（0-1范围）
// - 法线向量
// - UV 坐标（偏移量）
// - 光照中间结果

// 实际代码示例：
half4 frag(Varyings input) : SV_Target
{
    // UV 计算用 half
    half2 uv = (half2)input.uv;
    
    // 纹理采样返回 half4
    half4 albedo = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);
    
    // 法线用 half
    half3 normal = (half3)normalize(input.worldNormal);
    
    // 颜色计算全程用 half
    half NdotL = saturate(dot(normal, (half3)mainLight.direction));
    half3 finalColor = albedo.rgb * NdotL;
    
    return half4(finalColor, 1.0h);
}
```

**踩坑警告**：不要对 `worldPos` 使用 `half`，在大场景中会导致顶点位置精度不足，出现顶点抖动（特别是 `SV_POSITION` 推导出的 worldPos）。

### 技术二：discard 与 clip() 的正确使用

`discard`（或等价的 `clip()`）在 URP 中有一个常见的误解：**它在 tile-based 的移动端 GPU 上会禁用 Early-Z 优化**。

```hlsl
// 错误用法：在 frag 开始就 discard，阻止了 Early-Z
half4 frag(Varyings input) : SV_Target
{
    // 这行 discard 让 GPU 无法提前剔除片段
    if (input.alpha < 0.5) discard;
    // ...其他计算
}

// 正确用法一：使用 alpha-to-coverage（MSAA 下）
// 在 SubShader Tags 中: "RenderType" = "TransparentCutout"
// 然后输出 alpha，由 GPU 硬件决定

// 正确用法二：clip() 与 Early-Z 的权衡
// 对于明确需要镂空的效果（如植被叶片），clip() 带来的 overdraw 减少
// 通常比 Early-Z 损失更有价值
[branch]  // 提示编译器使用分支而不是展开（减少寄存器压力）
if (noiseVal < _CutoffThreshold)
    clip(-1);  // 等价于 discard，但有时编译器能更好地优化

// 正确用法三：URP 中 Alpha Clipping 的标准写法
void InitializeStandardLitSurfaceData(...)
{
    outSurfaceData.alpha = Alpha(albedoAlpha.a, _BaseColor, _Cutoff);
    // Alpha() 函数内部已包含 AlphaDiscard() 调用
}
```

### 技术三：四面体法线 vs 六样本中心差分

在 SDF 光线步进中，法线估计是最频繁调用的操作。四面体法（Tetrahedral Normal）只需 4 次 SDF 采样，比标准的六样本中心差分节省 33%：

```hlsl
// 传统六样本中心差分法（6 次 SDF 调用）
float3 NormalCentralDiff(float3 pos)
{
    const float eps = 0.001;
    return normalize(float3(
        SceneSDF(pos + float3(eps,0,0)) - SceneSDF(pos - float3(eps,0,0)),
        SceneSDF(pos + float3(0,eps,0)) - SceneSDF(pos - float3(0,eps,0)),
        SceneSDF(pos + float3(0,0,eps)) - SceneSDF(pos - float3(0,0,eps))
    ));
}

// 优化四面体法（4 次 SDF 调用，减少 33%）
float3 NormalTetrahedral(float3 pos)
{
    // 四面体的四个顶点方向（归一化到等距）
    const float2 k = float2(1, -1);
    const float  eps = 0.001;
    return normalize(
        k.xyy * SceneSDF(pos + k.xyy * eps) +
        k.yyx * SceneSDF(pos + k.yyx * eps) +
        k.yxy * SceneSDF(pos + k.yxy * eps) +
        k.xxx * SceneSDF(pos + k.xxx * eps)
    );
}
```

### 技术四：Overdraw 控制与 SDF UI Shader

SDF 在 UI 渲染（TextMeshPro 的原理）中有重要应用：通过 `fwidth` 实现无锯齿的边缘，无需 MSAA。同时通过边界盒预测剔除无效片段，减少 overdraw：

```hlsl
// SDF UI 渲染的核心技巧：使用 fwidth 自适应采样宽度
half4 SDFFragmentUI(float2 uv, TEXTURE2D_PARAM(sdfTex, sdfSampler))
{
    half sdfVal = SAMPLE_TEXTURE2D(sdfTex, sdfSampler, uv).r;
    
    // fwidth：相邻片段 SDF 值的差分（屏幕空间偏导数）
    // 用于自动计算当前缩放下的抗锯齿宽度
    half w = fwidth(sdfVal);
    
    // smoothstep 宽度 = 1 像素的 SDF 变化量
    // 这样无论缩放比例如何，边缘始终是 1 像素宽（无锯齿）
    half alpha = smoothstep(0.5 - w, 0.5 + w, sdfVal);
    
    return half4(1.0h, 1.0h, 1.0h, alpha);
}
```

## 完整示例：优化版 SDF UI Shader

这个 Shader 综合运用了所有优化技术，可以直接用于 Unity UI Canvas 的自定义 Shader。

```hlsl
Shader "Custom/URP/OptimizedSDFUI"
{
    Properties
    {
        [PerRendererData] _MainTex ("SDF 纹理 (TextMeshPro 格式)", 2D) = "white" {}
        _FaceColor ("字体颜色", Color) = (1, 1, 1, 1)
        _FaceDilate ("字体膨胀（加粗/收缩）", Range(-1, 1)) = 0
        _OutlineColor ("轮廓颜色", Color) = (0, 0, 0, 1)
        _OutlineWidth ("轮廓宽度", Range(0, 1)) = 0
        _GlowColor ("辉光颜色", Color) = (0, 0.5, 1, 0.5)
        _GlowInner ("辉光内边", Range(0, 1)) = 0
        _GlowOuter ("辉光外边", Range(0, 1)) = 0
        _GlowPower ("辉光强度", Range(0.1, 10)) = 1.0
        _ShadowColor ("阴影颜色", Color) = (0, 0, 0, 0.5)
        _ShadowOffset ("阴影偏移 (XY)", Vector) = (0.005, -0.005, 0, 0)
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

        Pass
        {
            Name "SDFUIPass"
            Tags { "LightMode" = "UniversalForward" }

            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off
            // 关闭深度测试（UI 不需要 Early-Z）
            ZTest [unity_GUIZTestMode]

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // 不需要阴影相关的变体（UI 不接收阴影）
            // 减少 Shader 变体数量（降低编译时间和内存占用）

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                half4  _FaceColor;
                half   _FaceDilate;
                half4  _OutlineColor;
                half   _OutlineWidth;
                half4  _GlowColor;
                half   _GlowInner;
                half   _GlowOuter;
                half   _GlowPower;
                half4  _ShadowColor;
                float4 _ShadowOffset;   // 保持 float 精度用于偏移计算
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 color      : COLOR;      // 顶点颜色（UI 系统使用）
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                half4  color       : COLOR;
                float2 uv          : TEXCOORD0;  // 保持 float UV 精度防止纹理采样误差
            };

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.color       = (half4)input.color;
                output.uv          = TRANSFORM_TEX(input.uv, _MainTex);
                return output;
            }

            // 边界盒预测剔除（SDF 核心优化）
            // 如果片段明显在字符边界框外，提前退出
            half GetSDF(float2 uv)
            {
                return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv).a;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float2 uv = input.uv;

                // ---- 边界预测：粗略剔除明显无效的片段 ----
                // 采样当前 UV（廉价判断）
                half sdf = GetSDF(uv);

                // 快速排除：SDF 值极低且没有轮廓/辉光时，直接剔除
                // 这减少了大面积空白区域的 overdraw
                half maxExtent = max(_OutlineWidth, _GlowOuter) + 0.1h;
                if (sdf < (0.5h - _FaceDilate * 0.5h - maxExtent) * 0.5h)
                {
                    // 提前退出，避免后续昂贵的多次采样
                    return half4(0, 0, 0, 0);
                }

                // ---- 屏幕空间导数（fwidth）计算抗锯齿宽度 ----
                half w = fwidth(sdf);

                // ---- 阴影采样（轻微偏移，需要在 fwidth 之前）----
                half shadowSDF = GetSDF(uv - (half2)_ShadowOffset.xy);

                // ---- 各层 SDF 阈值 ----
                half faceDilate  = 0.5h + _FaceDilate * 0.5h;           // 字体核心
                half outlineMin  = faceDilate - _OutlineWidth;           // 轮廓内边
                half glowMin     = faceDilate - _GlowInner;              // 辉光内边
                half glowMax     = faceDilate - _GlowInner - _GlowOuter; // 辉光外边

                // ---- Alpha 计算 ----
                // 字体面（1 像素 AA 边缘）
                half faceAlpha    = smoothstep(faceDilate - w, faceDilate + w, sdf);

                // 轮廓（从 outlineMin 到 faceDilate）
                half outlineAlpha = _OutlineWidth > 0.001h
                    ? smoothstep(outlineMin - w, outlineMin + w, sdf)
                    : 0.0h;

                // 辉光（从 glowMax 到 glowMin 区域）
                half glowAlpha    = (_GlowOuter > 0.001h)
                    ? pow(smoothstep(glowMax - w, glowMin + w, sdf), _GlowPower)
                    : 0.0h;

                // 阴影
                half shadowAlpha  = smoothstep(faceDilate - w, faceDilate + w, shadowSDF) * 0.8h;

                // ---- 颜色合成（从后到前：阴影 -> 辉光 -> 轮廓 -> 字体面）----
                half4 result = half4(0, 0, 0, 0);

                // 1. 阴影层
                result = lerp(result, _ShadowColor, shadowAlpha * _ShadowColor.a
                    * (1.0h - faceAlpha) * (1.0h - outlineAlpha));

                // 2. 辉光层（加法混合模拟）
                result.rgb += _GlowColor.rgb * glowAlpha * _GlowColor.a;
                result.a   = max(result.a, glowAlpha * _GlowColor.a);

                // 3. 轮廓层
                result = lerp(result, _OutlineColor, outlineAlpha * _OutlineColor.a);

                // 4. 字体面层
                result = lerp(result, _FaceColor * input.color, faceAlpha);

                // 最终 alpha（所有层的合成 alpha）
                result.a = max(max(glowAlpha * _GlowColor.a, outlineAlpha * _OutlineColor.a),
                               faceAlpha) * input.color.a;

                return result;
            }
            ENDHLSL
        }
    }
}
```

## Shader 变体优化

过多的 Shader 变体是另一个常见的性能问题：每个 `#pragma multi_compile` 产生 2 的 N 次方个变体，大量变体导致：
- **冷启动加载慢**（Shader 编译）
- **内存占用增加**（变体缓存）
- **Shader.WarmUp 时间长**

```hlsl
// 不好的写法：产生 2^4 = 16 个变体
#pragma multi_compile _ FEATURE_A
#pragma multi_compile _ FEATURE_B
#pragma multi_compile _ FEATURE_C
#pragma multi_compile _ FEATURE_D

// 好的写法：使用 shader_feature（只编译使用到的变体）
// shader_feature 会在 Build 时自动 Strip 未使用的变体
#pragma shader_feature _ FEATURE_A
#pragma shader_feature _ FEATURE_B

// 对于运行时可切换的特性，仍需使用 multi_compile
#pragma multi_compile _ _MAIN_LIGHT_SHADOWS  // 阴影：运行时可切换

// 对于平台相关的变体，使用 multi_compile_fragment
// 只在片段着色器中生效，减少顶点着色器变体
#pragma multi_compile_fragment _ _SHADOWS_SOFT
```

## GPU Instancing 与 SDF 的结合

当场景中有大量使用相同 SDF 材质的对象时（比如一堆相同的魔法水晶），GPU Instancing 可以大幅减少 Draw Call：

```hlsl
// 在 Shader 中开启 GPU Instancing 支持
#pragma multi_compile_instancing

// 使用 UNITY_INSTANCING_BUFFER 传递每实例数据
UNITY_INSTANCING_BUFFER_START(PerInstanceData)
    UNITY_DEFINE_INSTANCED_PROP(float4, _InstanceColor)
    UNITY_DEFINE_INSTANCED_PROP(float,  _SDFRadius)
UNITY_INSTANCING_BUFFER_END(PerInstanceData)

// 在 frag 中使用每实例数据
half4 frag(Varyings input) : SV_Target
{
    UNITY_SETUP_INSTANCE_ID(input);
    
    float4 instanceColor = UNITY_ACCESS_INSTANCED_PROP(PerInstanceData, _InstanceColor);
    float  sdfRadius     = UNITY_ACCESS_INSTANCED_PROP(PerInstanceData, _SDFRadius);
    
    // ...使用每实例的 sdfRadius 而不是全局的 _BeamRadius
}
```

## 常见性能陷阱

| 陷阱 | 症状 | 解决方案 |
|------|------|---------|
| 大量 `discard` | 移动端 fill rate 下降，帧率不稳定 | 用 Alpha Blending 替代，或优化 discard 位置 |
| 纹理采样过多 | GPU Memory Bandwidth 高，发热严重 | 合并纹理通道（将多张贴图打包到 RGBA） |
| 过深的 Shader 分支 | 编译后指令数暴增 | 用 `lerp` 替代 `if`，或用 `#pragma` 特性开关 |
| 精度不一致 | 移动端数值精度错误、黑屏 | 统一精度规范，关键计算用 `float` |
| ShadowCaster 未优化 | 阴影贴图渲染开销大 | ShadowCaster Pass 中移除所有不必要的计算 |
| 未使用 Depth Priming | overdraw 严重 | 在 URP Asset 中开启 Depth Priming Mode |

## 常见踩坑

**坑1：`[unroll]` 与 `[loop]` 的编译器行为**
HLSL 中 `[unroll]` 强制展开循环，增大着色器大小但减少分支开销；`[loop]` 保留循环，减小大小但增加分支开销。对于 SDF 光线步进（通常 64-128 步），**不要** 使用 `[unroll]`，否则编译后的指令数量会爆炸式增长（可能超过 GPU 硬件限制）。

**坑2：移动端 `fwidth` 不可用**
`fwidth`、`ddx`、`ddy`（屏幕空间偏导数）在某些移动端 GPU 或特定渲染模式（如 Forward+ 中的某些情况）下可能不可用或精度极低。如果目标平台是移动端，需要提供不依赖 `fwidth` 的降级路径。

**坑3：CBUFFER 对齐规则**
HLSL 的 CBUFFER 有严格的 16 字节对齐规则：如果一个 `float` 变量后跟一个 `float3`，可能因为跨 16 字节边界而产生意外的内存布局。始终使用 Unity 的 `CBUFFER_START/CBUFFER_END` 宏，并注意变量排列顺序（将 `float4` 放在前面，`float` 放在后面）。
