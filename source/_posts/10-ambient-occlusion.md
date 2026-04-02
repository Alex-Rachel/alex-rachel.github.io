---
title: Unity Shader 系列（十）：URP AO 技术全景 — SSAO、烘焙 AO 与洞穴材质实战
date: 2026-04-01 10:30:00
tags: [HLSL, URP, AO, SSAO, 环境光遮蔽, 光照烘焙]
categories:
  - Unity Shader 系列
  - 光照与阴影
---

## 什么是 AO，为什么游戏中不可缺少？

环境光遮蔽（Ambient Occlusion，AO）模拟的是一种物理现象：在凹陷、缝隙、角落等处，来自四面八方的间接环境光被周围几何体遮挡，导致这些区域比开放区域更暗。

游戏中的 AO 有三种主要来源：
1. **实时 SSAO**（Screen Space Ambient Occlusion）：每帧实时计算，响应动态场景变化
2. **烘焙 AO**（Baked AO in Lightmap）：预计算到 Lightmap 贴图中，移动端友好
3. **贴图 AO**（AO Map）：美术手动制作，存储在材质贴图的特定通道

**实际游戏应用：**
1. **《黑神话：悟空》等 AAA 游戏**：SSAO + GTAO 叠加，洞穴内部、岩石缝隙有强烈 AO 暗化
2. **开放世界室外场景**：烘焙 AO 处理静态植被根部、建筑墙角的接触阴影
3. **室内场景（密室逃脱、恐怖游戏）**：高强度 SSAO 增强角落的阴暗感

## URP SSAO Renderer Feature

URP 内置了 SSAO，通过 Renderer Feature 方式添加：

**添加步骤：**
1. 选择 URP Asset 引用的 Renderer（通常是 `UniversalRenderer`）
2. Inspector → `Add Renderer Feature` → `Screen Space Ambient Occlusion`
3. 配置参数：

```
SSAO 关键配置参数：
- Method: SSAO（传统屏幕空间）或 HDAO（更精确，开销更大）
- Intensity: AO 强度（0~2，通常 0.5~1.0）
- Radius: 采样半径（世界空间单位，通常 0.1~0.5m）
- Falloff Distance: 超过此距离 AO 强度渐减（减少远处噪声）
- Source: Depth（仅深度）或 Depth Normals（深度+法线，精确但需要 DepthNormals Pass）
- Quality (Sample Count): Low/Medium/High（采样数：4/8/16次）
- Downsample: 开启后在半分辨率下计算（性能提升约 50%，质量略降）
```

**URP SSAO 的渲染时机：**
SSAO 在 `AfterRenderingOpaques` 之后计算，结果存储在 `_ScreenSpaceOcclusionTexture`，在后续的 ForwardLit Pass 中自动采样。

## 在 Shader 中读取 SSAO

```hlsl
// 使用 URP 内置函数读取 SSAO（自动处理特性开关）
// 在 Fragment Shader 中：

// 方式一：使用 AmbientOcclusionFactor 结构（推荐）
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

// 在 Fragment Shader 中，InputData 初始化后调用：
AmbientOcclusionFactor aoFactor = CreateDistanceBasedAO(IN.positionWS, normalWS, normalizedScreenSpaceUV);
// aoFactor.indirectAmbientOcclusion: 间接光 AO（0=完全遮蔽, 1=完全开放）
// aoFactor.directAmbientOcclusion: 直接光 AO（通常不单独使用）

// 将 AO 应用到光照（混合器接口）
MixRealtimeAndBakedGI(mainLight, normalWS, bakedGI, aoFactor);

// 方式二：手动采样 SSAO 纹理（精细控制）
#if defined(_SCREEN_SPACE_OCCLUSION)
    // 仅当启用了 SSAO Feature 时有效
    float ssao = SampleAmbientOcclusion(normalizedScreenSpaceUV);
    // 使用方式：乘以间接光/环境光
    half3 ambient = SampleSH(normalWS) * albedo * ssao;
#else
    half3 ambient = SampleSH(normalWS) * albedo;
#endif
```

