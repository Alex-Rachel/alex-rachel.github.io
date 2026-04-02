---
title: Unity Shader 系列（四）：URP 纹理采样全面指南 — 从基础到水面 Shader
date: 2026-04-01 09:30:00
tags: [HLSL, URP, 纹理采样, 材质系统, Unity]
---

## URP 纹理采样体系：为什么不用 `tex2D`？

老版 Unity Shader 中常见 `tex2D(_MainTex, uv)` 这样的写法。在 URP 中，这种写法仍然能编译，但不推荐，原因有两个：

1. **跨平台一致性**：`tex2D` 是 HLSL 的固定函数 API，在部分平台（如 Vulkan、Metal）行为不一致
2. **无法与 SRP Batcher 配合**：SRP Batcher 需要将纹理和采样器分开声明，才能实现批次合并

URP 推荐使用宏定义的声明/采样方式，本质上是对平台差异的封装。

## 纹理类型声明对照表

```hlsl
// ===== URP 纹理声明宏（必须在 HLSLPROGRAM 块内） =====

// 2D 纹理（最常用）
TEXTURE2D(_MainTex);
SAMPLER(sampler_MainTex);

// 2D 纹理数组（地形多层混合、动画帧序列）
TEXTURE2D_ARRAY(_TerrainLayers);
SAMPLER(sampler_TerrainLayers);

// 立方体贴图（反射、天空盒、IBL）
TEXTURECUBE(_CubeMap);
SAMPLER(sampler_CubeMap);

// 3D 纹理（体积效果、LUT）
TEXTURE3D(_VolumeTex);
SAMPLER(sampler_VolumeTex);

// 深度纹理（软粒子、深度雾效）
// 通过 DeclareDepthTexture.hlsl 中的宏使用：
// #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"
// SampleSceneDepth(screenUV);  // 直接调用

// 屏幕颜色纹理（后处理、Grab Pass 替代）
// #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareOpaqueTexture.hlsl"
// SampleSceneColor(screenUV);  // 直接调用
```

## 四种采样函数详解

```hlsl
// === 1. SAMPLE_TEXTURE2D — 最常用，自动 mip 选择 ===
half4 col = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);
// 等价于：_MainTex.Sample(sampler_MainTex, uv)
// GPU 根据屏幕空间导数（ddx/ddy）自动选择 mip 级别
// 注意：只能在片元着色器中使用（顶点着色器没有导数）

// === 2. SAMPLE_TEXTURE2D_LOD — 指定 mip 级别 ===
half4 col = SAMPLE_TEXTURE2D_LOD(_MainTex, sampler_MainTex, uv, lodLevel);
// lodLevel: 0 = 原始分辨率，每 +1 分辨率减半
// 用途：在光线步进/顶点着色器中强制指定 mip（避免导数计算错误）

// === 3. LOAD_TEXTURE2D — 整数坐标精确读取，无滤波 ===
// 等价于 OpenGL 的 texelFetch
half4 col = LOAD_TEXTURE2D(_MainTex, int2(pixelX, pixelY));
// 或带 mip 参数：
half4 col = LOAD_TEXTURE2D_X(_MainTex, uint3(pixelX, pixelY, mipLevel));
// 用途：精确读取单个纹素（像素级操作、数据纹理、后处理）

// === 4. SAMPLE_TEXTURE2D_BIAS — LOD 偏移采样 ===
half4 col = SAMPLE_TEXTURE2D_BIAS(_MainTex, sampler_MainTex, uv, bias);
// 在自动 mip 基础上加偏移，负值更清晰，正值更模糊
// 用途：刻意让材质稍微模糊（远景淡化细节）或更清晰（近景保留细节）

// === 立方体贴图采样 ===
half4 envColor = SAMPLE_TEXTURECUBE(_CubeMap, sampler_CubeMap, reflectDir);
half4 envLod   = SAMPLE_TEXTURECUBE_LOD(_CubeMap, sampler_CubeMap, reflectDir, roughness * 6.0);
```

## Unity 纹理属性对渲染的影响

在 Unity 材质/纹理 Inspector 中的设置会直接影响 Shader 采样行为：

**Wrap Mode（UV 超出 [0,1] 时的行为）：**
- `Repeat`：平铺（最常用）
- `Clamp`：夹紧到边缘像素（UI、精灵）
- `Mirror`：镜像平铺（对称纹理减少文件大小）
- `Mirror Once`：只镜像一次

**Filter Mode（放大/缩小时的插值方式）：**
- `Point`：最近邻（像素风格游戏，像素图标）
- `Bilinear`：双线性（通用，性能/质量平衡）
- `Trilinear`：三线性（mip 之间也插值，运动中更平滑）

