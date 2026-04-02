---
title: Unity Shader 系列（二十四）：Unity 地形系统与自定义 Shader
date: 2026-04-01 12:50:00
tags: [HLSL, URP, 地形渲染, Splatmap, 地形纹理混合]
---

Unity 地形系统（Terrain）是开放世界游戏的核心基础设施。从内置 TerrainLit Shader 的工作原理，到自定义 Splatmap 多层纹理混合，再到基于坡度和高度的自动材质分配，本文提供完整的 URP 地形渲染技术指南。

## Unity Terrain 与 URP：TerrainLit Shader 工作原理

Unity 的 TerrainLit Shader 是专门为 `Terrain` 组件设计的 URP Shader，其核心技术是 **Splatmap**（泼溅图）。

**Splatmap 机制**：
- 一张 RGBA 纹理，每个通道（R/G/B/A）代表一种地形纹理的影响权重
- 最多 4 种纹理可以混合（一张 Splatmap）；超过 4 种需要第二张 Splatmap（最多 8 种）
- 在 Terrain Inspector 中用笔刷绘制即修改 Splatmap 的像素值

**TerrainLit 内部流程**：
1. 读取 Splatmap 的 RGBA 四个权重值
2. 按权重采样 4 张纹理（Albedo + Normal）
3. 对 4 份采样结果进行线性插值
4. 进行 PBR 光照计算

## 自定义地形 Shader：5层纹理混合 + 法线贴图 + 雪覆盖

