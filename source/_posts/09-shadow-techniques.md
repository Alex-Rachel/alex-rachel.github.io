---
title: Unity Shader 系列（九）：URP 阴影系统完整指南 — CSM、PCF 软阴影与植被 Shader
date: 2026-04-10 12:00:00
tags: [HLSL, URP, 阴影, Shadow Map, CSM, PCF软阴影]
---

## URP Shadow Map 工作原理

URP 的阴影系统基于 **Cascaded Shadow Maps（CSM，级联阴影贴图）**，这是现代游戏引擎处理大场景阴影的标准方案。

**为什么需要 CSM？**

单张 Shadow Map 需要覆盖整个可视范围。对于 100 米视距的场景，近处 1 米内的阴影和 100 米外的阴影共用同一张 Shadow Map，近处精度严重不足（每个 Shadow Map 纹素对应 1 米×1 米的地面区域，近处锯齿明显）。

**CSM 解决方案：**
将视锥体沿深度方向分割成多个子视锥（默认 4 个 Cascade），每个子视锥有独立的 Shadow Map，近处 Cascade 覆盖范围小（精度高），远处 Cascade 覆盖范围大（精度低）：

```
相机 → [Cascade 0: 0-10m] → [Cascade 1: 10-30m] → [Cascade 2: 30-60m] → [Cascade 3: 60-100m]
         高精度阴影            中等精度             较低精度               远处阴影
```

**URP 中的 CSM 配置：**
- URP Asset → Shadows → Max Distance（最大距离）
- Cascade Count（级联数量：1-4，移动端推荐 2，PC 推荐 4）
- Shadow Resolution（阴影贴图分辨率：512~4096）

## URP Shader 中采样阴影

### 在顶点着色器中计算阴影坐标

```hlsl
// 顶点着色器中计算阴影坐标（标准写法）
VertexPositionInputs posInputs = GetVertexPositionInputs(IN.positionOS.xyz);
// GetShadowCoord 内部根据是否启用 CSM 选择正确的 Shadow Map 层
OUT.shadowCoord = GetShadowCoord(posInputs);

// 如果使用 _MAIN_LIGHT_SHADOWS_SCREEN（屏幕空间阴影），
// 则 shadowCoord 存储的是屏幕 UV，在 Fragment 中用屏幕坐标采样
```

### 在片元着色器中使用阴影

```hlsl
// 方式一：通过 GetMainLight 直接获取（推荐，处理了 CSM 层级选择）
Light mainLight = GetMainLight(IN.shadowCoord);
float shadow = mainLight.shadowAttenuation; // 0 = 完全阴影，1 = 完全受光

// 方式二：手动采样（用于自定义阴影效果）
// 需要先确定用哪个 Cascade
half cascadeIndex = ComputeCascadeIndex(IN.positionWS);
float4 shadowCoord = mul(_MainLightWorldToShadow[cascadeIndex], float4(IN.positionWS, 1.0));
float shadow = MainLightRealtimeShadow(shadowCoord);

// 方式三：屏幕空间阴影（当启用 Screen Space Shadow 时）
// #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_SCREEN
float4 screenShadowCoord = IN.screenPos; // 来自顶点着色器
float shadow = SampleScreenSpaceShadowmap(screenShadowCoord);
```

### 关键编译关键字

```hlsl
// 必须在 Shader 中声明这些关键字，否则阴影不生效
#pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
// _MAIN_LIGHT_SHADOWS:          硬阴影（1 个 Cascade）
// _MAIN_LIGHT_SHADOWS_CASCADE:  CSM（多个 Cascade）
// _MAIN_LIGHT_SHADOWS_SCREEN:   屏幕空间阴影

// 软阴影
#pragma multi_compile _ _SHADOWS_SOFT

// 额外光源阴影
#pragma multi_compile _ _ADDITIONAL_LIGHT_SHADOWS
```

## PCF 软阴影原理

