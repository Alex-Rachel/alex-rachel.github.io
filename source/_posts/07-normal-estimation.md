---
title: Unity Shader 系列（七）：URP 法线体系完整讲解 — TBN 矩阵与视差贴图
date: 2026-04-08 12:00:00
tags: [HLSL, URP, 法线贴图, 视差贴图, 切线空间]
---

## Unity 法线体系：为什么有三种空间？

法线数据在 Unity 中以三种形式存在，每种有其适用场景：

**1. 切线空间（Tangent Space）法线** — 最常见
- 存储为蓝紫色贴图（未扰动时法线朝上 = (0,0,1) = RGB(0.5,0.5,1.0)）
- 相对于网格表面，与模型的平移/旋转无关
- 可以在不同模型间复用（如砖墙法线贴图可用于任意朝向的墙壁）
- Unity 默认法线贴图格式

**2. 世界空间（World Space）法线**
- 直接存储世界坐标系中的方向，不依赖切线空间
- 优点：无需 TBN 矩阵变换，性能更低
- 缺点：贴图无法在不同旋转的模型间复用
- 常见于地形 Shader

**3. 对象空间（Object Space）法线**
- 相对于模型局部坐标系
- 烘焙时使用，运行时少见

## 切线空间与 TBN 矩阵

**TBN 矩阵**由三个互相正交的向量组成，将切线空间的向量变换到世界空间：
- **T（Tangent，切线）**：沿 UV.x 方向
- **B（Bitangent，副切线）**：沿 UV.y 方向（也叫 Binormal）
- **N（Normal，法线）**：垂直于表面

```hlsl
// URP 中获取 TBN 的标准方式（顶点着色器）
VertexNormalInputs normalInputs = GetVertexNormalInputs(IN.normalOS, IN.tangentOS);
float3 tangentWS   = normalInputs.tangentWS;    // 世界空间切线
float3 bitangentWS = normalInputs.bitangentWS;  // 世界空间副切线
float3 normalWS    = normalInputs.normalWS;     // 世界空间法线

// 在片元着色器中构建 TBN 矩阵
float3x3 TBN = float3x3(
    normalize(tangentWS),
    normalize(bitangentWS),
    normalize(normalWS)
);

// 切线空间 → 世界空间
float3 normalTS = UnpackNormal(normalMap);           // 解码法线贴图
float3 normalWS = TransformTangentToWorld(normalTS, TBN); // URP 内置函数
// 等价手动写法：normalize(mul(normalTS, TBN))
```

## UnpackNormal 的内部实现

Unity 的法线贴图有两种压缩格式，`UnpackNormal` 内部会根据平台自动选择解码方式：

```hlsl
// UnpackNormal 源码（来自 Packages/com.unity.render-pipelines.core/ShaderLibrary/Packing.hlsl）
float3 UnpackNormal(float4 packedNormal)
{
    #if defined(UNITY_NO_DXT5nm)
        // 部分移动端：直接使用 RGB，范围 [0,1] → [-1,1]
        return packedNormal.xyz * 2.0 - 1.0;
    #else
        // DX11/DXT5nm（BC5）格式：只存 RG，重建 Z
        // 法线贴图的 A 通道存 X，G 通道存 Y
        float3 normal;
        normal.xy = packedNormal.ag * 2.0 - 1.0;
        normal.z = sqrt(max(0.0, 1.0 - dot(normal.xy, normal.xy)));
        return normal;
    #endif
}

// UnpackNormalScale：带强度缩放的版本
float3 UnpackNormalScale(float4 packedNormal, float bumpScale)
{
    float3 normal = UnpackNormal(packedNormal);
    normal.xy *= bumpScale; // 只缩放 XY，Z 重建保证单位向量
    normal = normalize(normal);
    return normal;
}
```

**重要踩坑：DXT5nm 格式**
Unity 在 Windows/DX11 上默认将法线贴图压缩为 `DXT5nm`（实际是 `BC5`），此格式只保存两个通道（X 和 Y）。Z 分量在运行时通过 `sqrt(1 - x² - y²)` 重建。

这意味着：
- 永远不要直接读取法线贴图的 `.rgb`，始终用 `UnpackNormal`
- DXT5nm 贴图显示为绿色偏蓝（而非蓝紫），这是正常现象

## 法线混合技术

当需要叠加两张法线贴图时（如宏观地形起伏 + 微观岩石纹理），混合方式至关重要：

