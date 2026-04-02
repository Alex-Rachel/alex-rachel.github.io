---
title: Unity Shader 系列（二十七）：Voronoi 在游戏视效中的应用
date: 2026-04-28 12:00:00
tags: [HLSL, URP, Voronoi, 程序化纹理, 破碎效果]
---

Voronoi 噪声（也称 Worley 噪声）将空间划分为以特征点为核心的"细胞区域"，是游戏中皮革纹理、玻璃破碎、裂纹地面、科技感 UI 等视觉效果的核心算法。本文对比 ShaderGraph 内置节点与手写实现，并给出完整的 URP 裂纹地面材质和动态科技感 UI Shader。

## ShaderGraph 的 Voronoi 节点 vs 手写实现

Unity ShaderGraph 提供了内置的 `Voronoi` 节点，但其局限性明显：

| 特性 | ShaderGraph Voronoi 节点 | 手写 HLSL 实现 |
|------|-------------------------|----------------|
| F1 距离 | 支持 | 支持 |
| F2 距离 | 不支持 | 支持 |
| F2-F1（边界） | 不支持 | 支持 |
| 精确边界距离 | 不支持 | 支持 |
| 自定义距离度量 | 不支持 | 支持（曼哈顿、切比雪夫等） |
| 细胞 ID 输出 | 有限 | 完全可控 |
| 动画特征点 | 有限 | 完全可控 |

对于皮革/鳞片/玻璃破碎等高质量效果，建议使用 Custom Function 节点嵌入手写 HLSL，或直接写完整 Shader。

## Voronoi 核心实现（URP HLSL）

```hlsl
// 2D Voronoi 函数（返回 F1, F2, 最近细胞 ID）
// 支持 F1/F2/精确边界三种模式
struct VoronoiResult
{
    float f1;           // 到最近特征点的距离
    float f2;           // 到第二近特征点的距离
    float2 cellID;      // 最近细胞的整数 ID
    float2 cellOffset;  // 特征点相对格子中心的偏移
};

float2 VoronoiHash(float2 p)
{
    p = float2(dot(p, float2(127.1, 311.7)), dot(p, float2(269.5, 183.3)));
    return frac(sin(p) * 43758.5453);
}

// 基础 Voronoi（含 F1 + F2）
VoronoiResult Voronoi2D(float2 x, float animTime)
{
    float2 n = floor(x);
    float2 f = frac(x);

    VoronoiResult result;
    result.f1 = 8.0;
    result.f2 = 8.0;
    result.cellID = n;
    result.cellOffset = 0.0;

    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++)
    {
        float2 g = float2(i, j);
        float2 o = VoronoiHash(n + g);

        // 动画：特征点随时间移动
        o = 0.5 + 0.5 * sin(animTime + 6.2831 * o);

        float2 r = g + o - f;
        float d = dot(r, r); // 欧氏距离平方

        if (d < result.f1)
        {
            result.f2 = result.f1;
            result.f1 = d;
            result.cellID = n + g;
            result.cellOffset = o;
        }
        else if (d < result.f2)
        {
            result.f2 = d;
        }
    }

    result.f1 = sqrt(result.f1);
    result.f2 = sqrt(result.f2);
    return result;
}

// 精确边界距离（两遍算法，用于裂纹效果）
float VoronoiBorder(float2 x, float animTime)
{
    float2 ip = floor(x);
    float2 fp = frac(x);

    // 第一遍：找最近特征点
    float2 mg, mr;
    float md = 8.0;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++)
    {
        float2 g = float2(i, j);
        float2 o = VoronoiHash(ip + g);
        o = 0.5 + 0.5 * sin(animTime + 6.2831 * o);
        float2 r = g + o - fp;
        float d = dot(r, r);
        if (d < md) { md = d; mr = r; mg = g; }
    }

    // 第二遍：精确边界（5×5 范围搜索）
    md = 8.0;
    for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++)
    {
        float2 g = mg + float2(i, j);
        float2 o = VoronoiHash(ip + g);
        o = 0.5 + 0.5 * sin(animTime + 6.2831 * o);
        float2 r = g + o - fp;

        // 对分线距离公式（两个 Voronoi 细胞边界的精确距离）
        if (dot(mr - r, mr - r) > 0.00001)
            md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
    }
    return md;
}
```

## 裂纹地面材质：完整 URP Shader