```hlsl
Shader "Custom/URP/TerrainCustom"
{
    Properties
    {
        // Splatmap
        [HideInInspector] _Control ("Splatmap 控制图", 2D) = "red" {}

        // 4 层地形纹理（与 Unity Terrain 约定的名称一致）
        [HideInInspector] _Splat0 ("草地", 2D) = "white" {}
        [HideInInspector] _Splat1 ("岩石", 2D) = "white" {}
        [HideInInspector] _Splat2 ("泥土", 2D) = "white" {}
        [HideInInspector] _Splat3 ("沙地", 2D) = "white" {}

        // 法线贴图
        [HideInInspector] _Normal0 ("草地法线", 2D) = "bump" {}
        [HideInInspector] _Normal1 ("岩石法线", 2D) = "bump" {}
        [HideInInspector] _Normal2 ("泥土法线", 2D) = "bump" {}
        [HideInInspector] _Normal3 ("沙地法线", 2D) = "bump" {}

        // 雪覆盖效果
        _SnowColor ("雪的颜色", Color) = (0.9, 0.95, 1.0, 1.0)
        _SnowThreshold ("雪覆盖阈值（法线Y分量）", Range(0.5, 1.0)) = 0.8
        _SnowBlend ("雪混合过渡", Range(0, 0.5)) = 0.1
        _SnowHeight ("雪线高度（世界坐标Y）", Float) = 50.0
        _SnowHeightBlend ("雪线过渡范围", Float) = 10.0

        // 纹理缩放
        _Scale0 ("草地缩放", Float) = 20.0
        _Scale1 ("岩石缩放", Float) = 15.0
        _Scale2 ("泥土缩放", Float) = 25.0
        _Scale3 ("沙地缩放", Float) = 18.0
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
            // 地形专用 Tag：告诉 Unity 这是地形 Shader
            "TerrainCompatible" = "True"
        }

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _SHADOWS_SOFT

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_Control); SAMPLER(sampler_Control);
            TEXTURE2D(_Splat0);  SAMPLER(sampler_Splat0);
            TEXTURE2D(_Splat1);  SAMPLER(sampler_Splat1);
            TEXTURE2D(_Splat2);  SAMPLER(sampler_Splat2);
            TEXTURE2D(_Splat3);  SAMPLER(sampler_Splat3);
            TEXTURE2D(_Normal0); SAMPLER(sampler_Normal0);
            TEXTURE2D(_Normal1); SAMPLER(sampler_Normal1);
            TEXTURE2D(_Normal2); SAMPLER(sampler_Normal2);
            TEXTURE2D(_Normal3); SAMPLER(sampler_Normal3);

            CBUFFER_START(UnityPerMaterial)
                float4 _Control_ST;
                float4 _SnowColor;
                float _SnowThreshold, _SnowBlend;
                float _SnowHeight, _SnowHeightBlend;
                float _Scale0, _Scale1, _Scale2, _Scale3;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0; // Splatmap UV
            };

            struct Varyings
            {
                float4 positionCS  : SV_POSITION;
                float3 positionWS  : TEXCOORD0;
                float3 normalWS    : TEXCOORD1;
                float3 tangentWS   : TEXCOORD2;
                float3 bitangentWS : TEXCOORD3;
                float2 controlUV   : TEXCOORD4;
                float2 worldXZ     : TEXCOORD5; // 世界坐标 XZ（用于纹理平铺）
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.positionWS = TransformObjectToWorld(IN.positionOS.xyz);
                OUT.normalWS = TransformObjectToWorldNormal(IN.normalOS);
                OUT.tangentWS = TransformObjectToWorldDir(IN.tangentOS.xyz);
                OUT.bitangentWS = cross(OUT.normalWS, OUT.tangentWS) * IN.tangentOS.w;
                OUT.controlUV = IN.uv; // Splatmap UV 直接使用
                OUT.worldXZ = OUT.positionWS.xz; // 世界坐标用于纹理平铺
                return OUT;
            }

            // 从法线贴图解码法线到世界空间
            float3 SampleNormalTS(TEXTURE2D_PARAM(normalTex, sampler_normalTex), float2 uv)
            {
                float4 packedNormal = SAMPLE_TEXTURE2D(normalTex, sampler_normalTex, uv);
                // Unity 法线贴图格式：GA 通道存储 XY，Z 由 sqrt(1-x²-y²) 重建
                float3 normalTS;
                normalTS.xy = packedNormal.wy * 2.0 - 1.0;
                normalTS.z = sqrt(max(0, 1.0 - dot(normalTS.xy, normalTS.xy)));
                return normalTS;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // ===== 读取 Splatmap 权重 =====
                half4 splat = SAMPLE_TEXTURE2D(_Control, sampler_Control, IN.controlUV);
                // 归一化权重（确保总和为 1，避免过亮/过暗）
                float totalWeight = splat.r + splat.g + splat.b + splat.a;
                splat /= max(totalWeight, 0.001);

                // ===== 按缩放值计算各层 UV =====
                float2 uv0 = IN.worldXZ / _Scale0;
                float2 uv1 = IN.worldXZ / _Scale1;
                float2 uv2 = IN.worldXZ / _Scale2;
                float2 uv3 = IN.worldXZ / _Scale3;

                // ===== 采样各层纹理 =====
                half4 albedo0 = SAMPLE_TEXTURE2D(_Splat0, sampler_Splat0, uv0);
                half4 albedo1 = SAMPLE_TEXTURE2D(_Splat1, sampler_Splat1, uv1);
                half4 albedo2 = SAMPLE_TEXTURE2D(_Splat2, sampler_Splat2, uv2);
                half4 albedo3 = SAMPLE_TEXTURE2D(_Splat3, sampler_Splat3, uv3);

                // ===== Splatmap 加权混合 =====
                half4 mixedAlbedo = albedo0 * splat.r + albedo1 * splat.g
                                  + albedo2 * splat.b + albedo3 * splat.a;

                // ===== 法线混合 =====
                float3 normal0 = SampleNormalTS(TEXTURE2D_ARGS(_Normal0, sampler_Normal0), uv0);
                float3 normal1 = SampleNormalTS(TEXTURE2D_ARGS(_Normal1, sampler_Normal1), uv1);
                float3 normal2 = SampleNormalTS(TEXTURE2D_ARGS(_Normal2, sampler_Normal2), uv2);
                float3 normal3 = SampleNormalTS(TEXTURE2D_ARGS(_Normal3, sampler_Normal3), uv3);

                float3 mixedNormalTS = normalize(
                    normal0 * splat.r + normal1 * splat.g +
                    normal2 * splat.b + normal3 * splat.a
                );

                // 切线空间法线转世界空间
                float3x3 TBN = float3x3(
                    normalize(IN.tangentWS),
                    normalize(IN.bitangentWS),
                    normalize(IN.normalWS)
                );
                float3 normalWS = normalize(mul(mixedNormalTS, TBN));

                // ===== 雪覆盖效果 =====
                // 高度因子：超过雪线才有雪
                float heightFactor = saturate(
                    (IN.positionWS.y - _SnowHeight) / _SnowHeightBlend
                );
                // 坡度因子：法线 Y 分量越大（越水平）越容易积雪
                float slopeFactor = smoothstep(
                    _SnowThreshold - _SnowBlend,
                    _SnowThreshold + _SnowBlend,
                    normalWS.y
                );
                float snowAmount = heightFactor * slopeFactor;

                half3 finalAlbedo = lerp(mixedAlbedo.rgb, _SnowColor.rgb, snowAmount);
                // 积雪后法线变平（雪会填平细节）
                normalWS = lerp(normalWS, IN.normalWS, snowAmount * 0.7);

                // ===== PBR 光照 =====
                float4 shadowCoord = TransformWorldToShadowCoord(IN.positionWS);
                Light mainLight = GetMainLight(shadowCoord);

                float NdotL = saturate(dot(normalWS, mainLight.direction));
                half3 ambient = SampleSH(normalWS); // 球谐函数环境光
                half3 diffuse = mainLight.color * NdotL * mainLight.shadowAttenuation;

                // 积雪区域 Smoothness 更高（雪面更光滑）
                float smoothness = lerp(0.3, 0.8, snowAmount);
                float3 viewDir = normalize(_WorldSpaceCameraPos - IN.positionWS);
                float3 halfDir = normalize(mainLight.direction + viewDir);
                float NdotH = saturate(dot(normalWS, halfDir));
                half3 specular = mainLight.color * pow(NdotH, smoothness * 128.0) * 0.1
                               * mainLight.shadowAttenuation;

                half3 finalColor = finalAlbedo * (ambient + diffuse) + specular;

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }

        // 阴影投射 Pass（地形必须有）
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }
            ZWrite On ZTest LEqual Cull Back

            HLSLPROGRAM
            #pragma vertex ShadowVert
            #pragma fragment ShadowFrag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"

            struct ShadowAttribs { float4 posOS : POSITION; float3 normalOS : NORMAL; };
            struct ShadowVaryings { float4 posCS : SV_POSITION; };

            ShadowVaryings ShadowVert(ShadowAttribs IN)
            {
                ShadowVaryings OUT;
                float3 posWS = TransformObjectToWorld(IN.posOS.xyz);
                float3 normalWS = TransformObjectToWorldNormal(IN.normalOS);
                OUT.posCS = TransformWorldToHClip(ApplyShadowBias(posWS, normalWS, _LightDirection));
                return OUT;
            }
            half4 ShadowFrag(ShadowVaryings IN) : SV_Target { return 0; }
            ENDHLSL
        }
    }
}
```