```hlsl
// ===== 方法一：线性叠加（Linear Blending）— 错误，不推荐 =====
// 简单相加，但会破坏法线的单位向量属性
float3 badBlend = normalize(n1 + n2); // 在 n1 和 n2 差异较大时结果错误

// ===== 方法二：Partial Derivative（偏导数混合）— 简单正确 =====
// 将两张法线都视为高度场的偏导数，直接相加
float3 pdBlend(float3 n1, float3 n2)
{
    return normalize(float3(n1.xy + n2.xy, n1.z * n2.z));
    // 注意：z 分量相乘而非相加，避免法线过于平坦
}

// ===== 方法三：Reoriented Normal Mapping（RNM）— 最准确 =====
// 以 n1 为基础，将 n2 "重定向"到 n1 的切线空间
float3 blendNormalsRNM(float3 n1, float3 n2)
{
    float3 t = n1 + float3(0, 0, 1);  // n1 偏移
    float3 u = n2 * float3(-1, -1, 1); // n2 翻转 XY
    return normalize(t * dot(t, u) / t.z - u);
}

// ===== URP 内置：BlendNormal（类似 Partial Derivative）=====
// 在 Lighting.hlsl 中：BlendNormal(n1, n2) 等价于 pdBlend
```

## 完整示例：URP 标准 PBR 扩展 Shader（法线 + 视差）

支持法线强度调节和视差贴图深度调节的完整 URP Shader：

