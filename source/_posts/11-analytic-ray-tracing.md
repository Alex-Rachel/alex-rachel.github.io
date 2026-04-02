---
title: Unity Shader 系列（十一）：解析几何求交：水晶球与激光束特效
date: 2026-04-12 12:00:00
tags: [HLSL, URP, 光线追踪, 几何求交, 特效Shader]
---

解析几何求交（Analytic Ray Intersection）是在 Shader 中无需三角形网格、纯粹用数学方程渲染几何体的技术。在 Unity/URP 开发中，这项技术不同于 Physics.Raycast——它发生在 GPU 上，每帧对每个片段独立执行，特别适合制作水晶球折射、激光束碰撞可视化、镭射瞄准线等特效。本文从原理出发，提供两个完整的可在 Unity 项目中直接使用的 URP Shader。

## 解析求交 vs Physics.Raycast

初学 Unity 的开发者可能会问：既然有 `Physics.Raycast`，为什么还要在 Shader 里手写求交？

| 对比维度 | Physics.Raycast | Shader 内解析求交 |
|---------|----------------|-----------------|
| 运行位置 | CPU，每帧有限次数 | GPU，每片段并行执行 |
| 适用场景 | 游戏逻辑、命中检测 | 视觉特效、渲染 |
| 几何精度 | 取决于碰撞体 Mesh | 数学精确，无 Mesh 误差 |
| 性能特点 | 大量射线时 CPU 瓶颈 | 适合全屏每像素计算 |
| 典型用途 | 子弹击中、视野检测 | 水晶球、激光可视化 |

在以下场景中，Shader 内解析求交是更好的选择：
1. **水晶球/玻璃球**：需要每像素精确的折射和内反射计算
2. **激光束特效**：圆柱体内部发光效果，不依赖 Mesh 几何
3. **镭射瞄准线**：在屏幕空间绘制精确的光线轨迹
4. **程序化护盾**：球形护盾被击中时的扰动可视化

## 核心数学原理

统一框架：光线 `P(t) = rayOrigin + t × rayDir`，代入几何体隐式方程求解 t。

**球体求交**：`|P - C|² = r²` 展开后得到二次方程 `at² + bt + c = 0`，用判别式判断是否相交。

**圆柱体求交**（轴对齐）：将 xz 分量代入圆方程，得到关于 t 的二次方程，再检查 y 坐标是否在圆柱高度范围内。

**平面求交**：`N·P + d = 0` 代入后得到一次方程，直接求解。

## 完整示例一：URP 水晶球 Shader

水晶球效果需要：球面外折射（Snell 定律）+ 球内全内反射 + Fresnel 反射权重。这个 Shader 可以直接附加到 Unity 场景中的 Sphere GameObject 上。