**PCF（Percentage-Closer Filtering）**不是模糊阴影贴图，而是对同一个像素进行多次 Shadow Map 深度比较，然后对比较结果求平均。每次比较都是 0 或 1（阴影/不阴影），平均后得到 [0,1] 的软过渡。

URP 内置的 PCF 实现使用 **Poisson Disk** 采样（泊松盘采样），保证采样点尽可能均匀分布：

```hlsl
// URP 内置 PCF 软阴影（来自 Shadows.hlsl，在 GetMainLight 中自动调用）
// 当定义了 _SHADOWS_SOFT 时，使用 PCF 3×3 或 PCF 5×5 采样
// 可在 URP Asset → Shadows → Soft Shadows Quality 中选择质量级别：
// Low = PCF 3x3（9 次采样）
// Medium = PCF 5x5（25 次采样）
// High = PCSS（物理正确软阴影，开销大）
```

## 完整示例：支持自阴影的 URP 植被 Shader

顶点动画 + 正确阴影的完整植被 Shader，包含 ForwardLit Pass 和 ShadowCaster Pass：

```hlsl
Shader "Custom/URP/Vegetation"
{
    Properties
    {
        _BaseColor      ("Base Color",    Color)  = (0.3, 0.7, 0.2, 1.0)
        _BaseMap        ("Albedo Texture",2D)     = "white" {}
        // Alpha Clip（树叶透明部分裁剪）
        _Cutoff         ("Alpha Cutoff",  Range(0,1)) = 0.5
        // 顶点动画
        _WindDirection  ("Wind Direction",Vector) = (1, 0, 0.3, 0)
        _WindSpeed      ("Wind Speed",    Range(0,5))  = 1.5
        _WindStrength   ("Wind Strength", Range(0,0.5)) = 0.1
        _WindFrequency  ("Wind Frequency",Range(0.5,10)) = 2.0
        // 植被特有：底部固定，顶部飘动（顶点颜色 R 通道作为弯曲权重）
        // 如果模型没有顶点颜色，用 UV.y 替代
        [Toggle(_USE_VERTEX_COLOR_WEIGHT)] _UseVertexColor ("Use Vertex Color Weight", Float) = 0
        // 双面渲染（树叶需要）
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull Mode", Float) = 0
        // 阴影偏移（防止自阴影 acne）
        _ShadowBias     ("Shadow Depth Bias", Range(0, 0.1)) = 0.01
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "TransparentCutout"  // Alpha Clip 使用 TransparentCutout
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "AlphaTest"
        }

        Cull [_Cull]

        Pass
        {
            Name "VegetationForward"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature_local _USE_VERTEX_COLOR_WEIGHT

            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #pragma multi_compile _ _SHADOWS_SOFT
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BaseColor;
                float4 _WindDirection;
                float  _Cutoff;
                float  _WindSpeed;
                float  _WindStrength;
                float  _WindFrequency;
                float  _ShadowBias;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR;  // 顶点颜色（R通道 = 弯曲权重）
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                float3 positionWS  : TEXCOORD1;
                float3 normalWS    : TEXCOORD2;
                float4 shadowCoord : TEXCOORD3;
                float  fogFactor   : TEXCOORD4;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== 植被顶点动画 ========
            float3 computeVegetationWind(float3 posWS, float bendWeight)
            {
                float3 windDir = normalize(_WindDirection.xyz);
                float time = _Time.y * _WindSpeed;

                // 主波 + 湍流（模拟自然风的不规律性）
                float phase = dot(posWS.xz, windDir.xz) * _WindFrequency;
                float wave   = sin(time + phase);
                float turb   = sin(time * 2.3 + phase * 0.7) * 0.4
                             + sin(time * 4.1 + phase * 1.3) * 0.15;

                float totalWave = (wave + turb) * _WindStrength * bendWeight;

                // 横向弯曲（沿风向方向）
                float3 offset = windDir * totalWave;

                // 保持顶点在地面上（约束 Y 轴位移，防止浮空）
                // 用球形投影近似：偏移后重新映射到固定半径的球面
                // 简化版：限制 Y 轴上升
                offset.y = -abs(offset.x + offset.z) * 0.1;

                return offset;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                // 确定弯曲权重（优先使用顶点颜色 R 通道，否则用 UV.y）
                #ifdef _USE_VERTEX_COLOR_WEIGHT
                    float bendWeight = IN.color.r;
                #else
                    float bendWeight = IN.uv.y;
                #endif

                // 对象空间 → 世界空间
                float3 posWS = TransformObjectToWorld(IN.positionOS.xyz);

                // 应用顶点动画
                posWS += computeVegetationWind(posWS, bendWeight);

                // 世界空间 → 裁剪空间
                OUT.positionHCS = TransformWorldToHClip(posWS);
                OUT.positionWS  = posWS;
                OUT.normalWS    = TransformObjectToWorldNormal(IN.normalOS);
                OUT.uv          = TRANSFORM_TEX(IN.uv, _BaseMap);

                // 阴影坐标（基于动画后的世界坐标）
                // 重要：使用动画后的 posWS 而非原始坐标
                float4 posCS = TransformWorldToHClip(posWS);
                OUT.shadowCoord = TransformWorldToShadowCoord(posWS);
                OUT.fogFactor   = ComputeFogFactor(posCS.z);

                return OUT;
            }

            half4 frag(Varyings IN, bool isFrontFace : SV_IsFrontFace) : SV_Target
            {
                half4 albedo = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv) * _BaseColor;

                // Alpha Clip（透明度裁剪，树叶常用）
                clip(albedo.a - _Cutoff);

                // 双面法线（背面翻转）
                float3 normalWS = normalize(IN.normalWS);
                normalWS = isFrontFace ? normalWS : -normalWS;

                // 主光源（含阴影）
                Light mainLight = GetMainLight(IN.shadowCoord);
                float NdotL = saturate(dot(normalWS, mainLight.direction));
                // Half-Lambert（植被通常有次表面散射，用 Half-Lambert 更自然）
                float halfLambert = NdotL * 0.5 + 0.5;

                half3 diffuse = albedo.rgb * mainLight.color
                              * halfLambert
                              * mainLight.shadowAttenuation;

                // 环境光
                half3 ambient = SampleSH(normalWS) * albedo.rgb * 0.4;

                // 额外光源（简化）
                half3 addLighting = 0;
                #ifdef _ADDITIONAL_LIGHTS
                    uint count = GetAdditionalLightsCount();
                    for (uint i = 0; i < count; i++)
                    {
                        Light light = GetAdditionalLight(i, IN.positionWS);
                        float addNdotL = saturate(dot(normalWS, light.direction)) * 0.5 + 0.5;
                        addLighting += albedo.rgb * light.color * addNdotL * light.distanceAttenuation * 0.5;
                    }
                #endif

                half3 finalColor = diffuse + ambient + addLighting;
                finalColor = MixFog(finalColor, IN.fogFactor);

                return half4(finalColor, 1.0); // Alpha Clip 后 Alpha 固定为 1
            }
            ENDHLSL
        }

        // ===== ShadowCaster Pass（植被阴影正确性关键）=====
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }

            ZWrite On
            ZTest LEqual
            ColorMask 0
            Cull [_Cull]

            HLSLPROGRAM
            #pragma vertex vertShadow
            #pragma fragment fragShadow
            #pragma multi_compile_instancing
            #pragma shader_feature_local _USE_VERTEX_COLOR_WEIGHT

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BaseColor;
                float4 _WindDirection;
                float  _Cutoff;
                float  _WindSpeed;
                float  _WindStrength;
                float  _WindFrequency;
                float  _ShadowBias;
            CBUFFER_END

            // 在 CBUFFER 外声明（URP 注入的光源方向，用于阴影偏移）
            float3 _LightDirection;
            float3 _LightPosition;

            struct ShadowAttributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct ShadowVaryings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            float3 computeVegetationWind(float3 posWS, float bendWeight)
            {
                float3 windDir = normalize(_WindDirection.xyz);
                float time = _Time.y * _WindSpeed;
                float phase = dot(posWS.xz, windDir.xz) * _WindFrequency;
                float wave = sin(time + phase) + sin(time * 2.3 + phase * 0.7) * 0.4;
                float3 offset = windDir * wave * _WindStrength * bendWeight;
                offset.y = -abs(offset.x + offset.z) * 0.1;
                return offset;
            }

            // 计算阴影裁剪空间坐标（含偏移处理）
            float4 getShadowPositionHClip(float3 posWS, float3 normalWS)
            {
                // ApplyShadowBias：添加阴影偏移防止 shadow acne
                // _LightDirection：当前渲染的光源方向（URP 自动传入）
                float3 adjustedPos = ApplyShadowBias(posWS, normalWS, _LightDirection);
                float4 posHCS = TransformWorldToHClip(adjustedPos);

                // 点光源/聚光灯的额外偏移处理
                #if UNITY_REVERSED_Z
                    posHCS.z = min(posHCS.z, posHCS.w * UNITY_NEAR_CLIP_VALUE);
                #else
                    posHCS.z = max(posHCS.z, posHCS.w * UNITY_NEAR_CLIP_VALUE);
                #endif

                return posHCS;
            }

            ShadowVaryings vertShadow(ShadowAttributes IN)
            {
                ShadowVaryings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                #ifdef _USE_VERTEX_COLOR_WEIGHT
                    float bendWeight = IN.color.r;
                #else
                    float bendWeight = IN.uv.y;
                #endif

                float3 posWS = TransformObjectToWorld(IN.positionOS.xyz);
                // ShadowCaster Pass 同样需要顶点动画！否则阴影形状与植被不匹配
                posWS += computeVegetationWind(posWS, bendWeight);

                float3 normalWS = TransformObjectToWorldNormal(IN.normalOS);
                OUT.positionHCS = getShadowPositionHClip(posWS, normalWS);
                OUT.uv = TRANSFORM_TEX(IN.uv, _BaseMap);
                return OUT;
            }

            half4 fragShadow(ShadowVaryings IN) : SV_Target
            {
                // Alpha Clip（树叶需要在阴影 Pass 中也裁剪透明部分）
                half4 albedo = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv) * _BaseColor;
                clip(albedo.a - _Cutoff);
                return 0;
            }
            ENDHLSL
        }

        // DepthOnly Pass（SSAO 等深度效果需要）
        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }
            ZWrite On
            ColorMask R
            Cull [_Cull]

            HLSLPROGRAM
            #pragma vertex vertDepth
            #pragma fragment fragDepth
            #pragma multi_compile_instancing
            #pragma shader_feature_local _USE_VERTEX_COLOR_WEIGHT

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BaseColor;
                float4 _WindDirection;
                float  _Cutoff;
                float  _WindSpeed;
                float  _WindStrength;
                float  _WindFrequency;
                float  _ShadowBias;
            CBUFFER_END

            struct DepthAttributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct DepthVaryings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            float3 computeVegetationWind(float3 posWS, float bendWeight)
            {
                float3 windDir = normalize(_WindDirection.xyz);
                float time = _Time.y * _WindSpeed;
                float phase = dot(posWS.xz, windDir.xz) * _WindFrequency;
                float wave = sin(time + phase);
                return windDir * wave * _WindStrength * bendWeight;
            }

            DepthVaryings vertDepth(DepthAttributes IN)
            {
                DepthVaryings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);
                #ifdef _USE_VERTEX_COLOR_WEIGHT
                    float bendWeight = IN.color.r;
                #else
                    float bendWeight = IN.uv.y;
                #endif
                float3 posWS = TransformObjectToWorld(IN.positionOS.xyz);
                posWS += computeVegetationWind(posWS, bendWeight);
                OUT.positionHCS = TransformWorldToHClip(posWS);
                OUT.uv = TRANSFORM_TEX(IN.uv, _BaseMap);
                return OUT;
            }

            half fragDepth(DepthVaryings IN) : SV_Target
            {
                half4 albedo = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv) * _BaseColor;
                clip(albedo.a - _Cutoff);
                return 0;
            }
            ENDHLSL
        }
    }
}
```