## 烘焙 AO：Lightmap UV 与正确工作流

烘焙 AO 存储在 Lightmap 中，依赖 Unity 的光照烘焙系统（Bake Mode = Baked 或 Mixed）。

**Lightmap UV 设置：**
```
模型 Inspector → Generate Lightmap UVs（开启）
或者：在 DCC 工具中手动制作第二套 UV（TEXCOORD1）
```

**在 Shader 中读取烘焙 GI（包含烘焙 AO）：**
```hlsl
// 顶点着色器中传递 Lightmap UV
OUTPUT_LIGHTMAP_UV(IN.uv2, unity_LightmapST, OUT.lightmapUV);
OUTPUT_SH(normalWS, OUT.vertexSH); // 球谐函数（无 Lightmap 时的低开销替代）

// 片元着色器中采样烘焙 GI
// SAMPLE_GI 宏根据是否有 Lightmap 自动选择采样方式
half3 bakedGI = SAMPLE_GI(IN.lightmapUV, IN.vertexSH, normalWS);
// bakedGI 包含烘焙的间接光照，其中已包含烘焙 AO 的影响
```

**贴图 AO 的使用：**
```hlsl
// 从材质 AO 贴图读取（通常存储在 RGB 贴图的 G 通道）
float bakedAO = SAMPLE_TEXTURE2D(_OcclusionMap, sampler_OcclusionMap, uv).g;
// 强度插值
float finalAO = lerp(1.0, bakedAO, _OcclusionStrength);
// 应用到环境光
half3 ambient = bakedGI * albedo * finalAO;
```

## 实时 AO vs 烘焙 AO：选择策略

| 场景类型 | 推荐方案 | 原因 |
|---------|---------|------|
| 移动端（低端硬件） | 仅贴图 AO | 无性能开销 |
| 移动端（中端+） | 烘焙 AO | 无实时开销，质量好 |
| PC/主机静态场景 | 烘焙 AO + SSAO | 静态精度高，动态物体有 SSAO |
| PC/主机动态场景 | SSAO + 贴图 AO | 动态物体需要实时 AO |
| 室内密闭场景 | 烘焙 AO（高采样） | 离线烘焙质量远超实时 SSAO |
| 开放世界 | SSAO（低质量）+ 烘焙 AO | 视野范围大，SSAO 高质量开销过大 |

## 完整示例：URP 洞穴/室内场景材质 Shader

SSAO + 烘焙 AO 双层叠加，适合表现洞穴、地牢等阴暗密闭场景：

