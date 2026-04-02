---
title: Unity Shader 系列（十七）：Unity 全局光照系统深度指南
date: 2026-04-01 11:40:00
tags: [HLSL, URP, 全局光照, 光照烘焙, GI]
categories:
  - Unity Shader 系列
  - 光照与阴影
---

全局光照（Global Illumination，GI）是让 3D 场景看起来真实的最重要因素——间接光、环境反射、颜色溢出，这些物理现象使场景有了深度和质感。Unity 提供了一套完整的 GI 系统，从静态光照烘焙到实时动态 GI，从 Light Probe 到自适应探针体（APV）。理解如何在 URP Shader 中正确读取和使用这些 GI 数据，是让自定义 Shader 融入真实感场景的关键。

## Unity GI 系统全景

Unity 的 GI 分为几个层次，选择哪种方案取决于项目的动态性要求和性能预算：

| GI 方案 | 适用对象 | 更新频率 | 主要开销 |
|---------|---------|---------|---------|
| Baked Lightmap | 静态物体 | 构建时烘焙 | 内存（纹理） |
| Light Probes | 动态物体（小型） | 实时插值 | CPU（插值） |
| Probe Volumes (APV) | 所有物体 | 实时/烘焙 | 内存 + GPU |
| DDGI (动态 GI) | 所有物体 | 实时更新 | GPU 计算 |
| Unity DXR Ray Tracing | PC/主机 | 实时光追 | GPU 极高 |

## Baked GI：Enlighten vs Progressive Lightmapper

**选择指南**：

```
Enlighten Baked GI（已弃用但仍可用）:
  适合: 快速迭代，实时模式下可用
  缺点: 精度较低，不支持自发光烘焙的精细控制

Progressive Lightmapper（当前推荐）:
  优点: 基于路径追踪，精确的软阴影、环境光遮蔽
  两种后端:
    - CPU Progressive: 速度慢，所有 GPU 都支持
    - GPU Progressive: 速度快（10-50x），需要 CUDA 支持
  
实际项目建议:
  - 开发阶段用低质量快速烘焙（Low Quality preset）
  - 发布前用 High Quality preset 进行最终烘焙
  - 启用 Prioritize View 让视野内的区域优先烘焙
```

**重要的 Lightmap UV 设置**：

```
Mesh Import Settings → Lightmap UVs:
  ✓ Generate Lightmap UVs（Unity 自动生成，适合大多数情况）
  
  如果自动生成效果不好：
  - 在 DCC 工具（Maya/Blender）中手动展开 UV2
  - 确保 UV2 没有重叠（使用 UV Checker 纹理验证）
  - 留出足够的 Texel 间距（建议 3-5 像素）
```

## 在 URP Shader 中集成 GI

要让自定义 URP Shader 正确接受 GI，需要在顶点和片段着色器中包含特定的 GI 相关代码：

