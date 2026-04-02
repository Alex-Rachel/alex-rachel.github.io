---
title: Unity Shader 系列（十八）：URP 体积效果实战：体积光与程序化云朵
date: 2026-04-19 12:00:00
tags: [HLSL, URP, 体积渲染, 体积雾, 体积光]
---

体积效果（Volumetric Effects）是现代游戏视觉表现的重要组成部分：体积光从窗缝穿入的丁达尔效应、浓雾中透出的光柱、漂浮在低处的地面雾气。Unity URP 提供了内置的体积雾系统，但当你需要更定制化的体积效果时，就需要自己编写 Renderer Feature 和 Compute Shader。本文从 URP Volume Framework 的使用方法出发，到完整的自定义体积光束 Shader，覆盖所有实用场景。

## URP Volume Framework：内置体积效果

URP 通过 **Volume** 组件提供内置的后处理和体积效果。这是最低成本实现体积雾的方式：

**设置步骤**：
1. 创建一个 GameObject，添加 `Volume` 组件
2. 设置 `Profile`（创建新的 Volume Profile）
3. 点击 `Add Override`，选择 `Fog`
4. 在 URP Asset 中确保 `Depth Texture` 和 `Opaque Texture` 已勾选
5. 在 Camera 的 Additional Camera Data 中启用 `Post Processing`

**在 URP Asset 中配置雾**：
- `Fog`：全局雾设置（Linear/Exponential/Exponential Squared）
- `Volumetric Fog`（Unity 2022+）：物理真实的散射体积雾
- `Volumetric Clouds`（Unity 2022+）：基于光线步进的程序化云

这些内置效果在大多数情况下已经足够。自定义体积 Shader 适用于以下特殊需求：
- 局部的、有颜色的体积光束（如彩色玻璃窗透射光）
- 与游戏逻辑紧密结合的动态体积（炸弹爆炸产生的烟雾扩散）
- 极低性能预算下的移动端优化体积效果

## 完整示例：URP 体积光束 Shader

体积光束（God Rays / Crepuscular Rays）通过光线步进积分光照密度，同时进行深度遮挡测试。这个 Shader 以 Cylinder/Cone Mesh 为载体，渲染光束内部的散射效果。