## 基于坡度/高度的自动纹理混合

不依赖地形系统，纯粹通过坡度和高度自动决定材质，适合程序化地形生成：

```hlsl
// 在 Fragment Shader 中根据坡度和高度自动混合材质
half4 AutoBlendTerrain(float3 posWS, float3 normalWS)
{
    float height = posWS.y;
    float slope = 1.0 - normalWS.y; // 0=水平，1=垂直

    // 噪声扰动混合边界（避免硬切割）
    float noiseVal = frac(sin(dot(posWS.xz * 0.1, float2(12.9898, 78.233))) * 43758.5453);

    // 草地：坡度小（slope < 0.3）
    float grassWeight = smoothstep(0.35, 0.2 + noiseVal * 0.1, slope);

    // 岩石：坡度大（slope > 0.4）或高度超过雪线
    float rockWeight = smoothstep(0.25, 0.4 - noiseVal * 0.1, slope);

    // 沙地：低海拔区域
    float sandWeight = smoothstep(5.0, 0.0, height) * (1.0 - rockWeight);

    // 雪地：高海拔 + 坡度小
    float snowWeight = smoothstep(45.0, 55.0, height) * smoothstep(0.3, 0.1, slope);

    // 归一化权重
    float totalW = grassWeight + rockWeight + sandWeight + snowWeight;
    grassWeight /= totalW; rockWeight /= totalW;
    sandWeight  /= totalW; snowWeight  /= totalW;

    // 使用上述权重混合纹理（代码同 Splatmap 混合部分）
    // ...

    return half4(grassWeight, rockWeight, sandWeight, snowWeight); // 权重输出
}
```