```hlsl
Shader "Custom/URP/GI_Integrated_Shader"
{
    Properties
    {
        _BaseColor ("基础颜色", Color) = (1, 1, 1, 1)
        _MainTex ("主纹理", 2D) = "white" {}
        _Roughness ("粗糙度", Range(0, 1)) = 0.5
        _Metallic ("金属度", Range(0, 1)) = 0.0
        _OcclusionMap ("遮蔽贴图", 2D) = "white" {}
        _OcclusionStrength ("遮蔽强度", Range(0, 1)) = 1.0
        _EmissionMap ("自发光贴图", 2D) = "black" {}
        [HDR] _EmissionColor ("自发光颜色", Color) = (0, 0, 0, 0)
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
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            // GI 相关的编译宏（这些宏控制是否使用光照贴图、Light Probe 等）
            #pragma multi_compile _ LIGHTMAP_ON                          // 静态光照贴图
            #pragma multi_compile _ DYNAMICLIGHTMAP_ON                  // 动态光照贴图
            #pragma multi_compile _ DIRLIGHTMAP_COMBINED                // 方向性光照贴图
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS                 // 主光源阴影
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_CASCADE         // 级联阴影
            #pragma multi_compile _ _ADDITIONAL_LIGHTS                  // 额外光源
            #pragma multi_compile _ _SHADOWS_SOFT                       // 软阴影
            #pragma multi_compile _ LIGHTMAP_SHADOW_MIXING              // 光照贴图阴影混合
            #pragma multi_compile _ SHADOWS_SHADOWMASK                  // 阴影遮罩
            #pragma multi_compile_fog                                   // 场景雾

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            // 包含 GI 采样相关函数（SampleSH, SAMPLE_GI 等）
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/GlobalIllumination.hlsl"

            TEXTURE2D(_MainTex);       SAMPLER(sampler_MainTex);
            TEXTURE2D(_OcclusionMap);  SAMPLER(sampler_OcclusionMap);
            TEXTURE2D(_EmissionMap);   SAMPLER(sampler_EmissionMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _BaseColor;
                float  _Roughness;
                float  _Metallic;
                float4 _OcclusionMap_ST;
                float  _OcclusionStrength;
                float4 _EmissionMap_ST;
                float4 _EmissionColor;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS   : POSITION;
                float3 normalOS     : NORMAL;
                float4 tangentOS    : TANGENT;
                float2 uv           : TEXCOORD0;
                float2 lightmapUV   : TEXCOORD1;  // 光照贴图 UV（第二套 UV）
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS      : SV_POSITION;
                float3 worldPos         : TEXCOORD0;
                float3 worldNormal      : TEXCOORD1;
                float3 worldTangent     : TEXCOORD2;
                float3 worldBitangent   : TEXCOORD3;
                float2 uv               : TEXCOORD4;
                // 光照贴图 UV（使用 URP 的宏处理平台差异）
                DECLARE_LIGHTMAP_OR_SH(lightmapUV, vertexSH, 5);
                float4 shadowCoord      : TEXCOORD6;
                half4  fogFactor        : TEXCOORD7;
                UNITY_VERTEX_OUTPUT_STEREO  // VR 支持
            };

            Varyings vert(Attributes input)
            {
                Varyings output;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_TRANSFER_INSTANCE_ID(input, output);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);

                VertexPositionInputs posInputs = GetVertexPositionInputs(input.positionOS.xyz);
                VertexNormalInputs   norInputs = GetVertexNormalInputs(input.normalOS, input.tangentOS);

                output.positionHCS   = posInputs.positionCS;
                output.worldPos      = posInputs.positionWS;
                output.worldNormal   = norInputs.normalWS;
                output.worldTangent  = norInputs.tangentWS;
                output.worldBitangent = norInputs.bitangentWS;
                output.uv            = TRANSFORM_TEX(input.uv, _MainTex);
                output.shadowCoord   = GetShadowCoord(posInputs);

                // 关键：根据是否使用光照贴图，存储光照贴图 UV 或 SH 系数
                // OUTPUT_LIGHTMAP_UV：变换光照贴图 UV（考虑 Lightmap Scale/Offset）
                // OUTPUT_SH：预计算 SH 系数到顶点（减少片段着色器开销）
                OUTPUT_LIGHTMAP_UV(input.lightmapUV, unity_LightmapST, output.lightmapUV);
                OUTPUT_SH(norInputs.normalWS, output.vertexSH);

                output.fogFactor = ComputeFogFactor(posInputs.positionCS.z);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);

                float2 uv = input.uv;
                float3 worldPos = input.worldPos;

                // ---- 基础材质数据 ----
                half4 albedoAlpha = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv) * _BaseColor;
                half  occlusion   = lerp(1.0h, SAMPLE_TEXTURE2D(_OcclusionMap, sampler_OcclusionMap, uv).r,
                                        _OcclusionStrength);

                // ---- 法线（使用 TBN 矩阵转换到世界空间）----
                float3 worldNormal = normalize(input.worldNormal);
                // 此处可以接入法线贴图采样...

                // ---- 视线方向 ----
                float3 viewDir = normalize(GetCameraPositionWS() - worldPos);

                // ---- 关键：SAMPLE_GI 采样全局光照 ----
                // 这个宏会根据编译关键字自动选择：
                // - LIGHTMAP_ON：读取烘焙光照贴图
                // - 否则：读取 Light Probe SH（用顶点插值的 SH 系数）
                half3 bakedGI = SAMPLE_GI(input.lightmapUV, input.vertexSH, worldNormal);

                // ---- 间接光漫反射（GI 的漫反射部分）----
                // MixRealtimeAndBakedGI：混合实时 GI 和烘焙 GI，并处理阴影遮罩
                Light mainLight = GetMainLight(input.shadowCoord);
                MixRealtimeAndBakedGI(mainLight, worldNormal, bakedGI);
                half3 indirectDiffuse = bakedGI * albedoAlpha.rgb * (1.0h - _Metallic) * occlusion;

                // ---- 间接光镜面反射（GI 的镜面部分，读取反射探针）----
                half  perceptualRoughness = _Roughness;
                half3 reflectVector = reflect(-viewDir, worldNormal);
                // GlossyEnvironmentReflection：采样反射探针（考虑 roughness 的 mip 级别）
                half3 indirectSpecular = GlossyEnvironmentReflection(
                    reflectVector,
                    worldPos,
                    perceptualRoughness,
                    occlusion
                );

                // ---- 直接光 ----
                float NdotL = saturate(dot(worldNormal, mainLight.direction));
                half3 directDiffuse = albedoAlpha.rgb * mainLight.color * NdotL
                                    * mainLight.shadowAttenuation * (1.0h - _Metallic);

                // ---- 自发光（用于 GI 贡献烘焙时自动被识别）----
                half3 emission = SAMPLE_TEXTURE2D(_EmissionMap, sampler_EmissionMap, uv).rgb
                               * _EmissionColor.rgb;

                // ---- 组合所有光照 ----
                half3 finalColor = indirectDiffuse + indirectSpecular + directDiffuse + emission;

                // ---- 额外光源（点光、聚光）----
                #ifdef _ADDITIONAL_LIGHTS
                uint additionalLightCount = GetAdditionalLightsCount();
                for (uint i = 0u; i < additionalLightCount; i++)
                {
                    Light light = GetAdditionalLight(i, worldPos, half4(1, 1, 1, 1));
                    half NdotLAdd = saturate(dot(worldNormal, light.direction));
                    finalColor += albedoAlpha.rgb * light.color * NdotLAdd
                                * light.shadowAttenuation * light.distanceAttenuation;
                }
                #endif

                // ---- 场景雾 ----
                finalColor = MixFog(finalColor, input.fogFactor.x);

                return half4(finalColor, albedoAlpha.a);
            }
            ENDHLSL
        }

        // 标准 ShadowCaster 和 DepthOnly Pass（复用 URP 内置）
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        UsePass "Universal Render Pipeline/Lit/DepthOnly"

        // 自发光 GI 贡献 Pass（让 Unity 知道此 Shader 有自发光，用于 Realtime GI）
        Pass
        {
            Name "Meta"
            Tags { "LightMode" = "Meta" }
            Cull Off

            HLSLPROGRAM
            #pragma vertex MetaPassVertex
            #pragma fragment MetaPassFragment
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/MetaInput.hlsl"

            TEXTURE2D(_MainTex);    SAMPLER(sampler_MainTex);
            TEXTURE2D(_EmissionMap); SAMPLER(sampler_EmissionMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _BaseColor;
                float4 _EmissionMap_ST;
                float4 _EmissionColor;
                float  _Metallic;
            CBUFFER_END

            struct AttributesMeta { float4 positionOS : POSITION; float2 uv0 : TEXCOORD0; float2 uv1 : TEXCOORD1; };
            struct VaryingsMeta   { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; };

            VaryingsMeta MetaPassVertex(AttributesMeta input)
            {
                VaryingsMeta output;
                output.positionCS = MetaVertexPosition(input.positionOS, input.uv1, input.uv1,
                                                       unity_LightmapST, unity_DynamicLightmapST);
                output.uv = TRANSFORM_TEX(input.uv0, _MainTex);
                return output;
            }

            half4 MetaPassFragment(VaryingsMeta input) : SV_Target
            {
                MetaInput meta;
                meta.Albedo   = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.uv).rgb * _BaseColor.rgb;
                meta.Emission = SAMPLE_TEXTURE2D(_EmissionMap, sampler_EmissionMap, input.uv).rgb
                              * _EmissionColor.rgb;
                return MetaFragment(meta);
            }
            ENDHLSL
        }
    }
}
```