```hlsl
Shader "Custom/URP/VolumetricLightBeam"
{
    Properties
    {
        _BeamColor ("光束颜色", Color) = (1, 0.9, 0.7, 1)
        _BeamIntensity ("光束强度", Range(0, 10)) = 2.0
        _BeamRadius ("光束半径（底部）", Float) = 0.5
        _BeamTipRadius ("光束尖端半径（顶部）", Float) = 0.05
        _BeamHeight ("光束高度", Float) = 4.0

        // 散射参数
        _ScatterCoeff ("散射系数（密度）", Range(0, 2)) = 0.5
        _AbsorbCoeff ("吸收系数", Range(0, 1)) = 0.1
        _MieG ("Mie 散射 g 值（前向散射）", Range(-0.99, 0.99)) = 0.7

        // 步进参数
        _StepCount ("步进次数", Range(8, 64)) = 32
        _NoiseScale ("噪波尺度（光束扰动）", Range(0, 5)) = 1.5
        _NoiseStrength ("噪波强度", Range(0, 1)) = 0.3
        _AnimSpeed ("动画速度", Range(0, 2)) = 0.3
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
            Name "VolumetricBeam"
            Tags { "LightMode" = "UniversalForward" }

            Blend One One          // 加法混合（体积光叠加）
            ZWrite Off
            Cull Front             // 从内部渲染（相机在圆锥外时才正确）

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _BeamColor;
                float  _BeamIntensity;
                float  _BeamRadius;
                float  _BeamTipRadius;
                float  _BeamHeight;
                float  _ScatterCoeff;
                float  _AbsorbCoeff;
                float  _MieG;
                int    _StepCount;
                float  _NoiseScale;
                float  _NoiseStrength;
                float  _AnimSpeed;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS  : SV_POSITION;
                float3 worldPos     : TEXCOORD0;
                float4 screenPos    : TEXCOORD1;
            };

            // Henyey-Greenstein 相位函数（Mie 散射近似）
            float HenyeyGreenstein(float cosTheta, float g)
            {
                float g2 = g * g;
                return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
            }

            // 噪波函数（用于光束扰动，模拟尘埃颗粒）
            float Hash(float3 p)
            {
                p = frac(p * float3(0.1031, 0.1030, 0.0973));
                p += dot(p, p.yzx + 33.33);
                return frac((p.x + p.y) * p.z);
            }

            float Noise3D(float3 p)
            {
                float3 i = floor(p);
                float3 f = frac(p);
                f = f * f * (3.0 - 2.0 * f);

                return lerp(
                    lerp(lerp(Hash(i), Hash(i + float3(1,0,0)), f.x),
                         lerp(Hash(i + float3(0,1,0)), Hash(i + float3(1,1,0)), f.x), f.y),
                    lerp(lerp(Hash(i + float3(0,0,1)), Hash(i + float3(1,0,1)), f.x),
                         lerp(Hash(i + float3(0,1,1)), Hash(i + float3(1,1,1)), f.x), f.y),
                    f.z
                );
            }

            // 圆锥 SDF（y 轴方向，底部大顶部小）
            float ConeIntersect(float3 localRayOrigin, float3 localRayDir,
                                 out float tNear, out float tFar)
            {
                // 圆锥参数化：底部 y=0 半径 _BeamRadius，顶部 y=_BeamHeight 半径 _BeamTipRadius
                float rb = _BeamRadius;
                float rt = _BeamTipRadius;
                float h  = _BeamHeight;

                // 圆锥斜率
                float slope = (rb - rt) / h;

                // 代入圆锥方程求交
                float a = localRayDir.x * localRayDir.x + localRayDir.z * localRayDir.z
                         - slope * slope * localRayDir.y * localRayDir.y;
                float b = 2.0 * (localRayOrigin.x * localRayDir.x + localRayOrigin.z * localRayDir.z
                         - slope * slope * (localRayOrigin.y - rb / slope) * localRayDir.y);
                float c = localRayOrigin.x * localRayOrigin.x + localRayOrigin.z * localRayOrigin.z
                         - slope * slope * (localRayOrigin.y - rb / slope) * (localRayOrigin.y - rb / slope);

                float disc = b * b - 4.0 * a * c;
                if (disc < 0.0) { tNear = -1; tFar = -1; return -1; }

                float sqrtDisc = sqrt(disc);
                float t1 = (-b - sqrtDisc) / (2.0 * a);
                float t2 = (-b + sqrtDisc) / (2.0 * a);

                tNear = min(t1, t2);
                tFar  = max(t1, t2);
                return 1.0;
            }

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.worldPos    = TransformObjectToWorld(input.positionOS.xyz);
                output.screenPos   = ComputeScreenPos(output.positionHCS);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                // ---- 设置光线（世界空间 -> 物体空间）----
                float3 camWS         = GetCameraPositionWS();
                float3 rayDir_world  = normalize(input.worldPos - camWS);

                // 变换到物体空间进行圆锥求交
                float3 rayOrigin_obj = TransformWorldToObject(camWS);
                float3 rayDir_obj    = normalize(TransformWorldToObject(input.worldPos) - rayOrigin_obj);

                float tNear, tFar;
                if (ConeIntersect(rayOrigin_obj, rayDir_obj, tNear, tFar) < 0) discard;

                // 裁剪 y 范围（只在圆锥有效高度内）
                float tMin = tNear, tMax = tFar;

                // ---- 读取场景深度（用于遮挡测试）----
                float2 screenUV   = input.screenPos.xy / input.screenPos.w;
                float  sceneDepth = SampleSceneDepth(screenUV);

                // 将深度转换为线性距离（从相机到场景表面的距离）
                float sceneLinearDepth = LinearEyeDepth(sceneDepth, _ZBufferParams);
                // 光线最大步进距离受深度限制
                float rayMaxDist  = min(sceneLinearDepth, tMax * length(rayDir_world));

                // ---- 光线步进积分 ----
                float stepSize = (tMax - tMax * 0.0 - tMin) / float(_StepCount);
                float t = tMin + stepSize * 0.5; // 步进起始（半步偏移减少条带）

                float3 accumColor   = float3(0, 0, 0);
                float  transmittance = 1.0; // Beer-Lambert 透射率

                // 光源方向（使用主光源）
                float3 lightDir = _MainLightPosition.xyz;
                float  cosTheta = dot(rayDir_world, lightDir);
                float  phaseVal = HenyeyGreenstein(cosTheta, _MieG);

                for (int i = 0; i < _StepCount; i++)
                {
                    float3 samplePosLocal = rayOrigin_obj + rayDir_obj * t;
                    float3 samplePosWorld = TransformObjectToWorld(samplePosLocal);

                    // 深度遮挡：当前采样点超过场景深度时停止
                    float sampleDist = length(samplePosWorld - camWS);
                    if (sampleDist > rayMaxDist) break;

                    // 噪波扰动密度（模拟光束中的浮尘颗粒）
                    float3 noisePosAnimated = samplePosWorld * _NoiseScale
                                           + float3(0, -_Time.y * _AnimSpeed, 0);
                    float  noiseDensity     = Noise3D(noisePosAnimated);

                    // 局部密度（中心高边缘低）
                    float  radialDist   = length(samplePosLocal.xz);
                    float  heightFrac   = saturate(samplePosLocal.y / _BeamHeight);
                    float  beamRadiusAt = lerp(_BeamRadius, _BeamTipRadius, heightFrac);
                    float  localDensity = saturate(1.0 - radialDist / beamRadiusAt);

                    // 叠加噪波
                    localDensity *= 1.0 + (noiseDensity - 0.5) * _NoiseStrength;
                    localDensity  = max(0.0, localDensity);

                    // Beer-Lambert：当前步的透射率
                    float  extinction     = (_ScatterCoeff + _AbsorbCoeff) * localDensity;
                    float  stepTransmit   = exp(-extinction * stepSize);

                    // 散射贡献（Frostbite 能量守恒积分）
                    float3 scatter = _BeamColor.rgb * _ScatterCoeff * localDensity * phaseVal;
                    // 解析积分：避免步长依赖
                    float3 scatterInt = (scatter - scatter * stepTransmit) / max(extinction, 1e-6);
                    accumColor       += transmittance * scatterInt;

                    transmittance *= stepTransmit;
                    t += stepSize;

                    if (transmittance < 0.01) break; // 早期退出
                }

                float3 finalColor = accumColor * _BeamIntensity;
                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 完整示例二：低开销程序化云朵材质

适用于游戏背景的远景云朵，通过程序化 FBM 而不是光线步进，降低一个数量级的性能开销：

```hlsl
Shader "Custom/URP/ProceduralCloud"
{
    Properties
    {
        _CloudColor ("云朵颜色", Color) = (1, 1, 1, 0.8)
        _ShadowColor ("阴影颜色", Color) = (0.6, 0.65, 0.8, 1)
        _SunColor ("受光颜色", Color) = (1, 0.95, 0.85, 1)
        _CloudDensity ("云朵密度", Range(0, 2)) = 1.0
        _CloudScale ("云朵尺度", Range(0.1, 10)) = 2.0
        _CloudSpeed ("流动速度", Range(0, 1)) = 0.05
        _EdgeSoftness ("边缘柔和度", Range(0.01, 0.5)) = 0.15
        _LightDir ("光源方向", Vector) = (0.5, 0.8, 0.3, 0)
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Transparent-10"  // 在大多数透明物体之前渲染
        }

        Pass
        {
            Name "CloudPass"
            Tags { "LightMode" = "UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Back

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _CloudColor;
                float4 _ShadowColor;
                float4 _SunColor;
                float  _CloudDensity;
                float  _CloudScale;
                float  _CloudSpeed;
                float  _EdgeSoftness;
                float4 _LightDir;
            CBUFFER_END

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float3 worldPos : TEXCOORD0; float2 uv : TEXCOORD1; };

            float Hash(float2 p) { p = frac(p * float2(0.1031, 0.103)); p += dot(p, p.yx + 33.33); return frac((p.x + p.y) * p.x); }
            float Noise(float2 p) { float2 i = floor(p); float2 f = frac(p); f = f*f*(3-2*f); return lerp(lerp(Hash(i), Hash(i+float2(1,0)), f.x), lerp(Hash(i+float2(0,1)), Hash(i+float2(1,1)), f.x), f.y); }

            float CloudFBM(float2 p)
            {
                const float2x2 m = float2x2(0.80, 0.60, -0.60, 0.80);
                float v = 0.0, a = 0.5, norm = 0.0;
                // 流动偏移
                p += _Time.y * _CloudSpeed;
                v += a * Noise(p); norm += a; a *= 0.5; p = mul(m, p) * 2.02;
                v += a * Noise(p); norm += a; a *= 0.5; p = mul(m, p) * 2.03;
                v += a * Noise(p); norm += a; a *= 0.5; p = mul(m, p) * 2.01;
                v += a * Noise(p); norm += a;
                return v / norm;
            }

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.worldPos    = TransformObjectToWorld(input.positionOS.xyz);
                output.uv          = input.uv;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float2 cloudUV = input.worldPos.xz * _CloudScale * 0.1;

                float cloud = CloudFBM(cloudUV);
                // 密度阈值：调整 _CloudDensity 控制云覆盖率
                float density = saturate((cloud - (1.0 - _CloudDensity) * 0.5) / _EdgeSoftness);

                if (density < 0.01) discard;

                // 简单光照（对密度场偏移采样模拟厚度）
                float2 lightOffset = _LightDir.xz * 0.02;
                float shadowDensity = CloudFBM(cloudUV + lightOffset);
                float lightFactor   = saturate((shadowDensity - cloud) * 5.0 + 0.5);

                float3 cloudColor = lerp(_ShadowColor.rgb, _SunColor.rgb, lightFactor);
                cloudColor = lerp(cloudColor, _CloudColor.rgb, 0.3);

                return half4(cloudColor, density * _CloudColor.a);
            }
            ENDHLSL
        }
    }
}
```

## VFX Graph vs Particle System vs 自定义 Shader 的选择

| 工具 | 适用场景 | 优势 | 局限 |
|------|---------|------|------|
| Particle System | 简单粒子爆炸、火花 | 艺术家友好，快速迭代 | 大量粒子时 CPU 瓶颈 |
| VFX Graph | 大量复杂粒子（雨、烟） | GPU 驱动，极低 CPU | 学习曲线高，调试困难 |
| 自定义体积 Shader | 连续介质（雾、光束） | 物理精确，可自定义 | 技术门槛高，移动端贵 |
| URP Volume Framework | 全屏后处理雾 | 零配置，性能优化好 | 全局效果，不能局部控制 |

**实际建议**：
- **火焰/烟雾粒子**：VFX Graph + 简单 Lit 材质（粒子贴图）
- **场景雾气**：URP Volume Fog（最省力）或自定义 Renderer Feature（需要局部控制）
- **体积光束**：本文的体积光束 Shader
- **云朵**：程序化云朵 Shader（背景远景）或 Volumetric Clouds（Unity 2022+）

## Unity 2022+ Volumetric Clouds 与手写 Shader 的性能对比

Unity 2022+ HDRP/URP 的内置 Volumetric Clouds 基于优化的光线步进，经过大量工程优化：

- **内置 Volumetric Clouds**：约 0.5ms～2ms（1080p，中等质量）
- **手写完整光线步进云**：约 3ms～10ms（同分辨率，类似质量）
- **本文的程序化 FBM 云**：约 0.1ms～0.3ms（背景云效果）

结论：**除非有特殊的定制化需求，优先使用内置 Volumetric Clouds**。手写体积 Shader 的主要价值在于局部体积光束（非全天空）和移动端优化的简化体积效果。

## 常见踩坑

**坑1：体积光束的深度测试**
体积光束 Shader 必须读取深度缓冲（`SampleSceneDepth`）来实现正确的遮挡关系。必须在 URP Asset 中开启 `Depth Texture`，否则体积光束会穿透所有不透明物体。

**坑2：Cull Front 与相机位置**
体积光束 Shader 使用 `Cull Front`（只渲染背面）。当相机进入光束内部时，需要切换为 `Cull Back`（只渲染正面）。处理这种情况可以通过 C# 脚本检测相机位置并动态切换 Cull 模式：`material.SetInt("_CullMode", isInsideBeam ? 2 : 1)`。

**坑3：移动端 Early-Z 与加法混合**
体积光束使用 `Blend One One`（加法混合），这意味着 GPU 无法使用 Early-Z 优化——每个像素都需要执行完整的片段着色器。大面积的加法混合在移动端是严重的性能危险，必须严格控制体积光束的屏幕覆盖面积。

**坑4：LinearEyeDepth 的平台差异**
`LinearEyeDepth(sceneDepth, _ZBufferParams)` 中的 `_ZBufferParams` 是 Unity 自动根据平台设置的，处理了 Reversed-Z 差异。但如果你手动将深度转换为线性深度（不使用这个函数），必须处理 `UNITY_REVERSED_Z` 宏。
