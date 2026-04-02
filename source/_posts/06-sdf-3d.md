---
title: Unity Shader 系列（六）：URP 中的 SDF 3D 应用 — 体积雾与软粒子
date: 2026-04-01 09:50:00
tags: [HLSL, URP, SDF 3D, 体积雾, 软粒子]
---

## SDF 在 Unity 游戏开发中的实际用途

3D SDF（有向距离场）在 Unity 中不是用于替代网格渲染的，而是作为辅助工具解决传统网格渲染的局限：

1. **局部体积雾**：基于角色或物体周围的 SDF 定义雾效范围，比 Box/Sphere Fog 更精确
2. **软粒子与软接触**：粒子接近几何体时平滑融合，避免硬切割
3. **VFX Graph SDF 场**：Unity VFX Graph 可以烘焙网格为 SDF，驱动粒子碰撞、避障
4. **毛发/草地的接触阴影**：用 SDF 近似计算接触区域的阴影和 AO

**Unity VFX Graph 的 SDF 支持：**
Unity 2021+ 的 VFX Graph 内置 `SDF Bake Tool`，可以将任意网格烘焙为 3D 纹理（`Texture3D`），在粒子系统中用作碰撞场或吸引场。这使得精确的粒子-几何体交互成为可能，不再局限于简单的 Box/Sphere 碰撞体。

## URP 中实现体积雾的两种方案

**方案一：Renderer Feature（屏幕空间后处理）**
在所有不透明物体渲染完成后，插入一个 Pass，对每个屏幕像素重建世界坐标，计算雾的密度。

**方案二：在透明物体 Pass 中内联（本文重点）**
直接在材质 Shader 的 Fragment 中计算，适合局部雾效（如魔法圆阵、毒雾区域）。

## URP Custom Render Feature：体积雾架构

```csharp
// C# 侧：注册体积雾 Renderer Feature
// 在 Project Settings → URP Asset → Renderer 中添加此 Feature
public class VolumetricFogFeature : ScriptableRendererFeature
{
    [System.Serializable]
    public class FogSettings
    {
        public Material fogMaterial;         // 体积雾后处理材质
        public float fogDensity = 0.5f;
        public Color fogColor = Color.gray;
        public float fogHeight = 2.0f;       // 雾效最大高度
        public Vector3 fogCenter;            // SDF 球形雾的中心（世界坐标）
        public float fogRadius = 5.0f;       // SDF 球形雾半径
    }

    public FogSettings settings = new FogSettings();
    VolumetricFogPass _fogPass;

    public override void Create()
    {
        _fogPass = new VolumetricFogPass(settings);
        // 在透明物体之后、后处理之前插入
        _fogPass.renderPassEvent = RenderPassEvent.BeforeRenderingTransparents;
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        // 只对主摄像机生效，不影响 SceneView
        if (renderingData.cameraData.cameraType == CameraType.Game)
        {
            // 传递参数到 Shader
            settings.fogMaterial.SetFloat("_FogDensity", settings.fogDensity);
            settings.fogMaterial.SetColor("_FogColor", settings.fogColor);
            settings.fogMaterial.SetFloat("_FogHeight", settings.fogHeight);
            settings.fogMaterial.SetVector("_FogCenter", settings.fogCenter);
            settings.fogMaterial.SetFloat("_FogRadius", settings.fogRadius);
            renderer.EnqueuePass(_fogPass);
        }
    }
}
```

## 完整示例：URP SDF 局部体积雾 Shader

基于球形 SDF 的局部雾效，在迷雾区域/毒气场景中使用：