## Light Probes 与 Probe Volumes (APV)

**Light Probes** 是为动态物体（角色、车辆、可拾取道具）提供间接光的传统方案：

```csharp
// C# 中手动查询 Light Probe（用于自定义组件）
SphericalHarmonicsL2 sh;
LightProbes.GetInterpolatedProbe(transform.position, GetComponent<Renderer>(), out sh);

// 将 SH 系数传递给 Shader（低于 Unity 8.x，需要手动上传）
// Unity 内置的 Renderer 组件会自动处理这些，无需手动操作
```

**Adaptive Probe Volumes (APV)**（Unity 2022.2+ URP 支持）：相比 Light Probes，APV 的优势是：
- 探针密度自动根据场景复杂度调整
- 无需手动放置探针
- 支持流式加载（大型开放世界）

在 Shader 中读取 APV 数据：

```hlsl
// 启用 APV 的 Shader 只需包含相同的 SAMPLE_GI 宏，Unity 内部会自动切换数据源
// 但需要确保项目设置中启用了 APV（URP Asset → Lighting → Probe System → Adaptive Probe Volumes）

// 在高质量需求时，可以使用更详细的 SH 采样：
float3 SampleProbeVolumeAmbient(float3 worldPos, float3 worldNormal)
{
    #if defined(PROBE_VOLUMES_L1) || defined(PROBE_VOLUMES_L2)
        // APV 采样（自动处理探针插值）
        return SampleProbeVolumeSH4(
            TEXTURE3D_ARGS(apv_L0_L1Rx, apv_sampler),
            worldPos, worldNormal, 
            GetSHCoefficients()
        );
    #else
        // 回退到标准 SH
        return SampleSH(worldNormal);
    #endif
}
```

