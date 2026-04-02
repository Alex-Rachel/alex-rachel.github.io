---
title: Unity Shader 系列（十五）：域扭曲：传送门与熔岩流动特效
date: 2026-04-01 11:20:00
tags: [HLSL, URP, 域扭曲, 特效Shader, UV动画]
---

域扭曲（Domain Warping）是 Unity 特效制作中最具表现力的技术之一：用噪波偏移 UV 坐标，产生流动、扭曲、有机变形的视觉效果——传送门的空间撕裂感、熔岩的粘稠流动、毒液泡沫的涌动，这些效果的核心都是域扭曲。与纯粹的 UV 动画不同，域扭曲利用多层 FBM 噪波的嵌套叠加，产生无法预测的有机感，本文提供两个完整可用的 URP Shader。

## 域扭曲 vs 顶点扭曲

在 Unity 中，制作扭曲变形效果有两种路线，各有适用场景：

| 对比维度 | UV 域扭曲（片段着色器） | 顶点扭曲（顶点着色器） |
|---------|---------------------|-------------------|
| 扭曲内容 | 纹理坐标 / 视觉图案 | 实际几何形状 |
| 性能瓶颈 | Fragment ALU | Vertex ALU |
| 适用场景 | 传送门、纹理流动、UI 扭曲 | 旗帜飘动、水面波浪 |
| 与碰撞的关系 | 纯视觉，不影响碰撞体 | 影响渲染，不影响碰撞体 |
| 典型组合 | Particle System + UV 扭曲 | Skinned Mesh + 顶点偏移 |

域扭曲通常指 UV 级别的扭曲，更适合制作特效 Shader（传送门、火焰、魔法效果），而顶点扭曲更适合有物理感的几何形变（衣物、水面）。

## FBM 噪波与域扭曲基础

在 HLSL 中构建域扭曲所需的噪波函数：

```hlsl
// 2D 值噪波（无 sin 版本，移动端精度更稳定）
float Hash(float2 p)
{
    p = frac(p * float2(0.1031, 0.1030));
    p += dot(p, p.yx + 33.33);
    return frac((p.x + p.y) * p.x);
}

float ValueNoise(float2 p)
{
    float2 i = floor(p);
    float2 f = frac(p);
    // Hermite 平滑插值（去掉 C0 接缝）
    f = f * f * (3.0 - 2.0 * f);

    return lerp(
        lerp(Hash(i + float2(0, 0)), Hash(i + float2(1, 0)), f.x),
        lerp(Hash(i + float2(0, 1)), Hash(i + float2(1, 1)), f.x),
        f.y
    );
}

// FBM：多频率噪波叠加（旋转去相关，避免方向性伪影）
float FBM(float2 p, int octaves)
{
    // 约 36.87° 的旋转矩阵，使相邻频率的噪波方向错开
    const float2x2 m = float2x2(0.80, 0.60, -0.60, 0.80);

    float value = 0.0, amplitude = 0.5, norm = 0.0;
    for (int i = 0; i < octaves; i++)
    {
        value     += amplitude * ValueNoise(p);
        norm      += amplitude;
        p          = mul(m, p) * 2.02;  // 频率略微偏移，避免格点对齐伪影
        amplitude *= 0.5;
    }
    return value / norm;  // 归一化到 [0, 1]
}

// 向量版 FBM（用于域扭曲的偏移量，xy 两个独立 FBM）
float2 FBM2(float2 p, int octaves)
{
    // 用不同的种子偏移获得独立的 X 和 Y 分量
    return float2(
        FBM(p + float2(0.0, 0.0), octaves),
        FBM(p + float2(5.2, 1.3), octaves)
    );
}
```

## 完整示例一：URP 传送门特效 Shader

传送门效果需要：双层 FBM 扭曲（产生撕裂感）+ 颜色渐变 + 边缘辉光 + 中心扭曲强度更大（表现空间被撕开的感觉）。

