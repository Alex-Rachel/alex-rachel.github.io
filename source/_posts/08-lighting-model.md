---
title: Unity Shader 系列（八）：URP 光照系统深度解析 — PBR、卡通渲染与 BRDF
date: 2026-04-01 10:10:00
tags: [HLSL, URP, PBR光照, 卡通渲染, BRDF]
categories:
  - Unity Shader 系列
  - 光照与阴影
---

## URP ForwardLit Pass 光照流程

在写自定义光照 Shader 之前，先理解 URP 内置 `Lit.shader` 的 ForwardLit Pass 是如何工作的：

```
片元着色器入口
    ↓
1. 解码法线（UnpackNormal）
2. 计算 BRDFData（InitializeBRDFData）
    - 将 Metallic/Smoothness 转为 diffuse/specular/roughness
3. 计算 InputData（viewDir、positionWS 等）
4. GetMainLight() + TransformWorldToShadowCoord()
5. LightingPhysicallyBased(brdfData, mainLight, normalWS, viewDirWS)
    - Lambert 漫反射
    - Cook-Torrance GGX 镜面反射（D * F * V）
6. 遍历额外光源（GetAdditionalLight × N）
7. 加入 GlobalIllumination（GI/Lightmap/SH）
8. 加入自发光（Emission）
9. 混合雾效
    ↓
输出最终颜色
```

## BRDFData 结构体深度解析

`BRDFData` 是 URP 光照计算的核心数据结构：

```hlsl
// URP 内部 BRDFData 结构（来自 Lighting.hlsl）
struct BRDFData
{
    half3 diffuse;          // 漫反射颜色 = albedo × (1 - metallic)
    half3 specular;         // 镜面反射颜色 = lerp(0.04, albedo, metallic)
    half  perceptualRoughness; // 粗糙度（0=光滑, 1=粗糙）
    half  roughness;        // perceptualRoughness²（GGX 中使用）
    half  roughness2;       // roughness²
    half  grazingTerm;      // 掠射角 Fresnel 项
    half  normalizationTerm; // GGX 中的归一化项
    half  roughness2MinusOne; // roughness² - 1（GGX 优化）
};

// 初始化 BRDFData（从 albedo/metallic/smoothness 计算）
// 对应调用：
BRDFData brdfData;
InitializeBRDFData(albedo, metallic, specular, smoothness, alpha, brdfData);
// 注意：Unity 的 Smoothness = 1 - Roughness，传入时要注意方向
```

## 完整示例 1：URP 卡通渲染 Shader

色阶漫反射 + Rim Light + 描边效果：

