---
title: Unity Shader 系列（十九）：Unity 天空系统深度指南：从 Skybox 到程序化大气散射
date: 2026-04-01 12:00:00
tags: [HLSL, URP, 大气散射, 天空盒, 程序化天空]
categories:
  - Unity Shader 系列
  - 体积与大气
---

天空是游戏场景的"第一印象"——蔚蓝的晴天、橙红的日落、阴郁的暴风雨前夕，天空的颜色和光照决定了整个场景的基调。Unity URP 提供了从简单天空盒到完整物理大气散射的完整工具链。本文深入讲解 Unity 天空系统的每个层次：URP 内置 Sky 组件的配置、自定义 Skybox Shader 的编写，以及在地面 Shader 中正确读取天空颜色用于环境光和反射。

## Unity 天空系统的层次结构

```
Unity URP 天空系统
├── Lighting 窗口 → Environment → Skybox Material
│   ├── 内置天空盒（Procedural/6-Sided/Cubemap）
│   └── 自定义 Skybox Shader（本文重点）
│
├── URP Volume → Visual Environment（HDRP 专用，URP 中通过 Volume Profile）
│   └── Physical Sky / Procedural Sky
│
├── 环境光采样
│   ├── SampleSH()：从天空 SH 数据读取
│   └── 反射探针：从天空盒生成的 Cubemap
│
└── 天空贡献到地面 Shader
    ├── 间接光漫反射（SH / Light Probe）
    └── 间接光镜面反射（Reflection Probe Cubemap）
```

## 方案一：Unity 内置 Procedural Sky 配置

最简单的方案：使用 Unity 内置的 Procedural Skybox，不需要写任何代码：

1. Window → Rendering → Lighting → Environment
2. Skybox Material → 选择 `Skybox/Procedural` Shader
3. 创建 Material，调整以下参数：

```
Sun Size：太阳圆盘大小（0.04 是现实比例）
Sun Size Convergence：太阳晕圈锐度
Atmosphere Thickness：大气厚度（1.0 = 地球，>1 = 更厚更蓝）
Sky Tint：天空颜色偏移
Ground：地平线以下的颜色
Exposure：整体曝光
```

**何时选择内置 Procedural Sky**：原型阶段、非重要场景、移动端性能敏感项目。

## 方案二：自定义 Skybox Shader（完整实现）

当需要完全控制天空外观，或者实现时间流逝（日出/日落变化）时，需要自定义 Skybox Shader。