```hlsl
Shader "Custom/URP/PortalEffect"
{
    Properties
    {
        // 传送门内部纹理（目标场景的截图或 RenderTexture）
        _PortalTex ("传送门内部纹理", 2D) = "black" {}
        _NoiseTex ("噪波辅助纹理（可选）", 2D) = "gray" {}

        // 扭曲参数
        _WarpStrength ("扭曲强度", Range(0, 0.5)) = 0.15
        _WarpSpeed ("扭曲速度", Range(0, 3)) = 0.5
        _WarpScale ("扭曲尺度", Range(0.5, 5)) = 2.0

        // 颜色参数
        _InnerColor ("内圈颜色", Color) = (0.2, 0.5, 1.0, 1)
        _OuterColor ("外圈颜色", Color) = (0.8, 0.2, 1.0, 1)
        _EdgeGlow ("边缘辉光强度", Range(1, 10)) = 4.0
        _GlowColor ("辉光颜色", Color) = (0.5, 0.3, 1.0, 1)

        // 形状控制
        _PortalRadius ("传送门半径（UV 空间）", Range(0.1, 0.5)) = 0.45
        _EdgeWidth ("边缘辉光宽度", Range(0.01, 0.15)) = 0.05

        // 中心涡旋强度
        _SwirlStrength ("涡旋强度", Range(0, 5)) = 2.0
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Transparent"
        }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Back

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_PortalTex); SAMPLER(sampler_PortalTex);
            TEXTURE2D(_NoiseTex);  SAMPLER(sampler_NoiseTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _PortalTex_ST;
                float  _WarpStrength;
                float  _WarpSpeed;
                float  _WarpScale;
                float4 _InnerColor;
                float4 _OuterColor;
                float  _EdgeGlow;
                float4 _GlowColor;
                float  _PortalRadius;
                float  _EdgeWidth;
                float  _SwirlStrength;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
            };

            float Hash(float2 p)
            {
                p = frac(p * float2(0.1031, 0.1030));
                p += dot(p, p.yx + 33.33);
                return frac((p.x + p.y) * p.x);
            }

            float ValueNoise(float2 p)
            {
                float2 i = floor(p);
                float2 f = frac(p);
                f = f * f * (3.0 - 2.0 * f);
                return lerp(
                    lerp(Hash(i), Hash(i + float2(1,0)), f.x),
                    lerp(Hash(i + float2(0,1)), Hash(i + float2(1,1)), f.x),
                    f.y
                );
            }

            // 带时间的 FBM（仅最低频层注入时间，其他层静止，视觉最自然）
            float FBM_Animated(float2 p, float t)
            {
                const float2x2 m = float2x2(0.80, 0.60, -0.60, 0.80);
                float v = 0.0, a = 0.5, norm = 0.0;

                // 第 0 层：整体流动（注入时间）
                v += a * ValueNoise(p + t * _WarpSpeed); norm += a; a *= 0.5;
                p = mul(m, p) * 2.02;

                // 第 1-3 层：静止细节
                v += a * ValueNoise(p); norm += a; a *= 0.5;
                p = mul(m, p) * 2.03;
                v += a * ValueNoise(p); norm += a; a *= 0.5;
                p = mul(m, p) * 2.01;
                v += a * ValueNoise(p); norm += a;

                return v / norm;
            }

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv          = TRANSFORM_TEX(input.uv, _PortalTex);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float2 uv = input.uv;
                float2 centered = uv - 0.5;  // 以中心为原点

                float t = _Time.y;  // Unity 内置时间变量

                // ---- 1. 涡旋变换（中心区域旋转更强）----
                float dist = length(centered);
                float swirlAngle = _SwirlStrength * exp(-dist * 5.0) * t;
                float cosS = cos(swirlAngle), sinS = sin(swirlAngle);
                float2 swirlUV = float2(
                    cosS * centered.x - sinS * centered.y,
                    sinS * centered.x + cosS * centered.y
                ) + 0.5;

                // ---- 2. 第一层域扭曲 ----
                float2 scaledUV1 = swirlUV * _WarpScale;
                float2 warp1     = float2(
                    FBM_Animated(scaledUV1 + float2(0.0, 0.0), t),
                    FBM_Animated(scaledUV1 + float2(5.2, 1.3), t)
                ) * 2.0 - 1.0;  // 映射到 [-1, 1]

                // ---- 3. 第二层域扭曲（用第一层偏移后的坐标再次扭曲）----
                float2 warpedUV = swirlUV + warp1 * _WarpStrength;
                float2 scaledUV2 = warpedUV * _WarpScale;
                float2 warp2 = float2(
                    FBM_Animated(scaledUV2 + float2(1.7, 9.2), t * 0.7),
                    FBM_Animated(scaledUV2 + float2(8.3, 2.8), t * 0.7)
                ) * 2.0 - 1.0;

                // 最终扭曲 UV（双层叠加）
                float2 finalWarpedUV = warpedUV + warp2 * _WarpStrength * 0.5;

                // ---- 4. 圆形裁剪（传送门形状）----
                float portalDist   = length(centered);
                float portalMask   = 1.0 - smoothstep(_PortalRadius - _EdgeWidth, _PortalRadius, portalDist);
                float edgeMask     = smoothstep(_PortalRadius - _EdgeWidth * 2, _PortalRadius - _EdgeWidth, portalDist);

                if (portalMask < 0.001) discard;

                // ---- 5. 内部纹理采样（使用扭曲后的 UV）----
                float3 portalColor = SAMPLE_TEXTURE2D(_PortalTex, sampler_PortalTex, finalWarpedUV).rgb;

                // ---- 6. 径向颜色渐变（内圈到外圈）----
                float radialT = saturate(portalDist / _PortalRadius);
                float3 gradientColor = lerp(_InnerColor.rgb, _OuterColor.rgb, radialT * radialT);

                // FBM 值直接用于颜色混合（无纹理时也能有漂亮的效果）
                float patternVal = FBM_Animated(finalWarpedUV * 3.0, t * 0.3);
                float3 patternColor = lerp(_InnerColor.rgb, _OuterColor.rgb, patternVal);

                // 如果有 PortalTex 则混合纹理，否则纯程序化颜色
                float3 innerColor = lerp(patternColor, portalColor, 0.5);
                innerColor = lerp(innerColor, gradientColor, 0.3);

                // ---- 7. 边缘辉光（HDR 高亮，配合 Bloom 后处理）----
                float3 glowColor = _GlowColor.rgb * _EdgeGlow * edgeMask;

                float3 finalColor = innerColor * portalMask + glowColor;

                // 传送门整体 alpha（边缘渐隐）
                float alpha = portalMask * 0.95 + edgeMask * 0.05;

                return half4(finalColor, alpha);
            }
            ENDHLSL
        }
    }
}
```