```hlsl
Shader "Custom/URP/ToonShading"
{
    Properties
    {
        _BaseColor      ("Base Color",    Color)  = (1,1,1,1)
        _BaseMap        ("Base Texture",  2D)     = "white" {}
        // 色阶控制（卡通光照分级）
        _ShadowColor    ("Shadow Color",  Color)  = (0.4, 0.5, 0.7, 1)
        _ShadowThreshold ("Shadow Threshold", Range(0,1)) = 0.5
        _ShadowSmooth   ("Shadow Smooth", Range(0.001, 0.3)) = 0.05
        _HighlightColor ("Highlight Color", Color) = (1,1,1,1)
        _HighlightThreshold ("Highlight Threshold", Range(0,1)) = 0.9
        _HighlightSmooth ("Highlight Smooth", Range(0.001, 0.1)) = 0.02
        // Rim Light（边缘光）
        _RimColor       ("Rim Color",     Color)  = (0.5, 0.7, 1.0, 1)
        _RimPower       ("Rim Power",     Range(1, 8)) = 3.0
        _RimStrength    ("Rim Strength",  Range(0, 1)) = 0.4
        // 描边（通过法线扩展实现）
        _OutlineColor   ("Outline Color", Color)  = (0.1, 0.1, 0.15, 1)
        _OutlineWidth   ("Outline Width", Range(0, 0.05)) = 0.01
        // 法线贴图
        _BumpMap        ("Normal Map",    2D)     = "bump" {}
        _BumpScale      ("Normal Scale",  Range(0,2)) = 1.0
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Geometry"
        }

        // ===== Pass 1：描边 Pass（法线外扩）=====
        Pass
        {
            Name "Outline"
            // 只渲染背面（法线外扩后背面可见）
            Cull Front

            HLSLPROGRAM
            #pragma vertex vertOutline
            #pragma fragment fragOutline

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BaseColor;
                float4 _ShadowColor;
                float4 _HighlightColor;
                float4 _RimColor;
                float4 _OutlineColor;
                float  _ShadowThreshold;
                float  _ShadowSmooth;
                float  _HighlightThreshold;
                float  _HighlightSmooth;
                float  _RimPower;
                float  _RimStrength;
                float  _OutlineWidth;
                float  _BumpScale;
            CBUFFER_END

            struct OutlineAttributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct OutlineVaryings
            {
                float4 positionHCS : SV_POSITION;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            OutlineVaryings vertOutline(OutlineAttributes IN)
            {
                OutlineVaryings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                // 在对象空间沿法线方向外扩顶点
                float3 expandedPos = IN.positionOS.xyz + normalize(IN.normalOS) * _OutlineWidth;
                OUT.positionHCS = TransformObjectToHClip(expandedPos);
                return OUT;
            }

            half4 fragOutline(OutlineVaryings IN) : SV_Target
            {
                return _OutlineColor;
            }
            ENDHLSL
        }

        // ===== Pass 2：卡通光照 Pass =====
        Pass
        {
            Name "ToonForward"
            Tags { "LightMode" = "UniversalForward" }
            Cull Back

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
            TEXTURE2D(_BumpMap); SAMPLER(sampler_BumpMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BaseColor;
                float4 _ShadowColor;
                float4 _HighlightColor;
                float4 _RimColor;
                float4 _OutlineColor;
                float  _ShadowThreshold;
                float  _ShadowSmooth;
                float  _HighlightThreshold;
                float  _HighlightSmooth;
                float  _RimPower;
                float  _RimStrength;
                float  _OutlineWidth;
                float  _BumpScale;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                float3 positionWS  : TEXCOORD1;
                float3 normalWS    : TEXCOORD2;
                float3 tangentWS   : TEXCOORD3;
                float3 bitangentWS : TEXCOORD4;
                float4 shadowCoord : TEXCOORD5;
                float  fogFactor   : TEXCOORD6;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== 卡通色阶光照核心函数 ========

            // 将连续的 NdotL 值分级为离散的色阶
            float toonDiffuse(float NdotL, float threshold, float smooth)
            {
                // smoothstep 产生软边缘，模拟软阴影效果
                // 硬边缘：step(threshold, NdotL)
                return smoothstep(threshold - smooth, threshold + smooth, NdotL);
            }

            // 卡通高光（Toon Specular）
            float toonSpecular(float NdotH, float threshold, float smooth)
            {
                return smoothstep(threshold - smooth, threshold + smooth, NdotH);
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                VertexPositionInputs posInputs    = GetVertexPositionInputs(IN.positionOS.xyz);
                VertexNormalInputs   normalInputs = GetVertexNormalInputs(IN.normalOS, IN.tangentOS);

                OUT.positionHCS = posInputs.positionCS;
                OUT.positionWS  = posInputs.positionWS;
                OUT.normalWS    = normalInputs.normalWS;
                OUT.tangentWS   = normalInputs.tangentWS;
                OUT.bitangentWS = normalInputs.bitangentWS;
                OUT.uv          = TRANSFORM_TEX(IN.uv, _BaseMap);
                OUT.shadowCoord = GetShadowCoord(posInputs);
                OUT.fogFactor   = ComputeFogFactor(posInputs.positionCS.z);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // === 法线 ===
                float4 normalPacked = SAMPLE_TEXTURE2D(_BumpMap, sampler_BumpMap, IN.uv);
                float3 normalTS = UnpackNormalScale(normalPacked, _BumpScale);
                float3x3 TBN = float3x3(normalize(IN.tangentWS), normalize(IN.bitangentWS), normalize(IN.normalWS));
                float3 normalWS = normalize(TransformTangentToWorld(normalTS, TBN));

                // === 基础颜色 ===
                half4 baseColor = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv) * _BaseColor;

                // === 主光源（带阴影） ===
                Light mainLight = GetMainLight(IN.shadowCoord);
                float3 lightDir = mainLight.direction;
                float3 lightColor = mainLight.color;
                float shadowAttenuation = mainLight.shadowAttenuation;

                float3 viewDirWS = normalize(GetCameraPositionWS() - IN.positionWS);

                // NdotL（乘以阴影衰减，让阴影影响色阶分级）
                float NdotL = saturate(dot(normalWS, lightDir)) * shadowAttenuation;
                float3 halfDir = normalize(viewDirWS + lightDir);
                float NdotH = saturate(dot(normalWS, halfDir));

                // === 卡通漫反射（三色阶：高光/中间/阴影）===
                float toonDiff = toonDiffuse(NdotL, _ShadowThreshold, _ShadowSmooth);
                float toonSpec = toonSpecular(NdotH, _HighlightThreshold, _HighlightSmooth);

                // 颜色混合：阴影色 → 基础色 → 高光色
                half3 diffuseColor = lerp(_ShadowColor.rgb, baseColor.rgb, toonDiff);
                diffuseColor = lerp(diffuseColor, _HighlightColor.rgb, toonSpec);

                // 乘以光源颜色
                half3 litColor = diffuseColor * lightColor;

                // === Rim Light（边缘光）===
                float NdotV = saturate(dot(normalWS, viewDirWS));
                float rimFactor = pow(1.0 - NdotV, _RimPower);
                // Rim 只在亮面出现（背光面不加边缘光）
                rimFactor *= saturate(NdotL * 2.0);
                half3 rimLight = _RimColor.rgb * rimFactor * _RimStrength;
                litColor += rimLight;

                // === 额外光源（简化为 Lambert，保持卡通风格） ===
                #ifdef _ADDITIONAL_LIGHTS
                    uint additionalLightCount = GetAdditionalLightsCount();
                    for (uint i = 0; i < additionalLightCount; i++)
                    {
                        Light addLight = GetAdditionalLight(i, IN.positionWS);
                        float addNdotL = saturate(dot(normalWS, addLight.direction));
                        float addToon  = toonDiffuse(addNdotL * addLight.distanceAttenuation, _ShadowThreshold, _ShadowSmooth);
                        litColor += baseColor.rgb * addLight.color * addToon * 0.5;
                    }
                #endif

                // === 环境光（球谐函数）===
                half3 ambient = SampleSH(normalWS) * baseColor.rgb * 0.3;
                half3 finalColor = litColor + ambient;

                // 雾效
                finalColor = MixFog(finalColor, IN.fogFactor);

                return half4(finalColor, baseColor.a);
            }
            ENDHLSL
        }

        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        UsePass "Universal Render Pipeline/Lit/DepthOnly"
    }
}
```

