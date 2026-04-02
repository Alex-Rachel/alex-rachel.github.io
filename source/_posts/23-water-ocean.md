---
title: Unity Shader 系列（二十三）：URP 水面渲染完整指南
date: 2026-04-24 12:00:00
tags: [HLSL, URP, 水面渲染, Gerstner波, Fresnel]
---

水面渲染是游戏中最考验 Shader 技术综合能力的场景之一——它需要几何波形、Fresnel 反射、折射、焦散、泡沫等多种技术的协同配合。本文以 URP 为目标平台，从 Gerstner 波的顶点着色器实现到完整的低多边形风格水面 Shader，给出可直接在 Unity 项目中使用的代码。

## Gerstner 波：URP 顶点着色器实现

Gerstner 波（余摆线波）比简单的正弦波更接近真实海浪形态——波峰尖锐，波谷平缓，水粒子做圆形运动而非简单上下振动。

```hlsl
Shader "Custom/URP/OceanSurface"
{
    Properties
    {
        // 波形参数
        _WaveAmplitude ("波幅", Float) = 0.5
        _WaveLength ("波长", Float) = 10.0
        _WaveSpeed ("波速", Float) = 1.5
        _WaveSteepness ("波峰陡度（0=正弦, 1=最陡Gerstner）", Range(0, 1)) = 0.5

        // 多波叠加（每个参数 xyz = 方向角, 振幅, 波长）
        _Wave1 ("波1（方向, 振幅, 波长）", Vector) = (1, 0, 0.3, 8)
        _Wave2 ("波2（方向, 振幅, 波长）", Vector) = (0.7, 0.7, 0.2, 5)
        _Wave3 ("波3（方向, 振幅, 波长）", Vector) = (-0.5, 0.866, 0.1, 3)

        // 外观参数
        _ShallowColor ("浅水颜色", Color) = (0.1, 0.6, 0.7, 0.8)
        _DeepColor ("深水颜色", Color) = (0.02, 0.1, 0.3, 1.0)
        _FoamColor ("泡沫颜色", Color) = (0.9, 0.95, 1.0, 1.0)
        _FoamThreshold ("泡沫阈值（深度）", Float) = 0.5
        _Smoothness ("光滑度", Range(0, 1)) = 0.9
        _NormalScale ("法线扰动强度", Float) = 0.5

        // 折射/反射
        _RefractionStrength ("折射强度", Float) = 0.05
        _DepthFogDensity ("深度雾密度", Float) = 0.5
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Transparent-10"
        }

        // 水面不写深度（否则会遮挡水下物体的折射）
        ZWrite Off
        Blend SrcAlpha OneMinusSrcAlpha

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_CASCADE

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareOpaqueTexture.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float _WaveAmplitude;
                float _WaveLength;
                float _WaveSpeed;
                float _WaveSteepness;
                float4 _Wave1; // xy=方向, z=振幅, w=波长
                float4 _Wave2;
                float4 _Wave3;
                float4 _ShallowColor;
                float4 _DeepColor;
                float4 _FoamColor;
                float _FoamThreshold;
                float _Smoothness;
                float _NormalScale;
                float _RefractionStrength;
                float _DepthFogDensity;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionCS   : SV_POSITION;
                float3 positionWS   : TEXCOORD0;
                float3 normalWS     : TEXCOORD1;
                float2 uv           : TEXCOORD2;
                float4 screenPos    : TEXCOORD3; // 屏幕空间坐标（折射/软粒子用）
            };

            // Gerstner 波函数
            // 输入：顶点世界坐标 xz、波方向（归一化）、振幅、波长、陡度、时间
            // 输出：顶点位移和法线贡献
            void GerstnerWave(
                float2 pos, float2 direction, float amplitude,
                float wavelength, float steepness, float time,
                inout float3 displacement, inout float3 normal)
            {
                float k = 2.0 * PI / wavelength;         // 波数
                float c = sqrt(9.8 / k);                 // 相速度（深水波色散关系）
                float2 d = normalize(direction);
                float f = k * (dot(d, pos) - c * time); // 相位

                float Q = steepness / (k * amplitude);   // 归一化陡度

                // Gerstner 位移（水平 + 垂直）
                displacement.x += Q * amplitude * d.x * cos(f);
                displacement.z += Q * amplitude * d.y * cos(f);
                displacement.y += amplitude * sin(f);

                // 法线贡献
                normal.x -= d.x * k * amplitude * cos(f);
                normal.z -= d.y * k * amplitude * cos(f);
                normal.y -= Q * k * amplitude * sin(f);
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;

                // 获取世界坐标
                float3 worldPos = TransformObjectToWorld(IN.positionOS.xyz);
                float time = _Time.y; // Unity 内置时间（等价 ShaderToy 的 iTime）

                // 累积多个 Gerstner 波的位移
                float3 displacement = float3(0, 0, 0);
                float3 normalOffset = float3(0, 0, 0);

                GerstnerWave(worldPos.xz, _Wave1.xy, _Wave1.z, _Wave1.w,
                             _WaveSteepness, time * _WaveSpeed, displacement, normalOffset);
                GerstnerWave(worldPos.xz, _Wave2.xy, _Wave2.z, _Wave2.w,
                             _WaveSteepness * 0.8, time * _WaveSpeed * 1.1, displacement, normalOffset);
                GerstnerWave(worldPos.xz, _Wave3.xy, _Wave3.z, _Wave3.w,
                             _WaveSteepness * 0.5, time * _WaveSpeed * 1.3, displacement, normalOffset);

                worldPos += displacement;

                // 计算世界空间法线
                float3 worldNormal = normalize(float3(
                    normalOffset.x * _NormalScale,
                    1.0 - normalOffset.y * _NormalScale,
                    normalOffset.z * _NormalScale
                ));

                OUT.positionCS = TransformWorldToHClip(worldPos);
                OUT.positionWS = worldPos;
                OUT.normalWS = worldNormal;
                OUT.uv = IN.uv;
                OUT.screenPos = ComputeScreenPos(OUT.positionCS);

                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 screenUV = IN.screenPos.xy / IN.screenPos.w;
                float3 viewDir = normalize(_WorldSpaceCameraPos - IN.positionWS);
                float3 normalWS = normalize(IN.normalWS);

                // ===== 折射（使用 URP Opaque Texture）=====
                // URP 中 GrabPass 已废弃，改用 _CameraOpaqueTexture
                float2 refractionOffset = normalWS.xz * _RefractionStrength;
                float3 refractionColor = SampleSceneColor(screenUV + refractionOffset);

                // ===== 深度雾（水体颜色随深度变化）=====
                float sceneDepth = LinearEyeDepth(
                    SampleSceneDepth(screenUV),
                    _ZBufferParams
                );
                float waterDepth = sceneDepth - IN.screenPos.w;
                float depthFade = saturate(waterDepth / 5.0); // 5 单位深度完全变为深水色

                float3 waterColor = lerp(_ShallowColor.rgb, _DeepColor.rgb, depthFade);
                float3 refractedWater = lerp(refractionColor, waterColor, saturate(waterDepth * _DepthFogDensity));

                // ===== Fresnel 反射 =====
                float NdotV = saturate(dot(normalWS, viewDir));
                float fresnel = pow(1.0 - NdotV, 4.0); // Schlick 近似（F0≈0 时）
                fresnel = lerp(0.02, 1.0, fresnel);     // F0=0.02（水面）

                // 获取反射颜色（使用 Reflection Probe 或天空盒）
                float3 reflectDir = reflect(-viewDir, normalWS);
                half4 reflectionColor = SAMPLE_TEXTURECUBE(unity_SpecCube0, samplerunity_SpecCube0, reflectDir);

                // ===== 泡沫（基于水深）=====
                float foam = smoothstep(_FoamThreshold, 0.0, waterDepth);
                // 添加噪声使泡沫边缘不规则
                float foamNoise = frac(sin(dot(IN.positionWS.xz * 10.0, float2(12.9898, 78.233))) * 43758.5453);
                foam = saturate(foam + foamNoise * 0.1 - 0.05);

                // ===== 光照 =====
                Light mainLight = GetMainLight(TransformWorldToShadowCoord(IN.positionWS));
                float NdotL = saturate(dot(normalWS, mainLight.direction));

                // Blinn-Phong 高光（水面高光）
                float3 halfDir = normalize(mainLight.direction + viewDir);
                float NdotH = saturate(dot(normalWS, halfDir));
                float specular = pow(NdotH, _Smoothness * 256.0) * mainLight.shadowAttenuation;

                // ===== 颜色合成 =====
                float3 finalColor = lerp(refractedWater, reflectionColor.rgb, fresnel);
                finalColor += specular * mainLight.color;
                finalColor = lerp(finalColor, _FoamColor.rgb, foam);

                // 透明度（浅水区更透明）
                float alpha = lerp(_ShallowColor.a, _DeepColor.a, depthFade);

                return half4(finalColor, alpha);
            }
            ENDHLSL
        }
    }
}
```