## 完整示例二：URP 熔岩流动材质

熔岩效果使用域扭曲模拟粘稠流体的运动：黑色岩石（冷却表面）+ 橙红发光裂缝（熔岩流）+ 随时间流动的 UV 动画。

```hlsl
Shader "Custom/URP/LavaFlow"
{
    Properties
    {
        _LavaRamp ("熔岩颜色渐变 (Gradient Ramp)", 2D) = "white" {}
        _NoiseTex ("噪波纹理", 2D) = "gray" {}
        _CrackTex ("裂缝纹理", 2D) = "white" {}

        _FlowSpeed ("流动速度", Range(0, 2)) = 0.3
        _FlowDirection ("流动方向 (XY)", Vector) = (0, -1, 0, 0)
        _WarpStrength ("域扭曲强度", Range(0, 0.5)) = 0.2
        _WarpScale ("扭曲尺度", Range(1, 8)) = 3.0

        _LavaIntensity ("熔岩发光强度", Range(1, 20)) = 8.0
        _CrackWidth ("裂缝宽度", Range(0, 1)) = 0.3
        _RockColor ("岩石颜色", Color) = (0.08, 0.06, 0.05, 1)
        _CoolLavaColor ("冷却熔岩颜色", Color) = (0.3, 0.1, 0.05, 1)

        _Roughness ("岩石粗糙度", Range(0, 1)) = 0.95
        _NormalStrength ("法线强度", Range(0, 2)) = 0.8
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
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _SHADOWS_SOFT

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_LavaRamp); SAMPLER(sampler_LavaRamp);
            TEXTURE2D(_NoiseTex);  SAMPLER(sampler_NoiseTex);
            TEXTURE2D(_CrackTex);  SAMPLER(sampler_CrackTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _LavaRamp_ST;
                float4 _NoiseTex_ST;
                float4 _CrackTex_ST;
                float  _FlowSpeed;
                float4 _FlowDirection;
                float  _WarpStrength;
                float  _WarpScale;
                float  _LavaIntensity;
                float  _CrackWidth;
                float4 _RockColor;
                float4 _CoolLavaColor;
                float  _Roughness;
                float  _NormalStrength;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS    : SV_POSITION;
                float3 worldPos       : TEXCOORD0;
                float3 worldNormal    : TEXCOORD1;
                float3 worldTangent   : TEXCOORD2;
                float3 worldBitangent : TEXCOORD3;
                float2 uv             : TEXCOORD4;
                float4 shadowCoord    : TEXCOORD5;
            };

            float Hash(float2 p)
            {
                p = frac(p * float2(0.1031, 0.1030));
                p += dot(p, p.yx + 33.33);
                return frac((p.x + p.y) * p.x);
            }

            float Noise(float2 p)
            {
                float2 i = floor(p);
                float2 f = frac(p);
                f = f * f * (3.0 - 2.0 * f);
                return lerp(lerp(Hash(i), Hash(i + float2(1,0)), f.x),
                            lerp(Hash(i + float2(0,1)), Hash(i + float2(1,1)), f.x), f.y);
            }

            // 带方向流动的 FBM
            float FlowFBM(float2 p, float2 flowDir, float t)
            {
                const float2x2 m = float2x2(0.80, 0.60, -0.60, 0.80);
                float v = 0.0, a = 0.5, norm = 0.0;

                // 流动：沿方向平移
                p += flowDir * t * _FlowSpeed;

                v += a * Noise(p); norm += a; a *= 0.5; p = mul(m, p) * 2.02;
                v += a * Noise(p); norm += a; a *= 0.5; p = mul(m, p) * 2.03;
                v += a * Noise(p); norm += a; a *= 0.5; p = mul(m, p) * 2.01;
                v += a * Noise(p); norm += a;

                return v / norm;
            }

            Varyings vert(Attributes input)
            {
                Varyings output;
                VertexPositionInputs posInputs = GetVertexPositionInputs(input.positionOS.xyz);
                VertexNormalInputs   norInputs = GetVertexNormalInputs(input.normalOS, input.tangentOS);

                output.positionHCS    = posInputs.positionCS;
                output.worldPos       = posInputs.positionWS;
                output.worldNormal    = norInputs.normalWS;
                output.worldTangent   = norInputs.tangentWS;
                output.worldBitangent = norInputs.bitangentWS;
                output.uv             = TRANSFORM_TEX(input.uv, _NoiseTex);
                output.shadowCoord    = GetShadowCoord(posInputs);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float2 uv = input.uv;
                float  t  = _Time.y;
                float2 flowDir = normalize(_FlowDirection.xy);

                // ---- 域扭曲：两层嵌套 FBM ----
                float2 scaledUV = uv * _WarpScale;

                // 第一层扭曲偏移（带流动方向）
                float2 warp1 = float2(
                    FlowFBM(scaledUV + float2(0, 0), flowDir, t),
                    FlowFBM(scaledUV + float2(5.2, 1.3), flowDir, t)
                ) * 2.0 - 1.0;

                float2 warpedUV1 = uv + warp1 * _WarpStrength;

                // 第二层扭曲（在第一层扭曲后的坐标上再次扭曲，速度稍慢）
                float2 warp2 = float2(
                    FlowFBM(warpedUV1 * _WarpScale + float2(1.7, 9.2), flowDir, t * 0.6),
                    FlowFBM(warpedUV1 * _WarpScale + float2(8.3, 2.8), flowDir, t * 0.6)
                ) * 2.0 - 1.0;

                float2 finalUV = warpedUV1 + warp2 * _WarpStrength * 0.5;

                // ---- 熔岩图案（域扭曲后的 FBM 值）----
                float lavaPattern = FlowFBM(finalUV * _WarpScale, flowDir, t * 0.3);

                // 裂缝贴图（控制熔岩裂缝的形态）
                float crack = SAMPLE_TEXTURE2D(_CrackTex, sampler_CrackTex, finalUV).r;

                // 熔岩值：FBM 图案 + 裂缝叠加
                float lavaVal = lavaPattern * (0.6 + 0.4 * crack);

                // ---- 颜色映射 ----
                // 熔岩渐变：黑色岩石 -> 冷却熔岩（暗红）-> 热熔岩（橙红）-> 中心高温（黄白）
                float3 lavaColor = SAMPLE_TEXTURE2D(_LavaRamp, sampler_LavaRamp,
                    float2(lavaVal, 0.5)).rgb;

                // 岩石/熔岩混合（超过阈值才显示熔岩发光）
                float lavaMask = smoothstep(_CrackWidth, _CrackWidth + 0.1, lavaVal);

                float3 rockColor = lerp(_RockColor.rgb, _CoolLavaColor.rgb, lavaVal * 0.3);
                float3 albedo    = lerp(rockColor, lavaColor, lavaMask);

                // 熔岩自发光（HDR 强度，配合 Bloom 产生辉光）
                float3 emission  = lavaColor * lavaMask * _LavaIntensity;

                // ---- 法线扰动（模拟熔岩表面起伏）----
                float3 n = normalize(input.worldNormal);
                // 通过对 lavaPattern 的有限差分估算表面法线
                float eps = 0.01;
                float dx = FlowFBM((finalUV + float2(eps, 0)) * _WarpScale, flowDir, t * 0.3)
                         - FlowFBM((finalUV - float2(eps, 0)) * _WarpScale, flowDir, t * 0.3);
                float dy = FlowFBM((finalUV + float2(0, eps)) * _WarpScale, flowDir, t * 0.3)
                         - FlowFBM((finalUV - float2(0, eps)) * _WarpScale, flowDir, t * 0.3);

                float3 tangent    = normalize(input.worldTangent);
                float3 bitangent  = normalize(input.worldBitangent);
                float3 bumpNormal = normalize(n + tangent * (-dx * _NormalStrength)
                                              + bitangent * (-dy * _NormalStrength));

                // ---- URP PBR 光照 ----
                Light mainLight = GetMainLight(input.shadowCoord);
                float  NdotL    = saturate(dot(bumpNormal, mainLight.direction));
                float3 diffuse  = mainLight.color * NdotL * mainLight.shadowAttenuation;

                float3 ambient = SampleSH(bumpNormal);

                // 粗糙度随熔岩状态变化：冷却岩石粗糙，热熔岩略微有反光
                float roughness = lerp(_Roughness, 0.3, lavaMask);

                float3 finalColor = albedo * (ambient * 0.3 + diffuse);
                finalColor += emission; // 发光叠加（不受光照影响）

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 在游戏中的实际应用场景

**1. 传送门/空间撕裂**
传送门 Shader 配合 `RenderTexture` 可以实现真正意义上的"透过传送门看到另一个场景"：将目标摄像机渲染到 RenderTexture，作为 `_PortalTex` 传入 Shader，扭曲效果让传送门边缘看起来像空间正在被撕裂。

**2. VFX Graph 粒子扰动**
在 VFX Graph 的 Output Particle Quad 节点中，可以直接引用域扭曲 Shader 作为粒子材质，让每个粒子表面都有流动的扰动效果，适合制作魔法粒子、能量球等效果。

**3. 毒液/水面折射**
在水面 Shader 中，用域扭曲偏移 `_CameraOpaqueTexture`（URP 的 Grab Pass 等价物）的采样坐标，产生透过水面的折射扭曲效果。扭曲强度随波浪高度变化，近处强远处弱。

## ShaderGraph 对应实现思路

域扭曲在 ShaderGraph 中的实现：
- `Tiling and Offset` 节点控制噪波尺度
- `Simple Noise` 或 `Gradient Noise` 节点生成基础噪波
- 用两个独立的噪波节点分别生成 X/Y 扭曲量，合并为 `Vector2`
- `Add` 节点将扭曲量叠加到原始 UV 上
- 重复此过程构建第二层扭曲
- 最终 UV 输入到 `Sample Texture 2D` 节点

ShaderGraph 的限制：多层嵌套 FBM 需要大量节点，逻辑容易变得混乱。建议将 FBM 函数封装为 `Custom Function` 节点，在子图（Sub-Graph）中复用。

## 性能考量

三层域扭曲（3层×4倍频FBM）每像素约执行 36 次噪波采样。以下是各平台的建议配置：

| 平台 | 建议层数 | FBM 倍频程 | 预计开销 |
|------|---------|-----------|---------|
| PC/主机 | 3 层嵌套 | 4-6 频 | 中 |
| 移动端高端 | 2 层嵌套 | 3 频 | 低 |
| 移动端低端 | 1 层扭曲 | 2 频 | 极低 |

**移动端优化技巧**：
- 将 FBM 噪波预烘焙到纹理（256×256 的多通道噪波图），直接采样代替计算，将 ALU 转换为 TEX 带宽
- 使用 `half` 精度代替 `float` 进行噪波计算（移动端 16 位精度通常足够）
- 关闭涡旋变换（省去 sin/cos 计算）

## 常见踩坑

**坑1：`_Time.y` 的精度丢失**
在游戏运行很长时间后（> 几小时），`_Time.y` 的值很大，与小数值相乘时会有精度损失，导致噪波出现规律性图案。解决方案：使用 `frac(_Time.y * speed)` 让时间保持在小数范围内，或改用 C# 脚本每帧传入当前时间。

**坑2：Grab Pass 的性能陷阱**
使用 `_CameraOpaqueTexture` 实现折射时，URP 会在需要时自动复制屏幕颜色。确保在 URP Asset 中启用 `Opaque Texture`，否则 Shader 中采样 `_CameraOpaqueTexture` 只会得到黑色。

**坑3：VR 中的扭曲方向不一致**
在 VR 中，左右眼的视角不同，基于屏幕空间的 UV 扭曲可能在两只眼中产生不一致的效果，造成不适感。建议 VR 中的域扭曲基于世界空间坐标而不是屏幕空间 UV。

**坑4：传送门 ZWrite Off 与深度排序**
传送门是透明物体，需要 `ZWrite Off`。如果场景中有其他透明物体（粒子、玻璃）靠近传送门，可能因排序问题出现错误的叠加顺序。使用 URP 的 `Renderer Feature` 将传送门渲染为独立 Pass，可以绕过透明排序问题。