```hlsl
Shader "Custom/URP/ProceduralSkybox"
{
    Properties
    {
        // 太阳参数
        _SunColor ("太阳颜色", Color) = (1.0, 0.95, 0.8, 1)
        _SunIntensity ("太阳强度", Range(1, 50)) = 15.0
        _SunSize ("太阳大小", Range(0.001, 0.1)) = 0.04
        _SunBloom ("太阳光晕大小", Range(0.01, 0.5)) = 0.15

        // 大气参数（物理近似）
        _RayleighCoeff ("瑞利系数", Range(0, 5)) = 1.0   // 越大越蓝
        _MieCoeff ("米散射系数", Range(0, 5)) = 0.3       // 越大日周围越白
        _MieG ("Mie g 值", Range(0.5, 0.99)) = 0.76       // 前向散射强度

        // 天空颜色
        _ZenithColor ("天顶颜色", Color) = (0.05, 0.15, 0.5, 1)
        _HorizonColor ("地平线颜色", Color) = (0.4, 0.6, 0.8, 1)
        _GroundColor ("地面颜色（天空盒下半球）", Color) = (0.2, 0.18, 0.15, 1)

        // 时间参数（通过脚本传入）
        _SunAltitude ("太阳高度角（弧度）", Range(-1.57, 1.57)) = 0.5
        _SunAzimuth ("太阳方位角（弧度）", Range(0, 6.28)) = 0.0
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Background"
            "Queue" = "Background"
            "PreviewType" = "Skybox"
        }

        Cull Off
        ZWrite Off

        Pass
        {
            HLSLPROGRAM
            #pragma vertex SkyboxVert
            #pragma fragment SkyboxFrag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _SunColor;
                float  _SunIntensity;
                float  _SunSize;
                float  _SunBloom;
                float  _RayleighCoeff;
                float  _MieCoeff;
                float  _MieG;
                float4 _ZenithColor;
                float4 _HorizonColor;
                float4 _GroundColor;
                float  _SunAltitude;
                float  _SunAzimuth;
            CBUFFER_END

            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float3 rayDir : TEXCOORD0; };

            Varyings SkyboxVert(Attributes input)
            {
                Varyings output;
                // 天空盒顶点变换：剥离位移，只保留旋转（天空盒不随相机位移）
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                // 将顶点方向作为射线方向（物体空间 -> 世界空间旋转部分）
                output.rayDir      = TransformObjectToWorld(input.positionOS.xyz);
                return output;
            }

            // 瑞利相位函数
            float PhaseRayleigh(float cosTheta)
            {
                return 3.0 / (16.0 * 3.14159) * (1.0 + cosTheta * cosTheta);
            }

            // Henyey-Greenstein 米散射相位函数
            float PhaseMie(float cosTheta, float g)
            {
                float g2  = g * g;
                float num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
                float den = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
                return 3.0 / (8.0 * 3.14159) * num / den;
            }

            // 快速大气散射近似（不做全光线步进，使用解析近似）
            // 足够用于天空盒，不需要完整的光线步进积分
            float3 CalculateSkyColor(float3 rayDir, float3 sunDir)
            {
                float  cosTheta  = dot(rayDir, sunDir);
                float  elevation = rayDir.y; // -1 到 1（-1=正下，1=正上）

                // ---- 瑞利散射（蓝天）----
                // β_R(λ) ∝ 1/λ^4，RGB 分量近似比例
                float3 betaRayleigh = float3(5.5e-6, 13.0e-6, 22.4e-6) * _RayleighCoeff * 1e6;

                // 大气厚度近似（光程长度随仰角的变化）
                float opticalDepth = max(0.0, 1.0 / (max(elevation, 0.03) + 0.1));
                opticalDepth = min(opticalDepth, 20.0); // 防止地平线处爆炸

                // 瑞利散射颜色（天空基础蓝色）
                float3 rayleigh = betaRayleigh * PhaseRayleigh(cosTheta) * opticalDepth;

                // ---- 米散射（太阳周围白色晕圈）----
                float  betaMie = 21e-6 * _MieCoeff * 1e6;
                float3 mie     = betaMie * PhaseMie(cosTheta, _MieG) * opticalDepth * 0.5;

                // ---- Beer-Lambert 透射率 ----
                float3 extinction = exp(-(betaRayleigh + betaMie) * opticalDepth);

                // ---- 组合 ----
                // 入射太阳光颜色（经过大气衰减）
                float3 sunTransmit = exp(-(betaRayleigh + betaMie) *
                    max(0.0, 1.0 / (max(sunDir.y, 0.01) + 0.1)));

                float3 scatter = (rayleigh * float3(0.55, 0.75, 1.0) + mie * float3(1.0, 0.95, 0.85))
                               * sunTransmit * 20.0;

                return scatter;
            }

            half4 SkyboxFrag(Varyings input) : SV_Target
            {
                float3 rayDir = normalize(input.rayDir);

                // 从高度角/方位角计算太阳方向
                float3 sunDir = float3(
                    cos(_SunAltitude) * sin(_SunAzimuth),
                    sin(_SunAltitude),
                    cos(_SunAltitude) * cos(_SunAzimuth)
                );
                sunDir = normalize(sunDir);

                // ---- 大气散射颜色 ----
                float3 skyColor = CalculateSkyColor(rayDir, sunDir);

                // ---- 天顶到地平线渐变（叠加在散射之上）----
                float  elevation = rayDir.y;
                float  zenithT   = saturate(elevation);
                float  horizT    = smoothstep(-0.05, 0.3, elevation);
                float3 gradient  = lerp(_GroundColor.rgb, _HorizonColor.rgb, horizT);
                gradient = lerp(gradient, _ZenithColor.rgb, zenithT * zenithT);

                // 散射与渐变混合
                float3 sky = gradient + skyColor;

                // ---- 太阳圆盘 ----
                float cosAngle = dot(rayDir, sunDir);
                // 太阳圆盘（硬边缘 + smoothstep 抗锯齿）
                float sunDisk = smoothstep(_SunSize, _SunSize - 0.002, acos(saturate(cosAngle)));
                // 太阳光晕（柔和辉光）
                float sunBloom = pow(max(cosAngle, 0.0), 1.0 / max(_SunBloom, 0.001));

                float3 sunContrib = _SunColor.rgb * _SunIntensity * (sunDisk + sunBloom * 0.2);

                // 日落时太阳颜色变暖（太阳接近地平线时更偏红）
                float  sunElevation = sunDir.y;
                float3 sunsetTint   = lerp(float3(1.0, 0.4, 0.1), float3(1.0, 0.95, 0.8),
                                          saturate(sunElevation * 3.0));
                sunContrib *= sunsetTint;

                // 夜晚：太阳低于地平线时淡出
                float daytime = smoothstep(-0.1, 0.1, sunDir.y);
                sky       *= daytime;
                sunContrib *= daytime;

                float3 finalColor = sky + sunContrib;

                // 简单曝光（确保颜色范围合理）
                finalColor = 1.0 - exp(-finalColor * 0.5);

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 通过 C# 控制时间变化

```csharp
using UnityEngine;