```hlsl
Shader "Custom/URP/VolumetricFog"
{
    Properties
    {
        _FogColor    ("Fog Color",        Color)  = (0.5, 0.8, 0.5, 1.0)
        _FogDensity  ("Fog Density",      Range(0.0, 2.0))  = 0.5
        _FogHeight   ("Max Height",       Float)  = 3.0
        _FogCenter   ("Fog Center (WS)",  Vector) = (0, 0, 0, 0)
        _FogRadius   ("Fog Sphere Radius",Float)  = 5.0
        _RaySteps    ("Ray March Steps",  Range(8, 32)) = 16
        _StepSize    ("Ray Step Size",    Range(0.1, 1.0)) = 0.4
        // 噪声纹理（用于扰动雾密度）
        _NoiseTex    ("Noise Texture",    2D) = "white" {}
        _NoiseScale  ("Noise Scale",      Range(0.1, 2.0)) = 0.5
        _NoiseSpeed  ("Noise Speed",      Range(0.0, 1.0)) = 0.1
    }

    SubShader
    {
        Tags
        {
            "Queue" = "Transparent"
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
        }

        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        // 只渲染背面（从内部看雾，避免正面遮挡）
        Cull Front

        Pass
        {
            Name "VolumetricFogPass"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            TEXTURE2D(_NoiseTex); SAMPLER(sampler_NoiseTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _NoiseTex_ST;
                float4 _FogColor;
                float4 _FogCenter;   // xyz: 世界坐标中心
                float  _FogDensity;
                float  _FogHeight;
                float  _FogRadius;
                float  _RaySteps;
                float  _StepSize;
                float  _NoiseScale;
                float  _NoiseSpeed;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 positionWS  : TEXCOORD0;   // 世界空间位置（用于光线方向）
                float4 screenPos   : TEXCOORD1;   // 屏幕坐标（深度采样）
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== SDF 形状函数（世界空间）========

            // 球形 SDF（局部雾的边界）
            float sdSphere(float3 p, float3 center, float radius)
            {
                return length(p - center) - radius;
            }

            // 高度限制（雾不超过指定高度）
            float sdHeightLimit(float3 p, float yMin, float yMax)
            {
                return max(yMin - p.y, p.y - yMax);
            }

            // 综合雾 SDF（球形 + 高度限制的交集）
            float fogSDF(float3 p)
            {
                float dSphere = sdSphere(p, _FogCenter.xyz, _FogRadius);
                float dHeight = sdHeightLimit(p, _FogCenter.y - 0.5, _FogCenter.y + _FogHeight);
                // 交集：取两者的最大值（在球形内且在高度范围内）
                return max(dSphere, dHeight);
            }

            // ======== 雾密度函数 ========
            float sampleFogDensity(float3 posWS, float noiseTime)
            {
                // SDF 值：负值 = 在雾内部，正值 = 外部
                float sdfVal = fogSDF(posWS);
                if (sdfVal > 0.0) return 0.0; // 在雾外直接跳过

                // 基础密度（从边缘到中心线性增加）
                float baseDensity = saturate(-sdfVal / (_FogRadius * 0.5));

                // 高度衰减（底部密，顶部稀）
                float heightFade = 1.0 - saturate((posWS.y - _FogCenter.y) / _FogHeight);
                heightFade = pow(heightFade, 1.5);

                // 噪声扰动（让雾看起来有体积感）
                float2 noiseUV = posWS.xz * _NoiseScale + noiseTime;
                float noise = SAMPLE_TEXTURE2D_LOD(_NoiseTex, sampler_NoiseTex, noiseUV, 2.0).r;
                // 噪声叠加（减弱部分密度，产生云朵状孔洞）
                float noiseMask = lerp(0.5, 1.5, noise);

                return baseDensity * heightFade * noiseMask * _FogDensity;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.positionWS  = TransformObjectToWorld(IN.positionOS.xyz);
                OUT.screenPos   = ComputeScreenPos(OUT.positionHCS);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 screenUV = IN.screenPos.xy / IN.screenPos.w;
                float noiseTime = _Time.y * _NoiseSpeed;

                // ===== 重建相机光线 =====
                float3 cameraPosWS = GetCameraPositionWS();
                float3 rayDir = normalize(IN.positionWS - cameraPosWS);

                // ===== 场景深度限制（光线不穿越不透明物体）=====
                float sceneDepth = LinearEyeDepth(
                    SampleSceneDepth(screenUV),
                    _ZBufferParams
                );
                // 将场景深度转换为光线行进的最大距离
                float maxRayDist = sceneDepth;

                // ===== 光线步进（Ray March Through Fog）=====
                float totalDensity = 0.0;
                float3 totalColor  = float3(0, 0, 0);
                float rayT = 0.01; // 起始偏移（避免自相交）
                int steps = (int)_RaySteps;

                for (int i = 0; i < steps; i++)
                {
                    if (rayT > maxRayDist) break; // 超过场景深度停止

                    float3 samplePos = cameraPosWS + rayDir * rayT;
                    float density = sampleFogDensity(samplePos, noiseTime);

                    if (density > 0.001)
                    {
                        // 获取主光源（在雾内采样光照）
                        Light mainLight = GetMainLight();
                        // 光照对雾颜色的影响
                        float NdotL = saturate(dot(float3(0, 1, 0), mainLight.direction));
                        float3 litFogColor = _FogColor.rgb * lerp(0.4, 1.0, NdotL) * mainLight.color;

                        // 累积（Beer-Lambert 吸收模型）
                        float absorption = density * _StepSize;
                        totalColor += litFogColor * absorption * (1.0 - totalDensity);
                        totalDensity += absorption * (1.0 - totalDensity);
                    }

                    // 如果已经完全不透明则提前退出
                    if (totalDensity >= 0.99) break;

                    rayT += _StepSize;
                }

                totalDensity = saturate(totalDensity);
                return half4(totalColor / max(totalDensity, 0.001), totalDensity);
            }
            ENDHLSL
        }
    }
}
```