## Unity DXR + URP Ray Tracing

Unity 2020+ 支持硬件光线追踪（需要 DXR 兼容 GPU，即 NVIDIA RTX 系列或 AMD RX 6000+）：

在 URP 中开启 Ray Tracing 需要：
1. Project Settings → Graphics → Enable Ray Tracing
2. 在场景中添加 `RayTracingAccelerationStructure`
3. 在 URP Asset 中启用 Ray Tracing 特性

自定义 Shader 需要添加 Ray Tracing 相关的 Pass：

```hlsl
// Ray Tracing Hit Shader（基础示例）
Pass
{
    Name "RayTracing"
    Tags { "LightMode" = "RayTracing" }

    HLSLPROGRAM
    #pragma raytracing surface_shader

    #include "UnityRayTracingMeshUtils.cginc"

    // 射线命中时调用
    [shader("closesthit")]
    void ClosestHitShader(inout RayIntersection rayIntersection : SV_RayPayload,
                          AttributeData attribs : SV_IntersectionAttributes)
    {
        // 获取命中点信息
        float3 barycentricCoords = float3(
            1.0 - attribs.barycentrics.x - attribs.barycentrics.y,
            attribs.barycentrics.x,
            attribs.barycentrics.y
        );
        
        uint3 triangleIndices = UnityRayTracingFetchTriangleIndices(PrimitiveIndex());
        float2 uv0 = UnityRayTracingFetchVertexAttribute2(triangleIndices.x, kVertexAttributeTexCoord0);
        // ... 计算着色并写入 rayIntersection.color
        rayIntersection.color = half4(1, 0, 0, 1);
    }
    ENDHLSL
}
```

## GI 调试技巧

在 Unity 编辑器中调试 GI 问题：

1. **Scene 视图 → Lighting Mode**：切换到 `Baked Lightmap`、`Light Probes` 等叠加层，直观查看 GI 数据分布
2. **Frame Debugger**：查看 `DrawOpaqueObjects` 步骤中是否正确绑定了光照贴图纹理
3. **Lighting 窗口 → Stats**：查看烘焙的纹素数量、探针数量
4. **Scene 视图 → GI Contribution**：检查每个对象的 GI 贡献程度

## 性能考量

| GI 方案 | 运行时 CPU | 运行时 GPU | 内存占用 | 适用场景 |
|---------|----------|----------|---------|---------|
| Baked Lightmap | 极低 | 低（纹理采样） | 中高（贴图） | 静态场景，移动端 |
| Light Probes | 低（插值） | 极低 | 低 | 动态物体 |
| APV | 低（流式） | 低（3D 纹理） | 中 | 大型开放世界 |
| DDGI | 无 | 高（Compute） | 中 | PC/主机实时 GI |
| DXR | 无 | 极高 | 低 | RTX 硬件专用 |

## 常见踩坑

**坑1：光照贴图 UV 覆盖问题**
如果多个 Mesh Renderer 共用同一个 Mesh，它们的光照贴图 UV 会重叠，导致 GI 信息混乱。每个需要独立烘焙 GI 的物体必须有唯一的光照贴图 UV。使用 `Mesh.uv2` 或 Import Settings 中的 `Generate Lightmap UVs`。

**坑2：`SAMPLE_GI` 宏的使用前提**
`SAMPLE_GI` 宏只有在包含了正确的头文件（`GlobalIllumination.hlsl`）并且 Attributes 结构体中有 `lightmapUV` 时才能正常工作。在自定义 Shader 中遗漏这些导致 GI 数据为黑色是非常常见的错误。

**坑3：Static Batching 和光照贴图的冲突**
开启 Static Batching 后，合批的物体共用同一份 VBO，光照贴图 UV 会被 Unity 自动重新打包。这通常是正确的，但如果你在 Shader 中手动计算光照贴图 UV（不使用 `OUTPUT_LIGHTMAP_UV` 宏），可能会出现光照错位。

**坑4：Realtime GI 更新频率**
Unity 的 Realtime GI（Enlighten 实时模式）不是每帧更新，而是分时更新（Indirect Update Rate）。对于快速移动的光源，GI 会有明显的延迟。可以通过 `DynamicGI.UpdateEnvironment()` 强制立即更新，但这有较高的 CPU 开销。