## 完整示例 2：布料材质 Shader（各向异性 Kajiya-Kay）

```hlsl
Shader "Custom/URP/FabricAnisotropic"
{
    Properties
    {
        _BaseColor      ("Base Color",     Color)  = (0.5, 0.3, 0.1, 1)
        _BaseMap        ("Base Texture",   2D)     = "white" {}
        _FiberDirection ("Fiber Direction",Vector) = (0, 1, 0, 0)  // 纤维方向（切线空间）
        _SpecColor1     ("Specular Color 1",Color) = (1.0, 0.9, 0.8, 1)
        _Shift1         ("Spec Shift 1",   Range(-0.5, 0.5)) = 0.05
        _Roughness1     ("Roughness 1",    Range(0.01, 1))   = 0.15
        _SpecColor2     ("Specular Color 2",Color) = (0.7, 0.7, 0.9, 1)
        _Shift2         ("Spec Shift 2",   Range(-0.5, 0.5)) = -0.1
        _Roughness2     ("Roughness 2",    Range(0.01, 1))   = 0.35
        _BumpMap        ("Normal Map",     2D)     = "bump" {}
        _BumpScale      ("Normal Scale",   Range(0,2)) = 1.0
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }

        Pass
        {
            Name "FabricForward"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
            TEXTURE2D(_BumpMap); SAMPLER(sampler_BumpMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BaseColor;
                float4 _FiberDirection;
                float4 _SpecColor1;
                float4 _SpecColor2;
                float  _Shift1;
                float  _Shift2;
                float  _Roughness1;
                float  _Roughness2;
                float  _BumpScale;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                float3 positionWS  : TEXCOORD1;
                float3 normalWS    : TEXCOORD2;
                float3 tangentWS   : TEXCOORD3;
                float3 bitangentWS : TEXCOORD4;
                float4 shadowCoord : TEXCOORD5;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== Kajiya-Kay 各向异性高光 ========
            // T: 切线方向（纤维方向）
            // V: 视线方向
            // L: 光线方向
            // shift: 高光偏移（模拟纤维层的相位差）
            float KajiyaKaySpec(float3 T, float3 V, float3 L, float shift, float roughness)
            {
                // 偏移切线（模拟纤维的弯曲）
                float3 shiftedT = normalize(T + shift * cross(T, cross(T, L)));
                // 正弦投影：高光强度与光线和纤维方向的叉积有关
                float TdotL = dot(shiftedT, L);
                float TdotV = dot(shiftedT, V);
                float sinTL = sqrt(max(0, 1.0 - TdotL * TdotL));
                float sinTV = sqrt(max(0, 1.0 - TdotV * TdotV));
                // Kajiya-Kay BRDF
                float spec = sinTL * sinTV;
                // 用 roughness 控制高光宽度（类似 Blinn-Phong 的 shininess）
                spec = pow(max(0, spec), 1.0 / (roughness * roughness));
                return spec;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);
                VertexPositionInputs posInputs    = GetVertexPositionInputs(IN.positionOS.xyz);
                VertexNormalInputs   normalInputs = GetVertexNormalInputs(IN.normalOS, IN.tangentOS);
                OUT.positionHCS = posInputs.positionCS;
                OUT.positionWS  = posInputs.positionWS;
                OUT.normalWS    = normalInputs.normalWS;
                OUT.tangentWS   = normalInputs.tangentWS;
                OUT.bitangentWS = normalInputs.bitangentWS;
                OUT.uv          = TRANSFORM_TEX(IN.uv, _BaseMap);
                OUT.shadowCoord = GetShadowCoord(posInputs);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float3 tangentWS   = normalize(IN.tangentWS);
                float3 bitangentWS = normalize(IN.bitangentWS);
                float3 normalWS    = normalize(IN.normalWS);

                // 法线贴图
                float4 normalPacked = SAMPLE_TEXTURE2D(_BumpMap, sampler_BumpMap, IN.uv);
                float3 normalTS = UnpackNormalScale(normalPacked, _BumpScale);
                float3x3 TBN = float3x3(tangentWS, bitangentWS, normalWS);
                float3 bumpedNormal = normalize(TransformTangentToWorld(normalTS, TBN));

                // 纤维方向（在切线空间定义，变换到世界空间）
                float3 fiberDirTS = normalize(_FiberDirection.xyz);
                float3 fiberDirWS = normalize(mul(fiberDirTS, TBN));

                half4 albedo = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv) * _BaseColor;
                float3 viewDirWS = normalize(GetCameraPositionWS() - IN.positionWS);

                Light mainLight = GetMainLight(IN.shadowCoord);
                float NdotL = saturate(dot(bumpedNormal, mainLight.direction)) * mainLight.shadowAttenuation;

                // 漫反射（Lambert）
                half3 diffuse = albedo.rgb * mainLight.color * NdotL;

                // 各向异性高光（双层 Kajiya-Kay）
                float spec1 = KajiyaKaySpec(fiberDirWS, viewDirWS, mainLight.direction, _Shift1, _Roughness1);
                float spec2 = KajiyaKaySpec(fiberDirWS, viewDirWS, mainLight.direction, _Shift2, _Roughness2);
                half3 specular = _SpecColor1.rgb * spec1 + _SpecColor2.rgb * spec2;
                specular *= mainLight.color * NdotL;

                // 环境光
                half3 ambient = SampleSH(bumpedNormal) * albedo.rgb * 0.3;

                return half4(diffuse + specular + ambient, albedo.a);
            }
            ENDHLSL
        }
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
    }
}
```