## Splatmap 技术深度解析

**为什么不用 Lerp 而用加权和？**

Unity 地形 Shader 使用加权和而非逐层 Lerp，原因是加权和（权重归一化后）在数学上等价于多层 Lerp，但性能更好——只需一次混合操作而非三次。

**高度混合（Height-Based Blending）**：

标准 Splatmap 混合在边界处会产生生硬的混合，高度混合通过将纹理的高度信息（通常存在 Alpha 通道）参与权重计算，产生更自然的边界（如岩石从草地中突出的效果）：

```hlsl
// 高度混合改进版 Splatmap
float HeightBlend(float w0, float h0, float w1, float h1, float sharpness)
{
    // 将高度信息叠加到权重上
    float blend = w0 * (h0 + 0.0001) / (w1 * (h1 + 0.0001) + w0 * (h0 + 0.0001));
    // sharpness 控制边界锐度
    float blendSharp = saturate((blend - (1.0 - sharpness)) / sharpness);
    return blendSharp;
}

// 在混合时调用
float blend01 = HeightBlend(splat.r, albedo0.a, splat.g, albedo1.a, 0.3);
half3 mixed = lerp(albedo0.rgb, albedo1.rgb, blend01);
```

## 大世界地形优化

**虚拟纹理（SVT - Streaming Virtual Textures）**：
- Unity 2020+ 支持 Adaptive Probe Volumes 和基础的 VT 功能
- 原理：将所有地形纹理打包到一张巨大虚拟纹理中，仅流式加载可见区域
- 优点：减少纹理切换开销，支持超大地形
- 配置：在地形 Terrain Settings 中开启 Enable Virtual Texturing

**Terrain LOD 策略**：
Unity 地形内置 LOD 系统，通过 `Pixel Error` 和 `Base Map Distance` 控制：
- 近处：高 LOD（更多顶点，更细节）
- 远处：低 LOD（更少顶点 + 烘焙的 Base Map 替代详细纹理）

**Terrain Detail Mesh 优化**：
- Detail Mesh（草、石子）的数量是移动端性能杀手
- 建议通过 `detailDistance`（C# API）在运行时动态调整草的渲染距离
- GPU Instancing + Billboard LOD 是 URP 中渲染大量 Detail Mesh 的标准方案

## ShaderGraph 实现思路

在 ShaderGraph 中实现 Splatmap 混合：

1. **Graph Settings**：Target = URP Lit
2. **Splatmap 读取**：`Sample Texture 2D`（Control 图）→ 拆分 RGBA
3. **各层采样**：4 个 `Sample Texture 2D` 分别采样 4 层纹理
4. **加权混合**：使用 `Lerp` 节点逐层混合（等价于加权和）
5. **雪效果**：`Normal Vector` → 取 Y 分量 → `Smoothstep` → `Lerp`（混合雪色）
6. **连接输出**：混合结果 → `Base Color`，法线 → `Normal`

## 性能对比

| 技术 | Draw Call 数 | 纹理采样数/像素 | 适用场景 |
|------|-------------|----------------|----------|
| 1 张 Splatmap（4 层） | 1 | 5（1 Splatmap + 4 层） | 标准地形 |
| 2 张 Splatmap（8 层） | 2 | 10 | 复杂地形 |
| 高度混合 4 层 | 1 | 5+4（额外读高度） | 高品质边界 |
| 程序化自动混合 | 1 | 4 | 无需地形系统 |

Unity 地形 Shader 是开放世界游戏最核心的渲染组件之一，理解 Splatmap、坡度/高度混合和 LOD 策略，能帮助你在性能与视觉质量之间取得最佳平衡。