```hlsl
Shader "Custom/URP/CaveMaterial"
{
    Properties
    {
        _BaseColor      ("Base Color",    Color) = (0.5, 0.45, 0.4, 1)
        _BaseMap        ("Albedo Map",    2D)    = "white" {}
        _BumpMap        ("Normal Map",    2D)    = "bump" {}
        _BumpScale      ("Normal Scale",  Range(0,2)) = 1.0
        _OcclusionMap   ("AO Map (G Ch)",  2D)   = "white" {}
        _OcclusionStrength ("AO Strength", Range(0,1)) = 0.8
        // 额外 AO 增强（洞穴暗部）
        _AOBoost        ("AO Boost",      Range(1,3)) = 1.5
        _Metallic       ("Metallic",      Range(0,1)) = 0.0
        _Smoothness     ("Smoothness",    Range(0,1)) = 0.15
        // 苔藓/潮湿效果（洞穴材质特有）
        _WetnessMask    ("Wetness Mask (R)", 2D) = "black" {}
        _WetnessStrength ("Wetness Strength", Range(0,1)) = 0.5
        _WetnessSmooth  ("Wetness Smoothness",Range(0,1)) = 0.8
        _WetnessColor   ("Wetness Color", Color) = (0.2, 0.35, 0.15, 1)
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
        }

        Pass
        {
            Name "CaveForward"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #pragma multi_compile _ _SHADOWS_SOFT
            // SSAO 关键字（URP 自动注入，在此声明以便 Shader 处理）
            #pragma multi_compile_fragment _ _SCREEN_SPACE_OCCLUSION
            // Lightmap（烘焙 AO 需要）
            #pragma multi_compile _ LIGHTMAP_ON
            #pragma multi_compile _ DIRLIGHTMAP_COMBINED
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/GlobalIllumination.hlsl"

            TEXTURE2D(_BaseMap);     SAMPLER(sampler_BaseMap);
            TEXTURE2D(_BumpMap);     SAMPLER(sampler_BumpMap);
            TEXTURE2D(_OcclusionMap);SAMPLER(sampler_OcclusionMap);
            TEXTURE2D(_WetnessMask); SAMPLER(sampler_WetnessMask);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BumpMap_ST;
                float4 _OcclusionMap_ST;
                float4 _WetnessMask_ST;
                float4 _BaseColor;
                float4 _WetnessColor;
                float  _BumpScale;
                float  _OcclusionStrength;
                float  _AOBoost;
                float  _Metallic;
                float  _Smoothness;
                float  _WetnessStrength;
                float  _WetnessSmooth;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
                float2 uv2        : TEXCOORD1;  // Lightmap UV
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS  : SV_POSITION;
                float2 uv           : TEXCOORD0;
                DECLARE_LIGHTMAP_OR_SH(lightmapUV, vertexSH, 1); // 烘焙 GI
                float3 positionWS   : TEXCOORD2;
                float3 normalWS     : TEXCOORD3;
                float3 tangentWS    : TEXCOORD4;
                float3 bitangentWS  : TEXCOORD5;
                float4 shadowCoord  : TEXCOORD6;
                float  fogFactor    : TEXCOORD7;
                float4 screenPos    : TEXCOORD8;  // SSAO 采样需要屏幕坐标
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                VertexPositionInputs posInputs    = GetVertexPositionInputs(IN.positionOS.xyz);
                VertexNormalInputs   normalInputs = GetVertexNormalInputs(IN.normalOS, IN.tangentOS);

                OUT.positionHCS  = posInputs.positionCS;
                OUT.positionWS   = posInputs.positionWS;
                OUT.normalWS     = normalInputs.normalWS;
                OUT.tangentWS    = normalInputs.tangentWS;
                OUT.bitangentWS  = normalInputs.bitangentWS;
                OUT.uv           = TRANSFORM_TEX(IN.uv, _BaseMap);
                OUT.shadowCoord  = GetShadowCoord(posInputs);
                OUT.fogFactor    = ComputeFogFactor(posInputs.positionCS.z);
                OUT.screenPos    = ComputeScreenPos(posInputs.positionCS);

                // 烘焙 GI（包含 Lightmap UV 或 SH 球谐）
                OUTPUT_LIGHTMAP_UV(IN.uv2, unity_LightmapST, OUT.lightmapUV);
                OUTPUT_SH(normalInputs.normalWS, OUT.vertexSH);

                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.uv;

                // ===== 1. 基础贴图 =====
                half4 albedo = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, uv) * _BaseColor;

                // ===== 2. 法线 =====
                float4 normalPacked = SAMPLE_TEXTURE2D(_BumpMap, sampler_BumpMap, uv);
                float3 normalTS = UnpackNormalScale(normalPacked, _BumpScale);
                float3x3 TBN = float3x3(normalize(IN.tangentWS), normalize(IN.bitangentWS), normalize(IN.normalWS));
                float3 normalWS = normalize(TransformTangentToWorld(normalTS, TBN));

                // ===== 3. 潮湿效果（洞穴积水区域）=====
                float wetness = SAMPLE_TEXTURE2D(_WetnessMask, sampler_WetnessMask, uv).r * _WetnessStrength;
                // 潮湿使材质颜色向苔藓绿偏移，并增加光滑度（水膜效果）
                albedo.rgb = lerp(albedo.rgb, albedo.rgb * _WetnessColor.rgb, wetness * 0.5);
                float smoothness = lerp(_Smoothness, _WetnessSmooth, wetness);

                // ===== 4. 贴图 AO =====
                float texAO = SAMPLE_TEXTURE2D(_OcclusionMap, sampler_OcclusionMap, uv).g;
                float combinedAO = lerp(1.0, texAO, _OcclusionStrength);

                // ===== 5. SSAO（屏幕空间 AO）=====
                float2 screenUV = IN.screenPos.xy / IN.screenPos.w;
                #if defined(_SCREEN_SPACE_OCCLUSION)
                    // SampleAmbientOcclusion：采样 URP 生成的 SSAO 纹理
                    float ssao = SampleAmbientOcclusion(screenUV);
                    // 叠加两种 AO（相乘增强暗部，洞穴场景适用）
                    combinedAO = combinedAO * lerp(1.0, ssao, 0.7);
                #endif

                // AO 增强（洞穴的 AO 应该更强烈）
                combinedAO = pow(combinedAO, _AOBoost);

                // ===== 6. 烘焙 GI =====
                half3 bakedGI = SAMPLE_GI(IN.lightmapUV, IN.vertexSH, normalWS);
                // 对烘焙 GI 应用贴图 AO（纠正 Lightmap 精度不足的问题）
                bakedGI *= combinedAO;

                // ===== 7. PBR 光照计算 =====
                SurfaceData surfaceData;
                surfaceData.albedo          = albedo.rgb;
                surfaceData.alpha           = albedo.a;
                surfaceData.metallic        = _Metallic;
                surfaceData.smoothness      = smoothness;
                surfaceData.normalTS        = normalTS;
                surfaceData.occlusion       = combinedAO; // 传递叠加后的 AO
                surfaceData.emission        = 0;
                surfaceData.specular        = 0;
                surfaceData.clearCoatMask   = 0;
                surfaceData.clearCoatSmoothness = 0;

                InputData inputData;
                inputData.positionWS                = IN.positionWS;
                inputData.normalWS                  = normalWS;
                inputData.viewDirectionWS           = normalize(GetCameraPositionWS() - IN.positionWS);
                inputData.shadowCoord               = IN.shadowCoord;
                inputData.fogCoord                  = IN.fogFactor;
                inputData.vertexLighting            = 0;
                inputData.bakedGI                   = bakedGI;  // 使用 AO 调整后的 GI
                inputData.normalizedScreenSpaceUV   = screenUV;
                inputData.shadowMask                = SAMPLE_SHADOWMASK(IN.lightmapUV);

                // URP 标准 PBR（UniversalFragmentPBR 内部读取 _ScreenSpaceOcclusionTexture）
                half4 color = UniversalFragmentPBR(inputData, surfaceData);
                color.rgb = MixFog(color.rgb, IN.fogFactor);

                return color;
            }
            ENDHLSL
        }

        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        UsePass "Universal Render Pipeline/Lit/DepthOnly"
        UsePass "Universal Render Pipeline/Lit/DepthNormals"
    }
}
```