## Boat Attack 水面分析：Unity 官方 URP 示例

Unity 官方的 Boat Attack 示例项目（GitHub: Unity-Technologies/BoatAttack）是学习 URP 水面渲染的最佳参考。其核心技术点：

- **多层 Gerstner 波**：4 层波叠加，每层不同方向、频率、振幅
- **法线贴图动画**：两张法线贴图以不同速度滚动叠加，增加表面细节
- **岸边泡沫**：基于深度缓冲的程序化泡沫，用 `_CameraDepthTexture` 检测浅水
- **Planar Reflection**：专用相机渲染水面上方场景到 RenderTexture，再在水面 Shader 中采样

## URP Render Texture 实现实时水面反射

平面反射（Planar Reflection）比反射探针精确，适合较平静的水面：

```csharp
// PlanarReflection.cs
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

[RequireComponent(typeof(MeshRenderer))]
public class PlanarReflection : MonoBehaviour
{
    [SerializeField] private int reflectionTextureSize = 512;
    [SerializeField] private float clipPlaneOffset = 0.07f;
    [SerializeField] private LayerMask reflectionLayers = -1;

    private Camera _reflectionCamera;
    private RenderTexture _reflectionTexture;
    private Material _waterMaterial;
    private static readonly int ReflectionTexID = Shader.PropertyToID("_ReflectionTex");

    void Awake()
    {
        _waterMaterial = GetComponent<MeshRenderer>().material;

        // 创建反射相机
        var go = new GameObject("Reflection Camera");
        go.hideFlags = HideFlags.HideAndDontSave;
        _reflectionCamera = go.AddComponent<Camera>();
        _reflectionCamera.enabled = false;
        _reflectionCamera.cullingMask = reflectionLayers;

        _reflectionTexture = new RenderTexture(reflectionTextureSize, reflectionTextureSize, 16);
        _reflectionCamera.targetTexture = _reflectionTexture;
        _waterMaterial.SetTexture(ReflectionTexID, _reflectionTexture);
    }

    void OnWillRenderObject()
    {
        Camera mainCam = Camera.current;
        if (mainCam == null || mainCam == _reflectionCamera) return;

        // 将主相机关于水平面做镜像
        float planeHeight = transform.position.y;
        Vector3 camPos = mainCam.transform.position;
        camPos.y = 2 * planeHeight - camPos.y; // Y 轴镜像

        _reflectionCamera.transform.position = camPos;
        _reflectionCamera.transform.rotation = mainCam.transform.rotation;
        // 翻转 Y 轴
        Vector3 euler = _reflectionCamera.transform.eulerAngles;
        _reflectionCamera.transform.eulerAngles = new Vector3(-euler.x, euler.y, euler.z);

        // 斜裁剪平面（消除水面下方的内容渲染到反射中）
        _reflectionCamera.projectionMatrix = mainCam.projectionMatrix;

        // 渲染
        _reflectionCamera.Render();
    }

    void OnDestroy()
    {
        if (_reflectionCamera) DestroyImmediate(_reflectionCamera.gameObject);
        if (_reflectionTexture) _reflectionTexture.Release();
    }
}
```

