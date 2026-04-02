---
title: Unity Shader 系列（二十一）：粒子系统与 Shader 深度整合
date: 2026-04-01 12:20:00
tags: [HLSL, URP, 粒子系统, VFX Graph, 特效]
categories:
  - Unity Shader 系列
  - GPU 计算与模拟
---

Unity 的粒子特效系统与 Shader 的深度结合，是游戏中火焰、魔法、爆炸、雨雪等视觉效果的核心技术基础。本文从 Shuriken 粒子系统到 VFX Graph，从自定义粒子 Shader 到软粒子深度排序，全面讲解 URP 环境下的粒子渲染技术。

## Particle System（Shuriken）vs VFX Graph：如何选择

Unity 提供两套粒子系统，选择取决于项目规模和复杂度：

| 特性 | Particle System（Shuriken） | VFX Graph |
|------|----------------------------|-----------|
| 粒子上限 | 数万级 | 百万级（GPU 驱动） |
| 运行环境 | CPU 模拟 | GPU Compute Shader |
| 最低平台 | 所有平台 | 需要 Compute Shader 支持 |
| 可视化编辑 | Inspector 面板 | 节点图编辑器 |
| 自定义逻辑 | 受限，需要 C# 脚本配合 | 完全可视化节点编程 |
| Shader 集成 | Custom Vertex Stream | Output 节点直连 |

**选择建议**：移动端、粒子数量 < 10 万、需要兼容低端设备 → 用 Shuriken；PC/主机端、特效密集场景、需要百万粒子 → 用 VFX Graph。

## 自定义粒子 Shader：核心宏与结构

Unity 粒子系统对 Shader 有特殊要求，最关键的是支持 GPU Instancing。

```hlsl
Shader "Custom/URP/ParticleFire"
{
    Properties
    {
        _MainTex ("粒子纹理", 2D) = "white" {}
        _FlowTex ("UV流动纹理", 2D) = "white" {}
        _FlowSpeed ("流动速度", Float) = 1.0
        _FlowStrength ("流动强度", Float) = 0.1
        _EmissionColor ("发光颜色", Color) = (1, 0.5, 0.1, 1)
        _EmissionIntensity ("发光强度", Float) = 2.0
        _SoftParticleFade ("软粒子淡化距离", Float) = 1.0
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Transparent"
        }

        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Cull Off

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            // 启用 GPU Instancing（粒子系统必须）
            #pragma multi_compile_instancing
            #pragma instancing_options procedural:vertInstancingSetup

            // 启用软粒子关键字
            #pragma multi_compile _ SOFTPARTICLES_ON

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            // 粒子 Instancing 头文件（必须在 Core.hlsl 之后）
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Particles.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);
            TEXTURE2D(_FlowTex);
            SAMPLER(sampler_FlowTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _FlowTex_ST;
                float _FlowSpeed;
                float _FlowStrength;
                float4 _EmissionColor;
                float _EmissionIntensity;
                float _SoftParticleFade;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS   : POSITION;
                float2 uv           : TEXCOORD0;
                float4 color        : COLOR;        // 粒子颜色（包含生命周期渐变）
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS   : SV_POSITION;
                float2 uv           : TEXCOORD0;
                float4 color        : COLOR;
                float4 projectedPos : TEXCOORD1;    // 软粒子深度比较用
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                // 粒子 Instancing 设置（GPU Instancing 必须调用）
                #ifdef UNITY_PARTICLE_INSTANCING_ENABLED
                    vertInstancingSetup();
                #endif

                OUT.positionCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = TRANSFORM_TEX(IN.uv, _MainTex);
                OUT.color = IN.color;

                // 软粒子：记录裁剪空间位置用于深度比较
                OUT.projectedPos = ComputeScreenPos(OUT.positionCS);

                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // UV 流动动画（模拟火焰翻滚）
                float2 flowUV = IN.uv * _FlowTex_ST.xy + _FlowTex_ST.zw;
                float2 flowOffset = SAMPLE_TEXTURE2D(_FlowTex, sampler_FlowTex, flowUV + _Time.y * _FlowSpeed * 0.1).rg;
                flowOffset = (flowOffset * 2.0 - 1.0) * _FlowStrength;

                // 采样主纹理（应用流动偏移）
                float2 animatedUV = IN.uv + flowOffset;
                half4 texColor = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, animatedUV);

                // 与粒子颜色混合（粒子系统的 Color over Lifetime 通过 IN.color 传入）
                half4 finalColor = texColor * IN.color;

                // 发光叠加
                finalColor.rgb += _EmissionColor.rgb * _EmissionIntensity * finalColor.a;

                // 软粒子：与场景深度比较，避免硬切割
                #ifdef SOFTPARTICLES_ON
                    float sceneDepth = LinearEyeDepth(
                        SampleSceneDepth(IN.projectedPos.xy / IN.projectedPos.w),
                        _ZBufferParams
                    );
                    float partDepth = IN.projectedPos.w; // 粒子本身的线性深度
                    float fade = saturate((sceneDepth - partDepth) / _SoftParticleFade);
                    finalColor.a *= fade;
                #endif

                return finalColor;
            }
            ENDHLSL
        }
    }
}
```