**Anisotropic（各向异性过滤）：**
- 值越高（1~16），斜视角纹理越清晰（地板、道路）
- 移动端建议 1-2，PC 建议 4-8

## 完整示例：URP 水面 Shader

双层流动 UV + 法线叠加 + Cubemap 反射的写实水面：

```hlsl
Shader "Custom/URP/WaterSurface"
{
    Properties
    {
        // 水面颜色
        _ShallowColor ("Shallow Color", Color) = (0.1, 0.5, 0.6, 0.7)
        _DeepColor    ("Deep Color",    Color) = (0.02, 0.1, 0.3, 0.9)
        // 法线贴图（两层，不同方向流动）
        _NormalMap    ("Normal Map (Layer 1)", 2D) = "bump" {}
        _NormalMap2   ("Normal Map (Layer 2)", 2D) = "bump" {}
        _NormalStrength ("Normal Strength", Range(0.0, 2.0)) = 0.8
        // UV 流动速度（Layer1 XY，Layer2 XY）
        _FlowSpeed1   ("Flow Speed Layer 1", Vector) = (0.05, 0.02, 0.0, 0.0)
        _FlowSpeed2   ("Flow Speed Layer 2", Vector) = (-0.02, 0.04, 0.0, 0.0)
        // UV 缩放
        _NormalTiling ("Normal Map Tiling", Float) = 4.0
        // 反射
        _ReflectionCube ("Reflection Cubemap", CUBE) = "" {}
        _ReflectionStrength ("Reflection Strength", Range(0.0, 1.0)) = 0.6
        _Roughness    ("Water Roughness", Range(0.0, 1.0)) = 0.05
        // 折射/水深
        _RefractionStrength ("Refraction Distortion", Range(0.0, 0.1)) = 0.03
        _DepthFade    ("Depth Fade Distance", Range(0.1, 10.0)) = 3.0
        // 泡沫（接岸边缘）
        _FoamColor    ("Foam Color", Color) = (1.0, 1.0, 1.0, 1.0)
        _FoamRange    ("Foam Range", Range(0.0, 2.0)) = 0.5
        // 高光
        _SpecularColor ("Specular Color", Color) = (1.0, 1.0, 1.0, 1.0)
        _SpecularPower ("Specular Power", Range(8.0, 256.0)) = 64.0
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "Queue" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
        }

        // 半透明水面：标准 Alpha 混合
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off

        Pass
        {
            Name "WaterForward"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareOpaqueTexture.hlsl"

            // 纹理声明
            TEXTURE2D(_NormalMap);   SAMPLER(sampler_NormalMap);
            TEXTURE2D(_NormalMap2);  SAMPLER(sampler_NormalMap2);
            TEXTURECUBE(_ReflectionCube); SAMPLER(sampler_ReflectionCube);

            CBUFFER_START(UnityPerMaterial)
                float4 _NormalMap_ST;
                float4 _NormalMap2_ST;
                float4 _ShallowColor;
                float4 _DeepColor;
                float4 _FlowSpeed1;
                float4 _FlowSpeed2;
                float4 _FoamColor;
                float4 _SpecularColor;
                float  _NormalStrength;
                float  _NormalTiling;
                float  _ReflectionStrength;
                float  _Roughness;
                float  _RefractionStrength;
                float  _DepthFade;
                float  _FoamRange;
                float  _SpecularPower;
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
                float4 positionHCS  : SV_POSITION;
                float2 uv           : TEXCOORD0;
                float3 positionWS   : TEXCOORD1;
                float3 normalWS     : TEXCOORD2;
                float3 tangentWS    : TEXCOORD3;
                float3 bitangentWS  : TEXCOORD4;
                float4 screenPos    : TEXCOORD5;   // 屏幕坐标（折射、深度采样）
                float  fogFactor    : TEXCOORD6;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== 法线贴图解码 ========

            // UnpackNormal: DXT5nm 格式（URP 标准，重建 Z 分量）
            // UnpackNormalScale: 带强度缩放
            float3 decodeNormal(TEXTURE2D_PARAM(normalMap, sampler_n), float2 uv, float strength)
            {
                // SAMPLE_TEXTURE2D 采样后用 URP 内置函数解码
                float4 packed = SAMPLE_TEXTURE2D(normalMap, sampler_n, uv);
                // UnpackNormalScale 内部处理了 DXT5nm（BC5）和 iOS/Android 格式差异
                return UnpackNormalScale(packed, strength);
            }

            // 法线混合：Reoriented Normal Mapping（RNM）
            // 比简单的 normalize(n1 + n2) 更物理正确
            float3 blendNormalsRNM(float3 n1, float3 n2)
            {
                float3 t = n1.xyz + float3(0, 0, 1);
                float3 u = n2.xyz * float3(-1, -1, 1);
                return normalize(t * dot(t, u) / t.z - u);
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                VertexPositionInputs posInputs = GetVertexPositionInputs(IN.positionOS.xyz);
                VertexNormalInputs normalInputs = GetVertexNormalInputs(IN.normalOS, IN.tangentOS);

                OUT.positionHCS = posInputs.positionCS;
                OUT.positionWS  = posInputs.positionWS;
                OUT.normalWS    = normalInputs.normalWS;
                OUT.tangentWS   = normalInputs.tangentWS;
                OUT.bitangentWS = normalInputs.bitangentWS;
                OUT.uv = IN.uv;

                // 屏幕坐标（用于深度采样和折射 UV 偏移）
                OUT.screenPos = ComputeScreenPos(posInputs.positionCS);
                OUT.fogFactor = ComputeFogFactor(posInputs.positionCS.z);

                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float time = _Time.y;

                // ===== 1. 双层流动 UV =====
                float2 uv1 = IN.uv * _NormalTiling + _FlowSpeed1.xy * time;
                float2 uv2 = IN.uv * _NormalTiling * 0.7 + _FlowSpeed2.xy * time;

                // ===== 2. 双层法线叠加 =====
                float3 normalTangent1 = decodeNormal(TEXTURE2D_ARGS(_NormalMap,  sampler_NormalMap),  uv1, _NormalStrength);
                float3 normalTangent2 = decodeNormal(TEXTURE2D_ARGS(_NormalMap2, sampler_NormalMap2), uv2, _NormalStrength * 0.7);
                // RNM 混合（比简单相加更准确）
                float3 blendedNormalTangent = blendNormalsRNM(normalTangent1, normalTangent2);

                // 切线空间 → 世界空间
                float3x3 TBN = float3x3(
                    normalize(IN.tangentWS),
                    normalize(IN.bitangentWS),
                    normalize(IN.normalWS)
                );
                // HLSL 的 mul(v, TBN) 等价于 transpose(TBN) * v（转置后右乘）
                float3 normalWS = normalize(mul(blendedNormalTangent, TBN));

                // ===== 3. 折射 UV（扰动背景色纹理） =====
                float2 screenUV = IN.screenPos.xy / IN.screenPos.w;
                float2 refractionOffset = blendedNormalTangent.xy * _RefractionStrength;
                float2 refractionUV = screenUV + refractionOffset;
                half3 refractionColor = SampleSceneColor(refractionUV).rgb;

                // ===== 4. 深度采样（水深/软边缘/泡沫） =====
                float sceneDepth = LinearEyeDepth(SampleSceneDepth(screenUV), _ZBufferParams);
                float waterDepth = IN.screenPos.w; // 水面片元的视空间深度
                float depthDifference = sceneDepth - waterDepth;

                // 水深颜色混合（越深越暗越蓝）
                float depthT = saturate(depthDifference / _DepthFade);
                half4 waterColor = lerp(_ShallowColor, _DeepColor, depthT);

                // 接岸泡沫（浅水区域）
                float foamFactor = 1.0 - saturate(depthDifference / _FoamRange);
                foamFactor = pow(foamFactor, 2.0); // 非线性，让泡沫更集中在边缘

                // ===== 5. 反射（Cubemap） =====
                float3 viewDirWS = normalize(GetCameraPositionWS() - IN.positionWS);
                float3 reflectDir = reflect(-viewDirWS, normalWS);
                // 用粗糙度选择 mip（roughness 0 = 镜面反射，1 = 漫反射）
                float reflectMip = _Roughness * 6.0;
                half3 reflectionColor = SAMPLE_TEXTURECUBE_LOD(
                    _ReflectionCube,
                    sampler_ReflectionCube,
                    reflectDir,
                    reflectMip
                ).rgb;

                // Fresnel（掠射角时反射更强）
                float NdotV = saturate(dot(normalWS, viewDirWS));
                float fresnel = pow(1.0 - NdotV, 4.0);
                float3 reflectFinal = reflectionColor * (_ReflectionStrength + fresnel * (1.0 - _ReflectionStrength));

                // ===== 6. 镜面高光（Blinn-Phong，主光源） =====
                Light mainLight = GetMainLight();
                float3 halfDir = normalize(viewDirWS + mainLight.direction);
                float NdotH = saturate(dot(normalWS, halfDir));
                float spec = pow(NdotH, _SpecularPower);
                half3 specular = _SpecularColor.rgb * spec * mainLight.color;

                // ===== 7. 合并所有层 =====
                // 基础颜色 = 折射（水下场景）+ 水色调
                half3 baseColor = lerp(refractionColor, waterColor.rgb, waterColor.a * 0.6);
                // 加反射
                baseColor = lerp(baseColor, reflectFinal, fresnel * _ReflectionStrength);
                // 加高光
                baseColor += specular;
                // 加泡沫
                baseColor = lerp(baseColor, _FoamColor.rgb, foamFactor * _FoamColor.a);

                // 透明度：浅水更透明，泡沫不透明
                float finalAlpha = lerp(waterColor.a, 1.0, foamFactor);

                // 应用雾效
                half3 finalColor = MixFog(baseColor, IN.fogFactor);

                return half4(finalColor, finalAlpha);
            }
            ENDHLSL
        }
    }
}
```