## 低多边形风格水面 Shader（完整简化版）

低多边形（Low-Poly）风格水面适合休闲游戏，去掉折射/反射，保留顶点波浪和颜色深度：

```hlsl
Shader "Custom/URP/LowPolyWater"
{
    Properties
    {
        _ShallowColor ("浅水色", Color) = (0.3, 0.8, 0.9, 0.7)
        _DeepColor ("深水色", Color) = (0.05, 0.2, 0.5, 0.9)
        _WaveHeight ("波浪高度", Float) = 0.3
        _WaveSpeed ("波浪速度", Float) = 1.0
        _FogDepth ("颜色深度", Float) = 3.0
    }

    SubShader
    {
        Tags { "RenderType"="Transparent" "RenderPipeline"="UniversalPipeline" "Queue"="Transparent" }
        ZWrite Off
        Blend SrcAlpha OneMinusSrcAlpha

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _ShallowColor, _DeepColor;
                float _WaveHeight, _WaveSpeed, _FogDepth;
            CBUFFER_END

            struct Attributes { float4 posOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; };
            struct Varyings
            {
                float4 posCS : SV_POSITION;
                float3 posWS : TEXCOORD0;
                float3 normalWS : TEXCOORD1;
                float4 screenPos : TEXCOORD2;
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                float3 posWS = TransformObjectToWorld(IN.posOS.xyz);

                // 简单正弦波叠加（低多边形顶点少，Gerstner 效果不明显）
                float t = _Time.y * _WaveSpeed;
                posWS.y += sin(posWS.x * 0.5 + t) * _WaveHeight * 0.5;
                posWS.y += sin(posWS.z * 0.7 + t * 1.3) * _WaveHeight * 0.3;
                posWS.y += sin((posWS.x + posWS.z) * 0.3 + t * 0.8) * _WaveHeight * 0.2;

                OUT.posCS = TransformWorldToHClip(posWS);
                OUT.posWS = posWS;
                OUT.normalWS = TransformObjectToWorldNormal(IN.normalOS);
                OUT.screenPos = ComputeScreenPos(OUT.posCS);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 screenUV = IN.screenPos.xy / IN.screenPos.w;

                // 深度读取（计算水深）
                float sceneRawDepth = SampleSceneDepth(screenUV);
                float sceneLinear = LinearEyeDepth(sceneRawDepth, _ZBufferParams);
                float waterDepth = saturate((sceneLinear - IN.screenPos.w) / _FogDepth);

                // 颜色混合
                float3 color = lerp(_ShallowColor.rgb, _DeepColor.rgb, waterDepth);

                // Fresnel 效果
                float3 viewDir = normalize(_WorldSpaceCameraPos - IN.posWS);
                float fresnel = pow(1.0 - saturate(dot(normalize(IN.normalWS), viewDir)), 3.0);
                color = lerp(color, color * 1.5, fresnel * 0.3);

                // 简单光照
                Light mainLight = GetMainLight();
                float NdotL = saturate(dot(normalize(IN.normalWS), mainLight.direction));
                color *= (NdotL * 0.7 + 0.3);

                float alpha = lerp(_ShallowColor.a, _DeepColor.a, waterDepth);
                return half4(color, alpha);
            }
            ENDHLSL
        }
    }
}
```