## Custom Data：粒子系统向 Shader 传递自定义参数

Shuriken 提供 Custom Data 模块，可向 Shader 传递额外的每粒子数据（如随机种子、UV 偏移、特殊状态）。

**配置步骤**：
1. 在粒子系统 Inspector 中开启 `Custom Data` 模块
2. 设置 Custom1/Custom2 的 Vector 或 Color 模式
3. 在 `Renderer` 模块 → `Custom Vertex Streams` 中添加 `Custom1.xyzw`
4. 在 Shader 中通过 TEXCOORD 接收

```hlsl
// 在 Attributes 结构体中接收 Custom Data
struct Attributes
{
    float4 positionOS   : POSITION;
    float2 uv           : TEXCOORD0;
    float4 color        : COLOR;
    float4 custom1      : TEXCOORD1;  // Custom Data 1（例：xy=随机偏移, z=随机旋转, w=生命周期）
    UNITY_VERTEX_INPUT_INSTANCE_ID
};

// 在片元着色器中使用
half frag(Varyings IN) : SV_Target
{
    // 使用 custom1.z 作为 UV 旋转角度
    float angle = IN.custom1.z * 6.28318;
    float2 rotUV = float2(
        cos(angle) * (IN.uv.x - 0.5) - sin(angle) * (IN.uv.y - 0.5) + 0.5,
        sin(angle) * (IN.uv.x - 0.5) + cos(angle) * (IN.uv.y - 0.5) + 0.5
    );
    // ...
}
```

## 软粒子（Soft Particles）：正确的深度排序

粒子与几何体相交时会产生硬切割边缘，这是粒子特效最常见的视觉问题。URP 软粒子通过对比粒子深度与场景深度缓冲来淡化交叉处。

**启用步骤**：
1. URP Asset → `Depth Texture` 开启（生成 `_CameraDepthTexture`）
2. 粒子材质 Shader 中添加 `#pragma multi_compile _ SOFTPARTICLES_ON`
3. 在材质 Inspector 中开启 Soft Particles，设置淡化距离

**踩坑提醒**：URP 的深度纹理在某些平台（特别是移动端 OpenGL ES）可能精度不足，导致 Z-fighting。建议将 `_SoftParticleFade` 设置得稍大（0.5~2.0）。

## VFX Graph：百万粒子星系实现

VFX Graph 完全在 GPU 上运行，适合百万级粒子效果。以下是星系粒子的核心节点配置思路：

**星系轨道方程（Custom HLSL Block）**：

```hlsl
// VFX Graph Custom HLSL Block
// 输入：粒子 ID、时间
// 输出：位置、颜色

void GalaxyOrbit(in uint particleID, in float time,
                 out float3 position, out float3 color)
{
    // 将粒子 ID 映射到 [0,1] 参数
    float t = (float)particleID / 1000000.0;

    // 对数螺旋线（银河悬臂形态）
    float armAngle = t * 4.0 * 3.14159; // 螺旋角度
    float armOffset = frac(particleID * 0.61803) * 0.3; // 黄金比例分布
    float radius = pow(t, 0.5) * 10.0 + armOffset;

    // 加入时间让星系缓慢旋转（外圈慢，内圈快）
    float rotSpeed = 0.1 / max(radius, 0.1);
    float angle = armAngle + time * rotSpeed;

    position = float3(
        cos(angle) * radius,
        (frac(particleID * 0.37) - 0.5) * 0.5 * (1.0 - t), // 盘面厚度
        sin(angle) * radius
    );

    // 颜色：中心偏黄白，边缘偏蓝
    color = lerp(float3(1.0, 0.9, 0.7), float3(0.5, 0.7, 1.0), t);
}
```