```hlsl
Shader "Custom/URP/CrackedGround"
{
    Properties
    {
        _BaseColor ("基础颜色（土地）", Color) = (0.4, 0.28, 0.15, 1)
        _CrackColor ("裂缝颜色", Color) = (0.1, 0.05, 0.02, 1)
        _VoronoiScale ("Voronoi 缩放（裂纹密度）", Float) = 5.0
        _CrackWidth ("裂缝宽度", Range(0, 0.1)) = 0.02
        _CrackDepth ("裂缝深度（法线强度）", Float) = 2.0
        _CrackBlend ("裂缝边缘过渡", Range(0, 0.05)) = 0.01
        _SecondaryScale ("二级裂纹缩放", Float) = 15.0
        _SecondaryStrength ("二级裂纹强度", Range(0, 1)) = 0.4
        _DryMudTex ("干土纹理", 2D) = "white" {}
        _TextureScale ("纹理缩放", Float) = 2.0
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_DryMudTex); SAMPLER(sampler_DryMudTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseColor, _CrackColor;
                float _VoronoiScale, _CrackWidth, _CrackDepth, _CrackBlend;
                float _SecondaryScale, _SecondaryStrength;
                float4 _DryMudTex_ST;
                float _TextureScale;
            CBUFFER_END

            struct Attributes { float4 posOS : POSITION; float3 normalOS : NORMAL; float4 tangentOS : TANGENT; float2 uv : TEXCOORD0; };
            struct Varyings
            {
                float4 posCS : SV_POSITION;
                float3 posWS : TEXCOORD0;
                float3 normalWS : TEXCOORD1;
                float3 tangentWS : TEXCOORD2;
                float3 bitangentWS : TEXCOORD3;
                float2 uv : TEXCOORD4;
            };

            float2 VoronoiHash(float2 p)
            {
                p = float2(dot(p, float2(127.1, 311.7)), dot(p, float2(269.5, 183.3)));
                return frac(sin(p) * 43758.5453);
            }

            float VoronoiBorderDist(float2 x)
            {
                float2 ip = floor(x);
                float2 fp = frac(x);
                float2 mg, mr; float md = 8.0;
                for (int j = -1; j <= 1; j++)
                for (int i = -1; i <= 1; i++)
                {
                    float2 g = float2(i, j);
                    float2 o = VoronoiHash(ip + g);
                    float2 r = g + o - fp;
                    float d = dot(r, r);
                    if (d < md) { md = d; mr = r; mg = g; }
                }
                md = 8.0;
                for (int j = -2; j <= 2; j++)
                for (int i = -2; i <= 2; i++)
                {
                    float2 g = mg + float2(i, j);
                    float2 o = VoronoiHash(ip + g);
                    float2 r = g + o - fp;
                    if (dot(mr - r, mr - r) > 0.00001)
                        md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
                }
                return md;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.posCS = TransformObjectToHClip(IN.posOS.xyz);
                OUT.posWS = TransformObjectToWorld(IN.posOS.xyz);
                OUT.normalWS = TransformObjectToWorldNormal(IN.normalOS);
                OUT.tangentWS = TransformObjectToWorldDir(IN.tangentOS.xyz);
                OUT.bitangentWS = cross(OUT.normalWS, OUT.tangentWS) * IN.tangentOS.w;
                OUT.uv = IN.uv;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.posWS.xz; // 使用世界坐标 XZ 驱动 Voronoi（避免 UV 拉伸）

                // 主裂纹
                float crack1 = VoronoiBorderDist(uv * _VoronoiScale);
                float crackMask1 = 1.0 - smoothstep(_CrackWidth - _CrackBlend, _CrackWidth + _CrackBlend, crack1);

                // 二级裂纹（更细小）
                float crack2 = VoronoiBorderDist(uv * _SecondaryScale);
                float crackMask2 = 1.0 - smoothstep(_CrackWidth * 0.5, _CrackWidth, crack2);
                crackMask2 *= _SecondaryStrength;

                float totalCrack = saturate(crackMask1 + crackMask2 * (1.0 - crackMask1));

                // 采样基础纹理
                half4 mudTex = SAMPLE_TEXTURE2D(_DryMudTex, sampler_DryMudTex, IN.uv * _TextureScale);
                half3 baseAlbedo = _BaseColor.rgb * mudTex.rgb;

                // 颜色混合
                half3 finalAlbedo = lerp(baseAlbedo, _CrackColor.rgb, totalCrack);

                // 法线扰动（裂缝处法线向下倾斜）
                // 通过有限差分计算 Voronoi 的梯度作为法线贡献
                float e = 0.01;
                float d_dx = VoronoiBorderDist((uv + float2(e, 0)) * _VoronoiScale) -
                             VoronoiBorderDist((uv - float2(e, 0)) * _VoronoiScale);
                float d_dz = VoronoiBorderDist((uv + float2(0, e)) * _VoronoiScale) -
                             VoronoiBorderDist((uv - float2(0, e)) * _VoronoiScale);
                float3 crackNormalTS = normalize(float3(
                    d_dx * _CrackDepth * totalCrack,
                    1.0,
                    d_dz * _CrackDepth * totalCrack
                ));

                // 切线空间法线转世界空间
                float3x3 TBN = float3x3(
                    normalize(IN.tangentWS),
                    normalize(IN.bitangentWS),
                    normalize(IN.normalWS)
                );
                float3 normalWS = normalize(mul(crackNormalTS, TBN));

                // 光照
                Light mainLight = GetMainLight(TransformWorldToShadowCoord(IN.posWS));
                float NdotL = saturate(dot(normalWS, mainLight.direction));
                half3 ambient = SampleSH(normalWS);
                half3 finalColor = finalAlbedo * (ambient + mainLight.color * NdotL * mainLight.shadowAttenuation);

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 动态科技感 UI Shader（Voronoi 六边形网格 + 扫描线）

```hlsl
Shader "Custom/URP/TechHUD"
{
    Properties
    {
        _CellScale ("细胞缩放", Float) = 8.0
        _EdgeColor ("边缘颜色", Color) = (0.0, 0.8, 1.0, 1.0)
        _CellColor ("细胞颜色", Color) = (0.0, 0.1, 0.2, 1.0)
        _EdgeWidth ("边缘宽度", Range(0, 0.1)) = 0.03
        _ScanSpeed ("扫描线速度", Float) = 0.5
        _ScanFrequency ("扫描线频率", Float) = 10.0
        _ScanAlpha ("扫描线强度", Range(0, 1)) = 0.3
        _GlowPulse ("光芒脉冲速度", Float) = 1.5
        _ActiveCells ("激活细胞比例（0=全暗, 1=全亮）", Range(0, 1)) = 0.5
    }

    SubShader
    {
        Tags { "RenderType"="Transparent" "RenderPipeline"="UniversalPipeline" "Queue"="Overlay" }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off ZTest Always

        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float _CellScale;
                float4 _EdgeColor, _CellColor;
                float _EdgeWidth;
                float _ScanSpeed, _ScanFrequency, _ScanAlpha;
                float _GlowPulse;
                float _ActiveCells;
            CBUFFER_END

            struct Attributes { float4 posOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings { float4 posCS : SV_POSITION; float2 uv : TEXCOORD0; };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.posCS = TransformObjectToHClip(IN.posOS.xyz);
                OUT.uv = IN.uv;
                return OUT;
            }

            float2 VoronoiHash(float2 p)
            {
                p = float2(dot(p, float2(127.1, 311.7)), dot(p, float2(269.5, 183.3)));
                return frac(sin(p) * 43758.5453);
            }

            // F1 + 细胞 ID Voronoi
            float4 Voronoi(float2 x)
            {
                float2 n = floor(x);
                float2 f = frac(x);
                float md = 8.0;
                float2 nearCell = n;

                for (int j = -1; j <= 1; j++)
                for (int i = -1; i <= 1; i++)
                {
                    float2 g = float2(i, j);
                    float2 o = VoronoiHash(n + g);
                    float2 r = g + o - f;
                    float d = dot(r, r);
                    if (d < md) { md = d; nearCell = n + g; }
                }
                return float4(sqrt(md), 0, nearCell);
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.uv;
                float aspect = _ScreenParams.x / _ScreenParams.y;
                uv.x *= aspect;
                uv *= _CellScale;

                float4 v = Voronoi(uv);
                float f1 = v.x;
                float2 cellID = v.zw;

                // 细胞随机激活（基于细胞 ID 的哈希）
                float cellRand = frac(sin(dot(cellID, float2(12.9898, 78.233))) * 43758.5453);
                bool isCellActive = cellRand < _ActiveCells;

                // 边缘高亮
                float edgeMask = 1.0 - smoothstep(_EdgeWidth - 0.005, _EdgeWidth + 0.005, f1);

                // 细胞内部亮度（激活细胞有微弱内部光）
                float cellInterior = (1.0 - smoothstep(0.0, 0.5, f1)) * (isCellActive ? 0.3 : 0.0);

                // 脉冲动画（边缘随时间闪烁）
                float pulse = 0.6 + 0.4 * sin(_Time.y * _GlowPulse + cellRand * 6.28);

                // 颜色合成
                half3 color = _CellColor.rgb;
                color += _EdgeColor.rgb * edgeMask * pulse;
                color += _EdgeColor.rgb * cellInterior;

                // 扫描线效果
                float scanLine = sin(IN.uv.y * _ScanFrequency * 3.14159 - _Time.y * _ScanSpeed) * 0.5 + 0.5;
                scanLine = pow(scanLine, 4.0); // 锐化扫描线
                color += _EdgeColor.rgb * scanLine * _ScanAlpha;

                // Alpha：边缘和激活细胞可见
                float alpha = edgeMask * _EdgeColor.a + cellInterior * 0.5;
                alpha = saturate(alpha);

                return half4(color, alpha);
            }
            ENDHLSL
        }
    }
}
```

## Voronoi Distance Field：程序化破碎效果

Voronoi 距离场可以驱动网格破碎效果，配合顶点 Shader 让每个"碎片"沿 Voronoi 细胞 ID 确定的方向飞散：

```hlsl
// 顶点着色器中实现破碎效果
Varyings vert(Attributes IN)
{
    Varyings OUT;

    // 在世界空间计算 Voronoi 细胞 ID
    float3 posWS = TransformObjectToWorld(IN.posOS.xyz);
    float2 voroUV = posWS.xz * _FragmentScale;

    float4 v = Voronoi(voroUV);
    float2 cellID = v.zw;

    // 基于细胞 ID 计算飞散方向（每个碎片独立方向）
    float2 cellHash = VoronoiHash(cellID);
    float3 flyDir = normalize(float3(
        cellHash.x * 2.0 - 1.0,
        abs(cellHash.y) + 0.3, // 向上飞散
        cellHash.x * cellHash.y * 2.0 - 1.0
    ));

    // 根据破碎进度（_BreakAmount: 0=完整, 1=完全破碎）偏移顶点
    float3 displacement = flyDir * _BreakAmount * 2.0;
    posWS += displacement;

    // 旋转（每个碎片随机旋转）
    float rotAngle = _BreakAmount * 6.28 * (cellHash.x - 0.5);
    // 绕飞散方向轴旋转（简化版）
    posWS += cross(flyDir, posWS - TransformObjectToWorld(float3(0,0,0))) * sin(rotAngle) * _BreakAmount * 0.1;

    OUT.posCS = TransformWorldToHClip(posWS);
    // ... 其他输出
    return OUT;
}
```

## ShaderGraph 实现思路

1. **Custom Function 节点**：粘贴 `VoronoiBorderDist` 函数（ShaderGraph 内置 Voronoi 节点不支持精确边界）
2. **Voronoi 节点**（简单版可用）：Cell Density 控制密度，Angle Offset 控制随机性
3. **One Minus + Step**：将 F1 距离转换为边缘遮罩
4. **Normal From Height**：将 Voronoi 距离值转换为法线贴图（裂纹高度信息）
5. **Lerp**：在基础颜色和裂纹颜色之间混合

## 性能考量

| 方案 | 搜索邻居数 | 适用场景 |
|------|-----------|----------|
| 基础 F1（3×3） | 9 | 一般纹理、手机端 |
| F1+F2（3×3） | 9 | 边缘检测、细胞着色 |
| 精确边界（5×5） | 25 | 高质量裂纹材质 |
| 3D Voronoi（3×3×3） | 27 | 体积纹理（云、火焰） |

**踩坑提醒**：Voronoi 的哈希函数在某些 GPU 上（特别是 Adreno 系列）使用 `sin` 函数计算时精度不稳定。如果出现闪烁或噪点，改用整数位运算哈希：

```hlsl
// 更稳定的哈希（避免 sin 精度问题）
float2 SafeHash(float2 p)
{
    uint2 q = uint2(p);
    q = q * uint2(1597334673U, 3812015801U);
    q = (q.x ^ q.y) * uint2(1597334673U, 3812015801U);
    return float2(q) / float(0xFFFFFFFFU);
}
```

Voronoi 噪声是游戏程序化内容的瑞士军刀——从微观的皮革纹理到宏观的地图划分，从静态的材质到动态的 UI，都能找到它的身影。理解其数学本质（最近邻空间划分），才能真正灵活运用各种变体。