## 焦散效果实现方案

URP 中实现水下焦散有两种主流方案：

**方案一：URP Decal Projector**（推荐）
1. 创建 Decal Projector，朝向水底地面
2. 使用程序化焦散纹理（迭代三角函数叠加）作为 Decal 材质
3. 通过动画控制纹理 UV 偏移模拟焦散流动

**方案二：自定义 Shader 混合**
在地面/水底 Shader 中叠加焦散纹理，用世界坐标 Y 值判断是否在水下：

```hlsl
// 在地面 Shader 的 Fragment 中添加
float underwaterFactor = saturate(1.0 - (IN.posWS.y - waterLevel) * 2.0);
if (underwaterFactor > 0.0)
{
    // 程序化焦散（迭代三角函数）
    float2 causticUV = IN.posWS.xz * 0.5;
    float t = _Time.y * 0.5;
    float2 p = frac(causticUV) - 0.5;
    float caustic = 0.0;
    for (int n = 0; n < 5; n++)
    {
        float t2 = t * (1.0 - 3.5 / (float(n) + 1.0));
        p = causticUV + float2(cos(t2 - p.x) + sin(t2 + p.y),
                               sin(t2 - p.y) + cos(t2 + p.x));
        caustic += 1.0 / length(p);
    }
    caustic = pow(caustic / 5.0, 3.0) * 0.3;
    albedo += caustic * underwaterFactor * float3(0.2, 0.5, 0.7);
}
```

## 性能考量与平台适配

| 特性 | PC/主机 | 移动端 |
|------|---------|--------|
| Gerstner 波叠加数 | 4~8 层 | 2~4 层 |
| 法线贴图 | 2 层混合 | 1 层 |
| 折射（Opaque Texture） | 开启 | 关闭（开销大） |
| 平面反射 | 512~1024 分辨率 | 关闭或用反射探针替代 |
| 软粒子/深度读取 | 开启 | 按需开启 |

**踩坑提醒**：URP 的 `_CameraOpaqueTexture`（GrabPass 的替代方案）需要在 URP Asset 中开启 `Opaque Texture`，否则采样结果为黑色。开启后会增加一次全屏拷贝开销，移动端需谨慎。

水面渲染是 Unity Shader 开发中综合难度最高的场景之一，掌握了 Gerstner 波、Fresnel、折射和泡沫的完整实现，你就掌握了游戏中绝大多数水体特效的技术基础。