```hlsl
Shader "Custom/URP/CrystalBall"
{
    Properties
    {
        _BallRadius ("球体半径", Float) = 0.5
        _IOR ("折射率 (玻璃=1.5, 水=1.33)", Range(1.0, 3.0)) = 1.5
        _TintColor ("球体色调", Color) = (0.8, 0.9, 1.0, 1.0)
        _EnvMap ("环境贴图", CUBE) = "" {}
        _Glossiness ("光泽度", Range(0, 1)) = 0.95
        _InternalReflections ("内反射次数", Range(0, 3)) = 1
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
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURECUBE(_EnvMap);
            SAMPLER(sampler_EnvMap);

            CBUFFER_START(UnityPerMaterial)
                float _BallRadius;
                float _IOR;
                float4 _TintColor;
                float _Glossiness;
                int _InternalReflections;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 worldPos    : TEXCOORD0;
                float3 worldNormal : TEXCOORD1;
                float3 viewDir     : TEXCOORD2;
            };

            // 球体解析求交（世界空间，以球心为原点）
            // 返回 t 值，负值表示未命中
            float IntersectSphere(float3 rayOrigin, float3 rayDir, float radius)
            {
                // 将光线平移到以球心为原点
                float b = dot(rayOrigin, rayDir);
                float c = dot(rayOrigin, rayOrigin) - radius * radius;
                float discriminant = b * b - c;
                if (discriminant < 0.0) return -1.0;
                float sqrtD = sqrt(discriminant);
                float t1 = -b - sqrtD; // 近端交点
                float t2 = -b + sqrtD; // 远端交点
                // 在球内部时取远端（出射点）
                return (t1 > 0.001) ? t1 : t2;
            }

            // Schlick Fresnel 近似
            float FresnelSchlick(float cosTheta, float F0)
            {
                return F0 + (1.0 - F0) * pow(1.0 - saturate(cosTheta), 5.0);
            }

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.worldPos    = TransformObjectToWorld(input.positionOS.xyz);
                output.worldNormal = TransformObjectToWorldNormal(input.normalOS);
                output.viewDir     = normalize(GetCameraPositionWS() - output.worldPos);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                // 球心位于物体世界坐标原点
                float3 sphereCenter = TransformObjectToWorld(float3(0, 0, 0));
                float3 rayOrigin    = GetCameraPositionWS();
                float3 rayDir       = normalize(input.worldPos - rayOrigin);

                // 将光线变换到球心坐标系
                float3 localOrigin = rayOrigin - sphereCenter;
                float  radius      = _BallRadius;

                float3 normal = normalize(input.worldNormal);
                float3 viewDir = -rayDir;

                // 外表面折射（空气 -> 玻璃）
                float etaRatio = 1.0 / _IOR; // 从空气进入玻璃
                float3 refracted = refract(rayDir, normal, etaRatio);

                // 处理全内反射（refract 返回零向量时）
                bool totalInternalReflection = (length(refracted) < 0.001);
                if (totalInternalReflection)
                    refracted = reflect(rayDir, normal);

                // 采样环境贴图获得折射颜色
                float3 refractColor = SAMPLE_TEXTURECUBE_LOD(
                    _EnvMap, sampler_EnvMap, refracted,
                    (1.0 - _Glossiness) * 5.0
                ).rgb;

                // 外表面反射
                float3 reflectDir  = reflect(rayDir, normal);
                float3 reflectColor = SAMPLE_TEXTURECUBE_LOD(
                    _EnvMap, sampler_EnvMap, reflectDir, 0.0
                ).rgb;

                // Fresnel 权重：视角越浅反射越强
                float F0     = ((1.0 - _IOR) / (1.0 + _IOR));
                F0 = F0 * F0;
                float cosI   = saturate(dot(normal, viewDir));
                float fresnel = FresnelSchlick(cosI, F0);

                // 主光源高光（使用 URP 标准主光源）
                Light mainLight  = GetMainLight();
                float3 halfDir   = normalize(mainLight.direction + viewDir);
                float specular   = pow(saturate(dot(normal, halfDir)), 128.0 * _Glossiness);
                float3 specColor = mainLight.color * specular * _Glossiness;

                // 混合折射和反射
                float3 finalColor = lerp(refractColor, reflectColor, fresnel);
                finalColor *= _TintColor.rgb;
                finalColor += specColor;

                // 边缘增亮（水晶球特有的菲涅尔发光效果）
                float rim = pow(1.0 - cosI, 3.0);
                finalColor += rim * 0.3 * _TintColor.rgb;

                return half4(finalColor, 0.85 + fresnel * 0.15);
            }
            ENDHLSL
        }
    }
}
```

**使用方法**：
1. 创建新 Shader 文件，粘贴上面代码
2. 在 Project 窗口创建对应 Material
3. 将 Material 拖到场景中的 Sphere GameObject
4. 在 Inspector 中设置环境贴图（可以用 Lighting 窗口的天空盒截图）

## 完整示例二：激光束特效 Shader（圆柱体解析求交）

激光束效果使用圆柱体解析求交，配合辉光效果。这个 Shader 附加到一个细长的 Quad 或 Cylinder Mesh 上即可产生发光激光效果。