## 软粒子 Shader：SDF 融合边缘

软粒子的核心思想是用深度差值控制粒子 Alpha，让粒子接触几何体时平滑淡出：

```hlsl
Shader "Custom/URP/SoftParticle"
{
    Properties
    {
        _MainTex         ("Particle Texture", 2D) = "white" {}
        _Color           ("Color",      Color)    = (1,1,1,1)
        _SoftRange       ("Soft Range", Range(0.01, 5.0)) = 1.0
        // SDF 精确融合（比简单深度差更精确）
        _SDFBlendRadius  ("SDF Blend Radius", Range(0.0, 2.0)) = 0.5
    }

    SubShader
    {
        Tags
        {
            "Queue" = "Transparent"
            "RenderType" = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
        }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Cull Off

        Pass
        {
            Name "SoftParticlePass"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_particles  // 粒子系统特殊关键字

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _Color;
                float  _SoftRange;
                float  _SDFBlendRadius;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                float4 color       : COLOR;
                float4 screenPos   : TEXCOORD1;
                float  eyeDepth    : TEXCOORD2;  // 视空间深度（用于软粒子）
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = TRANSFORM_TEX(IN.uv, _MainTex);
                OUT.color = IN.color;
                OUT.screenPos = ComputeScreenPos(OUT.positionHCS);
                // 视空间 Z（正值）
                OUT.eyeDepth = -TransformObjectToView(IN.positionOS.xyz).z;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 screenUV = IN.screenPos.xy / IN.screenPos.w;

                // 采样场景深度
                float sceneDepth = LinearEyeDepth(
                    SampleSceneDepth(screenUV),
                    _ZBufferParams
                );

                // 深度差：正值 = 粒子在几何体前面
                float depthDiff = sceneDepth - IN.eyeDepth;

                // 软粒子 Alpha 因子（平滑过渡）
                float softFactor = smoothstep(0.0, _SoftRange, depthDiff);

                // 纹理采样
                half4 texColor = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);
                half4 col = texColor * _Color * IN.color;
                col.a *= softFactor;

                return col;
            }
            ENDHLSL
        }
    }
}
```

## ShaderGraph 实现软粒子

1. `Scene Depth` 节点（Eye 采样模式）→ 场景深度
2. `Screen Position` 节点（Raw 模式）→ 做透视除法 → 屏幕 UV
3. 粒子片元的深度：用 `Position` 节点（View 空间）取负 Z 分量
4. `Subtract`（场景深度 - 粒子深度）→ `Smoothstep` → 软因子
5. 软因子 × 粒子 Alpha → `Alpha` 输出

## 性能考量

**体积雾的性能瓶颈：**
- 光线步进步数是主要开销：16 步适合移动端，32 步适合 PC
- 每步的 `SampleSceneDepth` 可以在循环外缓存（只需采样一次）
- 使用 `_StepSize` 控制步长（大步长 = 少步数 = 快，但可能漏采样）

| 步数 | 效果 | 性能（移动端） |
|------|------|--------------|
| 8 步 | 粗糙，有条带伪影 | ~0.3ms |
| 16 步 | 够用，轻微条带 | ~0.6ms |
| 32 步 | 高质量 | ~1.2ms |

**优化技巧：**
- 只对雾 SDF 包围盒内的屏幕区域运行光线步进
- 蓝噪声 Jitter（蓝噪声扰动起始步长）可以用更少步数换取相近质量
- 在单独的半分辨率 RT 中渲染体积雾，然后上采样到全分辨率

## 常见踩坑

1. **软粒子需要 URP Depth Texture**：在 URP Asset 中勾选 `Depth Texture` 选项，否则 `SampleSceneDepth` 返回全 1，软粒子效果消失。

2. **体积雾中 `SampleSceneDepth` 的 RenderPassEvent**：如果体积雾 Pass 插在 `AfterRenderingOpaques` 之前，深度纹理可能还未写入完整，导致雾穿透几何体。确保 Pass 在 `AfterRenderingOpaques` 之后执行。

3. **光线步进的浮点精度**：当 `_FogCenter` 在大世界坐标（如 (5000, 0, 5000)）时，`length(p - _FogCenter)` 会有精度问题。解决方案：将 `_FogCenter` 转换为相机相对坐标后再计算。

4. **VFX Graph SDF Bake 的 Texture3D 精度**：烘焙分辨率（32/64/128）决定 SDF 的精确程度。低分辨率的 SDF 在粒子精确碰撞时会有明显误差，特别是薄几何体（如剑刃、草叶）。

下一篇文章将讲解 Unity URP 的法线贴图完整体系：切线空间、TBN 矩阵、UnpackNormal 的内部实现，以及视差贴图（Parallax Mapping）的实现。