## Mipmap 与 LOD 控制

**什么时候需要手动控制 LOD？**

```hlsl
// 错误：在光线步进 / 非屏幕空间循环中使用自动 mip
// GPU 无法在循环中正确计算 ddx/ddy，会采样错误的 mip 级别
for (int i = 0; i < STEPS; i++) {
    float4 col = SAMPLE_TEXTURE2D(_Tex, sampler_Tex, uv); // 错！
}

// 正确：强制 mip 0 或根据距离计算
float4 col = SAMPLE_TEXTURE2D_LOD(_Tex, sampler_Tex, uv, 0.0);

// 更好：根据步进距离动态选择 mip
float mipLevel = log2(max(1.0, stepDist * _TexelDensity));
float4 col = SAMPLE_TEXTURE2D_LOD(_Tex, sampler_Tex, uv, mipLevel);
```

## 性能考量

**纹理采样是 GPU 的带宽瓶颈：**

| 操作 | 性能影响 | 建议 |
|------|---------|------|
| 超出纹理缓存的采样 | 高延迟 | 合并纹理通道（RGB 放三张灰度图） |
| 各向异性 AF×8 以上 | 性能约降 15-30% | 移动端限制在 AF×2 |
| 多层法线叠加 | 每层一次采样 | 2 层通常足够，避免 4 层 |
| `SampleSceneDepth` | 需要 Depth Prepass | 确认 URP Asset 开启 Depth Texture |
| `SampleSceneColor` | 需要 Opaque Texture（额外 Blit） | 性能开销较大，移动端慎用 |