## 阴影接收与投射的配置关系

| 功能 | Pass 名称 | 所需关键字 |
|------|----------|----------|
| 接收主光源阴影 | ForwardLit | `_MAIN_LIGHT_SHADOWS`/`_CASCADE` |
| 投射阴影 | ShadowCaster | 无特殊关键字 |
| 接收额外光源阴影 | ForwardLit | `_ADDITIONAL_LIGHT_SHADOWS` |
| 软阴影 | ForwardLit | `_SHADOWS_SOFT` |
| 屏幕空间阴影 | ForwardLit | `_MAIN_LIGHT_SHADOWS_SCREEN` |

## ShaderGraph 阴影接收配置

ShaderGraph 中的阴影处理已内置，无需手动配置，但需要注意：
1. 在 `Graph Settings` 中确保 `Receive Shadows` 开启
2. 如果材质是 `Alpha Clip`，ShaderGraph 会自动生成带 Alpha Clip 的 ShadowCaster Pass
3. 顶点动画需要在 `Vertex Stage` 中实现，并在 ShadowCaster Pass 中也生效（ShaderGraph 自动处理）

## 性能考量

| 配置 | 性能影响 |
|------|---------|
| CSM 4 级联（PC） | 额外 4 次深度渲染 pass |
| CSM 2 级联（移动端） | 额外 2 次深度渲染 pass |
| PCF 软阴影 High | 片元着色器 ×25 次采样（PCSS 更多） |
| PCF 软阴影 Low | 片元着色器 ×9 次采样 |
| Alpha Clip + ShadowCaster | 每个透明 mesh 额外一次渲染 |