// 挂载到场景中任意 GameObject，控制昼夜循环
public class DayNightCycle : MonoBehaviour
{
    [Header("天空盒 Material")]
    [SerializeField] private Material skyboxMaterial;

    [Header("时间设置")]
    [SerializeField] private float dayDurationSeconds = 120f;  // 完整一天的时长
    [SerializeField] [Range(0, 1)] private float currentTime = 0.25f;  // 0=午夜, 0.25=日出, 0.5=正午, 0.75=日落

    [Header("光源")]
    [SerializeField] private Light sunLight;  // 主方向光（代表太阳）

    private static readonly int SunAltitudeID = Shader.PropertyToID("_SunAltitude");
    private static readonly int SunAzimuthID  = Shader.PropertyToID("_SunAzimuth");

    void Update()
    {
        // 推进时间
        currentTime += Time.deltaTime / dayDurationSeconds;
        currentTime  = Mathf.Repeat(currentTime, 1.0f);

        // 计算太阳角度
        // 一天 = 2π，日出(0.25) = 0°，正午(0.5) = 90°，日落(0.75) = 180°
        float timeOfDay = (currentTime - 0.25f) * 2.0f * Mathf.PI;
        float sunAltitude = Mathf.Sin(timeOfDay);  // -1 到 1（弧度的 sin 值）
        float sunAzimuth  = 0.0f;

        // 转换为弧度传入 Shader
        float altitudeRad = Mathf.Asin(Mathf.Clamp(sunAltitude, -1, 1));

        if (skyboxMaterial != null)
        {
            skyboxMaterial.SetFloat(SunAltitudeID, altitudeRad);
            skyboxMaterial.SetFloat(SunAzimuthID,  sunAzimuth);
        }

        // 同步更新主方向光
        if (sunLight != null)
        {
            float lightAltDeg = altitudeRad * Mathf.Rad2Deg;
            sunLight.transform.rotation = Quaternion.Euler(-lightAltDeg, sunAzimuth, 0);

            // 日落时光源颜色变暖
            float sunset = 1.0f - Mathf.Clamp01(Mathf.Abs(altitudeRad) / 0.5f);
            sunLight.color = Color.Lerp(Color.white, new Color(1.0f, 0.4f, 0.15f), sunset * 0.7f);

            // 太阳低于地平线时关闭
            sunLight.intensity = Mathf.Clamp01(altitudeRad / 0.1f) * 1.5f;
        }

        // 更新环境光（让场景 GI 反映天空颜色变化）
        DynamicGI.UpdateEnvironment();
    }
}
```

## 在地面 Shader 中读取天空颜色

地面 Shader 需要正确地接收来自天空的环境光，才能与天空盒融为一体：

```hlsl
// 在地面 Shader 的 frag 中：

// 方法一：SampleSH（读取天空光 SH 系数，最常用）
// 返回来自所有方向的间接漫反射光照
float3 skyAmbient = SampleSH(worldNormal);
// 将天空环境光与表面颜色相乘
float3 indirectLight = albedo * skyAmbient * occlusion;

// 方法二：反射探针（读取天空盒生成的 Cubemap）
// 适用于有镜面反射的表面（金属地板、湿地面）
float3 reflectDir       = reflect(-viewDir, worldNormal);
float  perceptualRough  = 1.0 - smoothness;
float3 skyReflection    = GlossyEnvironmentReflection(
    reflectDir,
    worldPos,
    perceptualRough,
    occlusion
);