**移动端优化：**
- 用 `half` 接收采样结果（`half4 col = SAMPLE_TEXTURE2D(...)`）
- 将两张 法线贴图的 RG 通道打包进一张 RGBA 贴图，减少采样次数
- 禁用折射效果（不采样 `SampleSceneColor`），用简单颜色替代

## 常见踩坑

1. **法线贴图 DXT5nm 格式踩坑**：Unity 默认将法线贴图压缩为 DXT5nm（BC5），这种格式只存储 RG 通道，B 通道重建。如果你直接读取 `normalMap.rgb` 而不经过 `UnpackNormal`，会得到错误的绿色法线。**始终使用 `UnpackNormal` 或 `UnpackNormalScale`。**

2. **切线空间 TBN 矩阵方向**：HLSL 中 `mul(tangentNormal, TBN)` 与 GLSL 中 `TBN * tangentNormal` 等价，但 Unity 的 `TBN` 矩阵以世界空间基向量为行，乘法方向与 GLSL 相反。用 `TransformTangentToWorld(tangentNormal, TBN)` 最安全。

3. **折射需要开启 Opaque Texture**：在 URP Asset 中勾选 `Opaque Texture`，否则 `SampleSceneColor` 始终返回黑色。这会在主摄像机进行一次额外的 Blit 操作，有性能开销。

4. **SAMPLE_TEXTURE2D 在顶点着色器中无效**：顶点着色器没有屏幕空间导数，必须使用 `SAMPLE_TEXTURE2D_LOD` 并手动指定 lod 参数。

5. **Trilinear 过滤 + MipMap 生成**：水面法线贴图如果没有生成 Mipmap，`SAMPLE_TEXTURE2D_LOD` 高 LOD 值时会采样到最后一级 mip（通常是纯灰色）。在纹理 Import Settings 中确认 `Generate Mip Maps` 已开启。

下一篇文章将讲解 Unity 颜色管理：Linear 与 Gamma 工作流、URP Color Grading LUT、以及如何实现赛博朋克风格的自定义后处理效果。