**植被阴影优化：**
- 远处植被可以关闭 `Receive Shadows`（LOD 切换后的低 poly 版本）
- 使用 `Shadow Distance Fade`（在 URP Asset 中设置 Cascade 最远距离）
- 批量相同材质的植被用 GPU Instancing（`#pragma multi_compile_instancing`）

## 常见踩坑

1. **ShadowCaster Pass 遗漏顶点动画**：这是最常见的 bug。植被在风中飘动，但阴影不动。确保 ShadowCaster Pass 的顶点着色器包含**完全相同**的风力计算代码。

2. **Shadow Acne（阴影噪点/自阴影）**：表面接收自身阴影时产生锯齿状黑点。解决方案：`ApplyShadowBias` 函数中调整 Depth Bias 和 Normal Bias（在 URP Asset → Shadows 中全局设置，或在 ShadowCaster Pass 中手动设置 `_ShadowBias`）。

3. **Alpha Clip 植被没有 Shadow**：必须在 ShadowCaster Pass 的 fragShadow 中也执行 `clip(albedo.a - _Cutoff)`，否则树叶的透明区域会产生方形阴影。

4. **CSM 级联边界阴影跳跃**：当相机移动时，相邻 Cascade 边界处阴影精度不同，会产生可见的过渡线。解决方案：在 URP Asset → Shadows 中开启 `Shadow Cascade Blend`（Softening）。

5. **点光源/聚光灯的 ShadowCaster**：`_LightDirection` 变量对平行光有效，点光源/聚光灯需要使用 `_LightPosition` 并在 Pass 中添加 `#pragma multi_compile_shadowcaster` 才能正确处理。

下一篇文章（系列最后一篇）将讲解 URP 的 AO（环境光遮蔽）技术全景：SSAO Renderer Feature、烘焙 AO 的正确使用，以及如何在 Shader 中叠加多种 AO 效果。