## ShaderGraph 中实现卡通渲染

1. `Normal Vector` → `Dot Product(Light Direction)` → `Smoothstep(threshold-smooth, threshold+smooth)` → 色阶因子
2. `Lerp(Shadow Color, Base Color, 色阶因子)` → 分级颜色
3. `View Direction` → `Dot Product(Normal)` → `1 - result` → `Power(RimPower)` → Rim 遮罩
4. `Lerp(分级颜色, RimColor, Rim遮罩)` → 最终颜色

## 多光源处理最佳实践

```hlsl
// URP 额外光源循环（ForwardLit Pass 标准写法）
half3 additionalLighting = 0;
uint additionalLightCount = GetAdditionalLightsCount();
for (uint i = 0; i < additionalLightCount; i++)
{
    // 传入世界空间位置，自动计算距离衰减和聚光灯锥角衰减
    Light addLight = GetAdditionalLight(i, IN.positionWS);

    // addLight 包含：
    // - direction: 光线方向（已归一化）
    // - color: 光源颜色
    // - distanceAttenuation: 距离衰减（1/d²）
    // - shadowAttenuation: 阴影衰减（0~1）

    float addNdotL = saturate(dot(normalWS, addLight.direction));
    additionalLighting += albedo.rgb * addLight.color
                        * addNdotL
                        * addLight.distanceAttenuation
                        * addLight.shadowAttenuation;
}
```