**手写 Shader 对比 VFX Graph**：

| 方面 | 手写粒子 Shader | VFX Graph |
|------|----------------|-----------|
| 粒子物理模拟 | C# 脚本驱动 | GPU Compute |
| 渲染灵活性 | 完全可控 HLSL | 受 Output 节点限制 |
| 调试便利性 | 困难 | 可视化节点，易调试 |
| 粒子间交互 | 需要额外 Buffer | 内置碰撞/力场节点 |
| 移动端兼容 | 全兼容 | 需要 CS3.5+ GPU |

## 粒子与场景深度排序：Transparent Pass 的正确姿势

透明粒子的排序是 URP 开发中的常见问题。Unity 的透明物体按距相机距离从后向前排序，但粒子之间的互相遮挡（如烟雾卷积）很难精确排序。

**正确做法**：

```hlsl
// Shader Tags 配置
SubShader
{
    Tags
    {
        "Queue" = "Transparent"
        // 强制在所有不透明物体之后渲染
        // 注意：粒子之间仍然可能排序错误
    }

    // 关闭深度写入，开启深度测试
    ZWrite Off
    ZTest LEqual

    // 加法混合适合发光粒子（火焰、魔法）
    Blend One One

    // 透明混合适合烟雾（不是加法）
    // Blend SrcAlpha OneMinusSrcAlpha
}
```

**进阶技巧**：对于需要精确排序的烟雾效果，考虑使用 `Order in Layer` 和 `Sorting Layer` 组合，或者使用 URP 的 OIT（Order-Independent Transparency）Renderer Feature（Unity 2023+）。

## ShaderGraph 实现思路

在 ShaderGraph 中实现相同的火焰粒子效果：

1. **Graph Settings**：Surface = Transparent，Blend Mode = Additive
2. **粒子颜色输入**：添加 `Particle Color` 节点（自动接收粒子系统颜色）
3. **UV 流动**：`Time` → 乘以速度 → 加到 UV → `Sample Texture 2D`（Flow Map）
4. **流动偏移**：Flow Map 输出 × 强度 → 加到主 UV
5. **软粒子**：添加 `Scene Depth` 节点 → 减去 `Screen Position.w` → 除以淡化距离 → `Saturate` → 连接到 Alpha

## 性能考量

**移动端粒子优化清单**：
- 同屏粒子数量控制在 500 以内（低端设备）
- 使用 Additive 混合优于 Alpha Blend（Additive 无需排序）
- 粒子纹理使用 ETC2/ASTC 压缩，分辨率不超过 256×256
- 避免大面积半透明粒子重叠（Overdraw 是移动端最大杀手）
- 关闭不必要的软粒子（深度纹理采样有额外开销）

**PC/主机端**：
- VFX Graph + GPU Instancing 可处理百万粒子
- 启用 `UNITY_PARTICLE_INSTANCING_ENABLED` 确保 Instancing 正常工作
- 使用 LOD Group 在远距离替换为 Billboard 粒子

## 实际游戏应用场景

| 效果 | 技术方案 | 关键参数 |
|------|----------|----------|
| 营火火焰 | Shuriken + 流动 UV Shader | Flow Map + Additive 混合 |
| 魔法光球 | VFX Graph + 自发光 Shader | Emission + Bloom 后处理 |
| 子弹轨迹 | Line Renderer + Trail Shader | UV 拉伸 + 速度淡化 |
| 雨雪 | Shuriken 碰撞 + 软粒子 | 软粒子淡化 + 法线贴图溅射 |
| 爆炸冲击波 | Shuriken + SDF 圆环 Shader | 程序化圆环 SDF + 扭曲后处理 |

粒子系统与 Shader 的深度整合是 Unity 特效制作的核心技能——理解 Instancing、Custom Data、软粒子的工作原理，才能在保证性能的同时创作出令人惊艳的游戏特效。