```hlsl
Shader "Custom/URP/StandardPBRExtended"
{
    Properties
    {
        // 基础 PBR 属性
        _BaseColor      ("Base Color",     Color)  = (1,1,1,1)
        _BaseMap        ("Base Albedo",    2D)     = "white" {}
        _Metallic       ("Metallic",       Range(0,1)) = 0.0
        _Smoothness     ("Smoothness",     Range(0,1)) = 0.5

        // 法线贴图
        _BumpMap        ("Normal Map",     2D)     = "bump" {}
        _BumpScale      ("Normal Strength",Range(0,3)) = 1.0

        // 第二层法线（宏观起伏）
        _BumpMap2       ("Normal Map 2",   2D)     = "bump" {}
        _BumpScale2     ("Normal Strength 2", Range(0,1)) = 0.5
        _BumpTiling2    ("Normal Map 2 Tiling", Range(0.1, 5)) = 0.3

        // 高度图（视差贴图）
        _HeightMap      ("Height Map",     2D)     = "black" {}
        _ParallaxScale  ("Parallax Depth", Range(0.001, 0.08)) = 0.02
        _ParallaxSteps  ("Parallax Steps", Range(4, 32)) = 16  // 陡峭视差步数

        // 遮蔽/自发光
        _OcclusionMap   ("Occlusion Map",  2D)     = "white" {}
        _OcclusionStrength ("Occlusion Strength", Range(0,1)) = 1.0
        [HDR] _EmissionColor ("Emission", Color) = (0,0,0,1)
        _EmissionMap    ("Emission Map",   2D)     = "black" {}
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Geometry"
        }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #pragma multi_compile _ _SHADOWS_SOFT
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap);     SAMPLER(sampler_BaseMap);
            TEXTURE2D(_BumpMap);     SAMPLER(sampler_BumpMap);
            TEXTURE2D(_BumpMap2);    SAMPLER(sampler_BumpMap2);
            TEXTURE2D(_HeightMap);   SAMPLER(sampler_HeightMap);
            TEXTURE2D(_OcclusionMap);SAMPLER(sampler_OcclusionMap);
            TEXTURE2D(_EmissionMap); SAMPLER(sampler_EmissionMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BumpMap_ST;
                float4 _BumpMap2_ST;
                float4 _HeightMap_ST;
                float4 _OcclusionMap_ST;
                float4 _EmissionMap_ST;
                float4 _BaseColor;
                float4 _EmissionColor;
                float  _Metallic;
                float  _Smoothness;
                float  _BumpScale;
                float  _BumpScale2;
                float  _BumpTiling2;
                float  _ParallaxScale;
                float  _ParallaxSteps;
                float  _OcclusionStrength;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
                float2 uv2        : TEXCOORD1;  // 第二 UV（Lightmap UV）
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS  : SV_POSITION;
                float2 uv           : TEXCOORD0;
                float2 lightmapUV   : TEXCOORD1;
                float3 positionWS   : TEXCOORD2;
                float3 normalWS     : TEXCOORD3;
                float3 tangentWS    : TEXCOORD4;
                float3 bitangentWS  : TEXCOORD5;
                float3 viewDirTS    : TEXCOORD6;  // 切线空间视线方向（视差贴图使用）
                float4 shadowCoord  : TEXCOORD7;
                float  fogFactor    : TEXCOORD8;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== 视差贴图（Parallax Occlusion Mapping）========

            // 简单视差（Parallax Mapping）
            float2 parallaxSimple(float2 uv, float3 viewDirTS, float scale)
            {
                // 用高度图采样计算偏移量
                float height = SAMPLE_TEXTURE2D_LOD(_HeightMap, sampler_HeightMap, uv, 0).r;
                // 偏移量 = 高度 × 视线切线分量（越斜视越大）
                float2 offset = viewDirTS.xy / viewDirTS.z * (height * scale);
                return uv - offset; // 减法：高区域 UV 向视线方向偏移
            }

            // 陡峭视差（Steep Parallax Mapping）
            // 多步采样，处理大深度时的锯齿问题
            float2 parallaxSteep(float2 uv, float3 viewDirTS, float scale, int steps)
            {
                float stepSize = 1.0 / float(steps);
                float2 uvStep = viewDirTS.xy / abs(viewDirTS.z) * scale * stepSize;

                float currentHeight = 1.0; // 从顶部开始向下步进
                float2 currentUV = uv;
                float sampledHeight = SAMPLE_TEXTURE2D_LOD(_HeightMap, sampler_HeightMap, currentUV, 0).r;

                [loop]
                for (int i = 0; i < steps; i++)
                {
                    if (sampledHeight >= currentHeight) break;
                    currentHeight -= stepSize;
                    currentUV -= uvStep; // 每步向视线方向偏移
                    sampledHeight = SAMPLE_TEXTURE2D_LOD(_HeightMap, sampler_HeightMap, currentUV, 0).r;
                }

                // 线性插值（在最后两步之间插值，消除锯齿）
                float2 prevUV = currentUV + uvStep;
                float prevHeight = SAMPLE_TEXTURE2D_LOD(_HeightMap, sampler_HeightMap, prevUV, 0).r;
                float prevDiff = prevHeight - (currentHeight + stepSize);
                float currDiff = sampledHeight - currentHeight;
                float blend = currDiff / (currDiff - prevDiff);
                return lerp(currentUV, prevUV, blend);
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

                // 计算切线空间视线方向（视差贴图在顶点着色器中预计算更高效）
                float3 viewDirWS = GetCameraPositionWS() - posInputs.positionWS;
                // 构建 TBN 逆矩阵（正交矩阵的逆 = 转置）
                float3x3 TBN = float3x3(normalInputs.tangentWS, normalInputs.bitangentWS, normalInputs.normalWS);
                // 世界空间视线 → 切线空间（mul(v, M) 等价于 transpose(M) * v）
                OUT.viewDirTS = mul(TBN, viewDirWS); // 注意：这里 TBN 行主序，等价于切线空间变换

                OUTPUT_LIGHTMAP_UV(IN.uv2, unity_LightmapST, OUT.lightmapUV);

                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float3 viewDirTS = normalize(IN.viewDirTS);

                // ===== 1. 视差贴图 UV 偏移 =====
                float2 uv = IN.uv;
                #ifdef _PARALLAX_MAP
                    // 使用陡峭视差（更大 _ParallaxScale 时推荐）
                    uv = parallaxSteep(uv, viewDirTS, _ParallaxScale, (int)_ParallaxSteps);
                #else
                    // 简单视差（低性能消耗）
                    uv = parallaxSimple(uv, viewDirTS, _ParallaxScale);
                #endif

                // ===== 2. 基础颜色 =====
                half4 albedo = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, uv) * _BaseColor;

                // ===== 3. 法线（双层叠加）=====
                // 第一层法线（主要细节）
                float4 normalPacked1 = SAMPLE_TEXTURE2D(_BumpMap, sampler_BumpMap, uv);
                float3 normalTS1 = UnpackNormalScale(normalPacked1, _BumpScale);

                // 第二层法线（宏观起伏，使用不同缩放）
                float2 uv2 = IN.uv * _BumpTiling2;
                float4 normalPacked2 = SAMPLE_TEXTURE2D(_BumpMap2, sampler_BumpMap2, uv2);
                float3 normalTS2 = UnpackNormalScale(normalPacked2, _BumpScale2);

                // RNM 法线混合
                float3 t = normalTS1 + float3(0, 0, 1);
                float3 u = normalTS2 * float3(-1, -1, 1);
                float3 blendedNormalTS = normalize(t * dot(t, u) / t.z - u);

                // 切线空间 → 世界空间
                float3x3 TBN = float3x3(
                    normalize(IN.tangentWS),
                    normalize(IN.bitangentWS),
                    normalize(IN.normalWS)
                );
                float3 normalWS = TransformTangentToWorld(blendedNormalTS, TBN);

                // ===== 4. PBR 材质属性 =====
                float metallic   = _Metallic;
                float smoothness = _Smoothness;
                float occlusion  = lerp(1.0, SAMPLE_TEXTURE2D(_OcclusionMap, sampler_OcclusionMap, uv).g, _OcclusionStrength);
                half3 emission   = SAMPLE_TEXTURE2D(_EmissionMap, sampler_EmissionMap, uv).rgb * _EmissionColor.rgb;

                // ===== 5. URP 标准 PBR 光照 =====
                SurfaceData surfaceData;
                surfaceData.albedo      = albedo.rgb;
                surfaceData.alpha       = albedo.a;
                surfaceData.metallic    = metallic;
                surfaceData.smoothness  = smoothness;
                surfaceData.normalTS    = blendedNormalTS; // 保存切线空间法线（URP 内部处理）
                surfaceData.occlusion   = occlusion;
                surfaceData.emission    = emission;
                surfaceData.specular    = 0;
                surfaceData.clearCoatMask = 0;
                surfaceData.clearCoatSmoothness = 0;

                InputData inputData;
                inputData.positionWS            = IN.positionWS;
                inputData.normalWS              = normalize(normalWS);
                inputData.viewDirectionWS       = normalize(GetCameraPositionWS() - IN.positionWS);
                inputData.shadowCoord           = IN.shadowCoord;
                inputData.fogCoord              = IN.fogFactor;
                inputData.vertexLighting        = 0;
                inputData.bakedGI               = SAMPLE_GI(IN.lightmapUV, SampleSH(inputData.normalWS), inputData.normalWS);
                inputData.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(IN.positionHCS);
                inputData.shadowMask            = SAMPLE_SHADOWMASK(IN.lightmapUV);

                // URP 内置 PBR 光照（封装了主光源 + 额外光源 + GI + 阴影）
                half4 color = UniversalFragmentPBR(inputData, surfaceData);

                // 雾效
                color.rgb = MixFog(color.rgb, IN.fogFactor);
                return color;
            }
            ENDHLSL
        }

        // 阴影投射 Pass（使用 URP 内置）
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        // 深度 Pass
        UsePass "Universal Render Pipeline/Lit/DepthOnly"
        // 法线深度 Pass（用于 SSAO）
        UsePass "Universal Render Pipeline/Lit/DepthNormals"
    }
}
```