```hlsl
Shader "Custom/URP/LaserBeam"
{
    Properties
    {
        _BeamColor ("激光颜色", Color) = (0.2, 1.0, 0.8, 1.0)
        _BeamRadius ("光束半径", Float) = 0.05
        _BeamLength ("光束长度", Float) = 5.0
        _CoreIntensity ("核心亮度", Range(1, 10)) = 5.0
        _GlowWidth ("辉光宽度", Range(0.1, 3.0)) = 1.5
        _PulseSpeed ("脉冲速度", Range(0, 5)) = 1.0
        _NoiseScale ("噪波扰动", Range(0, 1)) = 0.1
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Transparent+1"
        }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            Blend One One          // 加法混合，产生发光效果
            ZWrite Off
            Cull Off               // 双面渲染，从任何角度都可见

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _BeamColor;
                float  _BeamRadius;
                float  _BeamLength;
                float  _CoreIntensity;
                float  _GlowWidth;
                float  _PulseSpeed;
                float  _NoiseScale;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 worldPos    : TEXCOORD0;
                float3 localPos    : TEXCOORD1;  // 物体空间坐标（用于圆柱求交）
                float2 uv          : TEXCOORD2;
            };

            // Y 轴对齐圆柱求交（物体空间）
            // 圆柱：xz 平面半径 _BeamRadius，y 方向从 0 到 _BeamLength
            float2 IntersectCylinder(float3 rayOrigin, float3 rayDir, float radius)
            {
                // 投影到 xz 平面
                float a = rayDir.x * rayDir.x + rayDir.z * rayDir.z;
                if (a < 1e-6) return float2(-1, -1); // 与轴平行，无解

                float b = 2.0 * (rayOrigin.x * rayDir.x + rayOrigin.z * rayDir.z);
                float c = rayOrigin.x * rayOrigin.x + rayOrigin.z * rayOrigin.z - radius * radius;

                float discriminant = b * b - 4.0 * a * c;
                if (discriminant < 0.0) return float2(-1, -1);

                float sqrtD = sqrt(discriminant);
                float t1 = (-b - sqrtD) / (2.0 * a);
                float t2 = (-b + sqrtD) / (2.0 * a);
                return float2(t1, t2);
            }

            // 简单哈希噪波，用于光束扰动
            float Hash(float2 p)
            {
                return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
            }

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.worldPos    = TransformObjectToWorld(input.positionOS.xyz);
                output.localPos    = input.positionOS.xyz;
                output.uv          = input.uv;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                // 在物体空间进行圆柱求交
                float3 camWorldPos  = GetCameraPositionWS();
                float3 camLocalPos  = TransformWorldToObject(camWorldPos);
                float3 rayDir_world = normalize(input.worldPos - camWorldPos);
                float3 rayDir_local = normalize(TransformWorldToObject(
                    input.worldPos) - camLocalPos
                );

                float2 tHit = IntersectCylinder(camLocalPos, rayDir_local, _BeamRadius * _GlowWidth);

                // 未命中时剔除（alpha=0）
                if (tHit.x < 0.0 && tHit.y < 0.0) discard;

                // 取最近命中点
                float t = max(tHit.x, 0.0);
                float3 hitLocal = camLocalPos + rayDir_local * t;

                // 检查 Y 方向是否在圆柱范围内
                if (hitLocal.y < 0.0 || hitLocal.y > _BeamLength) discard;

                // 计算到轴线的距离（归一化）
                float distToAxis = length(hitLocal.xz) / (_BeamRadius * _GlowWidth);

                // 核心亮度 + 辉光衰减（高斯型）
                float core = exp(-distToAxis * distToAxis * 8.0) * _CoreIntensity;
                float glow = exp(-distToAxis * distToAxis * 2.0);

                // 脉冲动画
                float pulse = 0.8 + 0.2 * sin(_Time.y * _PulseSpeed * 6.28 + hitLocal.y * 3.0);

                // 沿轴线方向的噪波扰动
                float noiseVal = Hash(float2(hitLocal.y * 5.0, _Time.y * 0.5));
                float noise = 1.0 + _NoiseScale * (noiseVal - 0.5);

                float intensity = (core + glow * 0.5) * pulse * noise;

                // 端部衰减（光束两端渐隐）
                float endFade = smoothstep(0.0, 0.1, hitLocal.y / _BeamLength) *
                                smoothstep(1.0, 0.9, hitLocal.y / _BeamLength);
                intensity *= endFade;

                float3 beamColor = _BeamColor.rgb * intensity;

                // 核心发白（高亮区域趋向白色）
                beamColor = lerp(beamColor, float3(1, 1, 1), saturate(core * 0.3));

                return half4(beamColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 在游戏中的实际应用场景

**1. 科幻武器瞄准线**
将激光束 Shader 的起点绑定到枪口，终点通过 Physics.Raycast 确定（CPU 端获取命中点），再通过 `SetFloat("_BeamLength", hitDistance)` 传入 Shader 动态调整长度。

**2. 水晶/宝石道具**
在 RPG 游戏中，水晶球、魔法宝石等道具使用水晶球 Shader 渲染，无需制作复杂的折射 Mesh，直接用 Unity 内置 Sphere。

**3. 传送门/魔法阵检测**
结合平面求交，检测玩家角色是否穿越某个数学平面，触发传送效果——比 Trigger Collider 更精确。

## ShaderGraph 对应实现思路

水晶球效果在 ShaderGraph 中的实现路径：
- 使用 **Refraction Node**（Unity 2021+ 引入）或手动连接 `Refract` 数学节点
- `Camera Direction` 节点提供视线方向
- `Normal Vector` 节点提供表面法线
- `Reflection Node` 计算反射方向，连接到 `Sample Reflected Cubemap` 节点
- `Fresnel Effect` 节点直接提供菲涅尔值，控制反射/折射混合

激光束效果更适合手写 HLSL，因为需要圆柱体求交这样的自定义数学逻辑，ShaderGraph 的节点表达能力有限。

## 性能考量

| 平台 | 建议 |
|------|------|
| PC/主机 | 完整的多次内反射计算，InternalReflections=2~3 |
| 移动端高端 | InternalReflections=1，关闭噪波扰动 |
| 移动端低端 | 改用简化版本：只做外层 Fresnel，不做内部折射 |
| VR | 严格控制 overdraw，避免大面积透明物体 |

## 与 URP 渲染流程的集成

**深度写入问题**：透明 Shader 默认 `ZWrite Off`，水晶球不写入深度缓冲。如果场景中有其他透明物体与水晶球叠加，渲染顺序由 Queue 值决定，可能出现排序问题。解决方案：使用 URP 的 `Sorting Criteria` 或为水晶球单独设置更高的 Queue 值。

**反射探针集成**：生产项目中，建议将 `_EnvMap` 替换为 Unity 的反射探针数据：
```hlsl
// 在 frag shader 中获取 URP 反射探针
float3 reflectDir = reflect(rayDir, normal);
// 使用 URP 内置的 GlossyEnvironmentReflection
float3 envReflect = GlossyEnvironmentReflection(
    reflectDir, 
    input.worldPos, 
    1.0 - _Glossiness, // perceptualRoughness
    1.0                // occlusion
);
```

## 常见踩坑

**坑1：Unity 深度方向反转**
Unity 在 Reversed-Z 模式下（DirectX 平台），深度值从 1（近裁面）到 0（远裁面），与 OpenGL 相反。如果你手动比较深度值，需要用 `#if UNITY_REVERSED_Z` 宏处理。水晶球 Shader 中没有直接读取深度缓冲，所以这个问题不影响本例。

**坑2：Cubemap 采样坐标系**
Unity 的 Cubemap 采样坐标是世界空间的，但方向向量需要从世界空间传入，不能使用物体空间方向。新手容易混淆本文两个 Shader 中物体空间（用于数学求交）和世界空间（用于环境贴图采样）的切换时机。

**坑3：移动端精度问题**
HLSL 中默认浮点精度是 `float`（32位），但移动端 GPU 上建议在不影响效果的地方使用 `half`（16位）。折射方向计算需要 `float`，但最终颜色输出可以用 `half4`。

**坑4：refract 函数参数**
Unity HLSL 中 `refract(incident, normal, eta)` 的 `eta` 是入射介质与折射介质折射率之比，从空气进入玻璃时 `eta = 1.0 / 1.5`，从玻璃射出到空气时 `eta = 1.5 / 1.0`。方向搞反会导致折射效果完全错误（向外折射而不是向内）。