// 方法三：手动读取 SH 系数（精细控制）
// unity_SHAr, unity_SHAg, unity_SHAb 是 L1 项
// unity_SHBr, unity_SHBg, unity_SHBb 是 L2 项
// unity_SHC 是 L2 x^2-y^2 项
float3 skyColorFromSH = SampleSH(worldNormal);  // 内部就是使用上面这些 uniform
```

## HDRI 天空盒 vs 程序化天空的选择与组合

| 方案 | 制作成本 | 动态性 | 视觉质量 | 性能 |
|------|---------|-------|---------|------|
| 内置 Procedural Skybox | 极低 | 完全动态 | 中 | 极低 |
| 本文程序化 Shader | 低 | 完全动态 | 高 | 低 |
| HDRI 天空盒（.hdr 文件） | 中（需要外部素材） | 静态（或手动切换） | 极高（真实照片/渲染） | 极低 |
| Unity Volumetric Clouds | 中（Unity 内置） | 实时动态 | 极高 | 中 |

**实际项目建议的组合策略**：

- **美术质量优先**：HDRI 天空盒（Polyhaven/KatPack 等免费素材）+ 静态反射探针
- **支持昼夜循环**：程序化天空盒 Shader + 动态反射探针更新（每 N 秒更新一次）
- **最高质量**：Volumetric Clouds + 程序化天空（Unity 2022+ HDRP/URP）
- **移动端优化**：简单渐变天空盒（6-Sided，低分辨率）+ 预烘焙光照贴图

## ShaderGraph 对应实现思路

程序化天空在 ShaderGraph 中的实现：
1. 使用 `View Direction` 节点获取观察方向（同时作为天空采样方向）
2. 用 `Vector3` + `Rotate About Axis` 构建太阳方向向量
3. `Dot Product` 计算观察方向与太阳方向的夹角（`cosTheta`）
4. 自定义 `Custom Function` 节点封装瑞利/米散射计算
5. 最终结果输出到 `Unlit` Master Stack 的 `Color` 输入

注意：Skybox Shader 不能在 ShaderGraph 中直接创建，因为 ShaderGraph 不支持 `"Queue" = "Background"` 和 `"PreviewType" = "Skybox"` 这样的 SubShader Tags。需要将 ShaderGraph 生成的代码复制出来，在文本 Shader 中修改这些 Tags，或者直接用 HLSL 手写。

## 常见踩坑

**坑1：天空盒 Material 的更新与 GI 同步**
修改天空盒 Material 的属性后（如改变太阳位置），场景的 GI（环境光 SH）不会自动更新，必须调用 `DynamicGI.UpdateEnvironment()` 才能让天空变化反映到场景光照上。这个调用有 CPU 开销，建议限制频率（每帧或每 0.5 秒调用一次）。

**坑2：反射探针的更新延迟**
使用实时反射探针（`Reflection Probe Type = Realtime`）跟踪天空变化时，默认的更新频率是 `Every Frame`，但每帧渲染完整的 Cubemap（6 面）开销很大。建议使用 `Via Scripting` 模式，在时间变化较大时才触发更新：

```csharp
// 仅在天空有明显变化时更新反射探针
if (Mathf.Abs(currentTime - lastReflectionUpdateTime) > 0.05f)
{
    reflectionProbe.RenderProbe();
    lastReflectionUpdateTime = currentTime;
}
```

**坑3：Skybox 中 SV_POSITION 的精度**
天空盒渲染时，顶点坐标的 W 分量通常设置为与 Z 相同（确保天空盒始终渲染在最远处）。在 URP 中使用 `TransformObjectToHClip` 已经处理了这个问题。但如果手动计算 NDC 坐标，需要确保输出 `positionHCS` 的 z = w（将深度设为最大）：
```hlsl
output.positionHCS.z = output.positionHCS.w; // 天空盒深度 = 1（最远）
```

**坑4：HDR 天空盒颜色超过 1**
在 HDR 管线中，天空盒颜色可以超过 1（比如太阳圆盘），这些高亮区域会被 Bloom 后处理放大。如果 HDR 未开启，超过 1 的颜色会被截断，太阳看起来没有辉光。确保 Camera → Allow HDR 已勾选，并在 URP Asset 中开启 HDR。