## ShaderGraph 中的法线贴图实现

ShaderGraph 提供了完整的法线支持：
1. `Sample Texture 2D` 节点，类型选 `Normal`（自动 UnpackNormal）
2. `Normal Strength` 节点：缩放法线 XY 强度
3. `Normal Blend` 节点：混合两张法线（内部使用 Partial Derivative 方法）
4. `Parallax Occlusion Mapping` 节点：内置视差贴图（Unity 2022+）

## 性能考量

**各平台的法线贴图压缩格式：**
| 平台 | 格式 | `UNITY_NO_DXT5nm` |
|------|------|-------------------|
| Windows (DX11) | DXT5nm / BC5 | 未定义（使用 AG 通道） |
| Android (OpenGL ES) | ETC2 RGBA8 | 已定义（使用 RGB） |
| iOS (Metal) | ASTC | 已定义（使用 RGB） |
| macOS (Metal) | BPTC（BC5） | 未定义 |

**视差贴图的性能开销：**
- 简单视差：1 次额外采样，开销极小
- 陡峭视差：N 步 × 1 次采样，16 步开销约为 3-4 个完整 PBR 材质采样
- 移动端建议：简单视差 + `_ParallaxScale <= 0.02`，陡峭视差限制在 8 步以内

## 常见踩坑

1. **DXT5nm 格式看起来颜色偏绿**：DXT5nm 将法线 X 存在 Alpha，Y 存在 Green，Inspector 预览会是偏绿的而非蓝紫，这是正常的。如果法线贴图显示蓝紫说明是旧版未压缩格式，也没问题（`UnpackNormal` 兼容两种）。

2. **非均匀缩放破坏 TBN**：如果模型有非均匀缩放（如 `Scale(2, 1, 1)`），`GetVertexNormalInputs` 内部会用法线矩阵（逆转置）正确处理，手动计算 TBN 时需要特别注意。

3. **切线方向与 UV 方向不对齐**：当模型 UV 在 DCC 工具中翻转过（`mirrorX = true`），切线方向会反向，导致法线贴图"凹凸反转"。检查 `tangentOS.w`（存储翻转符号）：`bitangentWS = cross(normalWS, tangentWS) * tangentOS.w`。

4. **视差贴图在低 poly 模型上效果差**：视差贴图只是 UV 偏移，不是真实几何体，在掠射角（接近 90°）时会产生明显的剪切伪影。物体边缘要有足够的多边形数量，或者用 `abs(viewDirTS.z)` 控制极端视角时关闭效果。

5. **陡峭视差的步数在 OpenGL ES 中报错**：部分老版 Android GPU 不支持循环变量为浮点或动态步数。将 `_ParallaxSteps` 改为整型常量，或用 `[unroll(16)]` 强制展开。

下一篇文章将深入 URP 光照系统——PBR BRDF 的内部实现、卡通渲染（Toon Shading）色阶漫反射、以及各向异性布料材质。