## Bent Normal AO 与 GTAO 简介

**Bent Normal AO：**
普通 AO 只是一个标量（0~1），告诉我们遮蔽程度。Bent Normal 是一个方向向量，表示"法线半球中最少被遮蔽的平均方向"。用 Bent Normal 代替 Surface Normal 采样环境光贴图（IBL），可以获得更准确的间接光照遮蔽效果。

Unity Enlighten（旧版烘焙）可以烘焙 Bent Normal；HDRP 支持 Bent Normal AO，URP 目前不原生支持，需要自定义实现。

**GTAO（Ground Truth Ambient Occlusion）：**
URP 2022 LTS 开始提供 GTAO 作为 SSAO 的替代方案（通过 `Screen Space Ambient Occlusion` Renderer Feature 的 `Method` 选项）。GTAO 相比传统 SSAO：
- 更少的 halo 伪影（SSAO 在薄物体边缘常见的光晕）
- 更精确的能量守恒
- 对移动端更友好（虽然采样数相同，但噪声更少）

## ShaderGraph 中的 AO

ShaderGraph 中访问 AO 的节点：
1. `Ambient Occlusion` 节点：自动读取 SSAO（如果启用）或返回 1
2. `Sample Texture 2D` → 接 Occlusion Map → `Lerp(1, ao, strength)` → 贴图 AO
3. 将上述结果乘以 `Ambient` 输出或接入 `Occlusion` 端口（在 `PBR Master` 节点）