## 性能考量

| 特性 | 移动端 | PC | 主机 |
|------|-------|----|----|
| 卡通色阶（smoothstep） | 极低 | 极低 | 极低 |
| 描边 Pass（额外 Cull Front Pass） | 增加 30-50% drawcall | 可接受 | 可接受 |
| Kajiya-Kay（布料各向异性） | 2 次额外 sqrt | 可接受 | 可接受 |
| 额外光源（4 盏） | 建议 Forward+ 或 减少灯数 | 可接受 | 可接受 |

**描边 Pass 优化：**
描边 Pass 的 `Cull Front` 方案在 GPU 上相当于多渲染一遍（但只渲染片元数极少的边缘区域）。移动端可改用后处理描边（基于深度梯度检测），开销更小。

## 常见踩坑

1. **卡通描边在非均匀缩放模型上错位**：法线外扩方法对非均匀 Scale 的模型会产生不均匀的描边宽度。解决方案：将 `_OutlineWidth` 改为在裁剪空间中做固定像素宽度的外扩，避免受模型缩放影响。

2. **卡通高光在移动时闪烁**：过于尖锐的 `smoothstep` 边缘在角色移动时会产生 aliasing 闪烁。将 `_HighlightSmooth` 设置大一些（0.05 以上），或在 Fragment Shader 中用 `fwidth(NdotH)` 做自适应平滑。

3. **`GetAdditionalLightsCount()` 在 Forward 渲染中超过限制**：URP Forward 渲染模式默认每对象最多 4 盏额外光源（可在 URP Asset 中调整）。超过限制的光源会被忽略。使用 `Forward+` 渲染模式可以处理更多光源。

4. **布料各向异性的 TBN 与模型 UV 不对齐**：Kajiya-Kay 高光效果高度依赖 UV 方向（决定切线方向）。如果布料高光出现在错误位置，检查 DCC 工具导出时的 UV 映射和切线计算设置。

下一篇文章将讲解 URP 阴影系统的完整实现——级联阴影贴图（CSM）、PCF 软阴影、以及植被 Shader 中顶点动画与阴影的正确配合。