## 移动端 AO 最佳实践

**推荐方案（按性能排序）：**

1. **仅贴图 AO**（最快）：将美术制作的 AO 贴图存入材质的 G 通道，直接乘以间接光
2. **烘焙 AO（Lightmap）**：预计算阶段消耗，运行时只是一次纹理采样
3. **SSAO 低质量（4 次采样，半分辨率）**：约 0.5-1ms，可在中端移动端使用
4. **SSAO 中等质量（8 次采样，全分辨率）**：约 1.5-2ms，仅 PC/主机推荐

**移动端完全禁用 SSAO 时：**
确保 Shader 中的 `#pragma multi_compile_fragment _ _SCREEN_SPACE_OCCLUSION` 声明正确，URP 会在 SSAO Feature 不存在时不定义 `_SCREEN_SPACE_OCCLUSION`，Shader 中的 SSAO 采样代码自动跳过（零开销）。

## 常见踩坑

1. **SSAO 在 HDR 场景下过暗**：SSAO 在线性空间计算，当场景有强烈 HDR 光照时，AO 叠加可能导致环境光区域过黑。调低 `Intensity` 并配合 `Falloff Distance` 限制 SSAO 影响范围。

2. **烘焙 AO 在动态物体上无效**：Lightmap AO 只对静态物体有效（需要勾选 `Static` 标志）。动态角色/物件需要用 SSAO 或贴图 AO。

3. **DepthNormals Pass 缺失导致 SSAO 质量下降**：URP SSAO 的 `Source` 设置为 `Depth Normals` 时，需要 `DepthNormals` Pass。如果自定义 Shader 没有 `DepthNormals` Pass，该物体的 SSAO 法线数据缺失，会产生 halo 伪影。`UsePass "Universal Render Pipeline/Lit/DepthNormals"` 是最简单的解决方案。

4. **Lightmap UV 缝隙处出现 AO 泄漏**：Lightmap UV 的相邻 UV 岛之间需要足够的间距（建议 ≥ 2 Lightmap 像素），否则烘焙时光照/遮蔽信息会从一个 UV 岛泄漏到另一个。在 Unity Lightmap Settings 中增加 `Lightmap Padding`。

5. **`SampleAmbientOcclusion` 在编辑器 Scene View 中始终返回 1**：SSAO 在 Scene View 中默认不激活（只在 Game View 中工作）。如果想在 Scene View 中也看到 SSAO，在 Scene View 的 Camera 组件上确认启用了后处理（`Post Processing` 勾选）。

## 系列总结

经过这十篇文章，我们已经建立了完整的 Unity URP Shader 知识体系：

1. **2D SDF UI Shader** → 圆角矩形、血条、技能 CD 遮罩
2. **程序化噪声** → FBM 火焰特效、域扭曲、程序化材质
3. **矩阵变换体系** → 坐标空间链、顶点动画草地
4. **纹理采样** → TEXTURE2D/SAMPLER、水面双层法线
5. **颜色管理** → Linear/Gamma 工作流、后处理赛博朋克效果
6. **3D SDF 应用** → URP 体积雾、软粒子深度融合
7. **法线体系** → TBN 矩阵、UnpackNormal、陡峭视差贴图
8. **URP 光照系统** → BRDFData、卡通渲染、各向异性布料
9. **URP 阴影** → CSM、PCF 软阴影、植被顶点动画 + 正确阴影
10. **URP AO** → SSAO Renderer Feature、烘焙 AO、洞穴双层 AO 材质

这十个技术模块覆盖了 Unity 游戏开发中 Shader 编程的核心领域。从 UI 特效到 3D 材质，从程序化特效到物理正确的 PBR 光照，每个模块都包含可直接运行于 Unity 项目的完整 Shader 代码。接下来可以深入研究 URP 的更多进阶特性：自定义渲染流程（Scriptable Render Pass）、GPU Skinning、计算着色器（Compute Shader）等。
