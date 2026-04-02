---
title: Unity Shader 系列（十二）：URP 光线步进：Renderer Feature 全屏 SDF 渲染
date: 2026-04-01 10:50:00
tags: [HLSL, URP, 光线步进, Renderer Feature, 后处理]
---

光线步进（Ray Marching）结合 SDF（有符号距离函数）是在 GPU 中渲染无需三角网格的 3D 几何体的强大技术。在 Unity URP 中，将光线步进集成到渲染管线的正确方式是通过 **ScriptableRendererFeature**：它让你在 URP 的标准渲染流程中插入自定义渲染步骤，读取深度缓冲，与场景几何正确融合。本文提供完整的 C# RendererFeature 代码和对应的 HLSL Shader。

## 为什么需要 Renderer Feature

Unity 中直接在 Material 上写光线步进有一个根本缺陷：**无法正确处理与场景几何体的深度关系**。一个光线步进渲染的 SDF 球体，如果挡住了真实的 Mesh，必须读取深度缓冲来做正确的深度比较。

`ScriptableRendererFeature` 允许你：
1. 访问当前帧的颜色缓冲和深度缓冲
2. 在 URP 渲染队列的特定位置（如 AfterRenderingOpaques）插入自定义 Pass
3. 使用 `Blit` 将全屏后处理应用到渲染结果

## 完整 C# ScriptableRendererFeature

创建文件 `RayMarchingFeature.cs`：

```csharp
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

// 在 URP Renderer Asset 的 Renderer Features 列表中添加此 Feature
public class RayMarchingFeature : ScriptableRendererFeature
{
    [System.Serializable]
    public class Settings
    {
        public Material rayMarchMaterial;           // 绑定 RayMarch.shader
        public RenderPassEvent renderPassEvent
            = RenderPassEvent.AfterRenderingOpaques;
        [Range(32, 256)]
        public int maxSteps = 128;                  // 最大步进次数
        [Range(0.001f, 0.1f)]
        public float surfaceDistance = 0.001f;      // 命中阈值
    }

    public Settings settings = new Settings();
    private RayMarchingPass _pass;

    public override void Create()
    {
        _pass = new RayMarchingPass(settings);
        _pass.renderPassEvent = settings.renderPassEvent;
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        if (settings.rayMarchMaterial == null) return;
        // 将相机的深度纹理传给 Shader
        _pass.Setup(renderer.cameraColorTargetHandle);
        renderer.EnqueuePass(_pass);
    }

    class RayMarchingPass : ScriptableRenderPass
    {
        private readonly Settings _settings;
        private RTHandle _source;
        private RTHandle _tempRT;
        private static readonly int MaxStepsID = Shader.PropertyToID("_MaxSteps");
        private static readonly int SurfDistID  = Shader.PropertyToID("_SurfaceDistance");

        public RayMarchingPass(Settings settings)
        {
            _settings = settings;
        }

        public void Setup(RTHandle source)
        {
            _source = source;
        }

        public override void OnCameraSetup(CommandBuffer cmd, ref RenderingData renderingData)
        {
            // 申请临时渲染纹理（和屏幕等大）
            RenderTextureDescriptor descriptor = renderingData.cameraData.cameraTargetDescriptor;
            descriptor.depthBufferBits = 0;
            RenderingUtils.ReAllocateIfNeeded(
                ref _tempRT,
                descriptor,
                FilterMode.Bilinear,
                TextureWrapMode.Clamp,
                name: "_RayMarchTemp"
            );
        }

        public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
        {
            if (_settings.rayMarchMaterial == null || _tempRT == null) return;

            CommandBuffer cmd = CommandBufferPool.Get("RayMarching");

            // 传递参数到 Shader
            _settings.rayMarchMaterial.SetInt(MaxStepsID, _settings.maxSteps);
            _settings.rayMarchMaterial.SetFloat(SurfDistID, _settings.surfaceDistance);

            // 设置相机矩阵（Shader 中重建世界空间射线需要）
            Camera cam = renderingData.cameraData.camera;
            Matrix4x4 projMatrix = GL.GetGPUProjectionMatrix(cam.projectionMatrix, true);
            Matrix4x4 viewProjInverse = (projMatrix * cam.worldToCameraMatrix).inverse;
            _settings.rayMarchMaterial.SetMatrix("_ViewProjInverse", viewProjInverse);
            _settings.rayMarchMaterial.SetVector("_CameraWorldPos", cam.transform.position);

            // Blit：源颜色缓冲 -> 临时RT（光线步进叠加）-> 源颜色缓冲
            Blitter.BlitCameraTexture(cmd, _source, _tempRT, _settings.rayMarchMaterial, 0);
            Blitter.BlitCameraTexture(cmd, _tempRT, _source);

            context.ExecuteCommandBuffer(cmd);
            CommandBufferPool.Release(cmd);
        }

        public override void OnCameraCleanup(CommandBuffer cmd)
        {
            // 临时 RT 由 RenderingUtils.ReAllocateIfNeeded 管理，无需手动释放
        }
    }
}
```

## 对应的 HLSL Shader（RayMarch.shader）

```hlsl
Shader "Custom/URP/RayMarching"
{
    Properties
    {
        // 由 RendererFeature 的 Blit 自动传入
        _MainTex ("源颜色缓冲", 2D) = "white" {}

        // SDF 场景参数（可在 Inspector 中调整）
        _SpherePos ("SDF 球心位置", Vector) = (0, 1, 5, 0)
        _SphereRadius ("SDF 球半径", Float) = 0.8
        _BoxPos ("SDF 盒子位置", Vector) = (2, 0.5, 5, 0)
        _BoxSize ("SDF 盒子尺寸", Vector) = (0.5, 0.5, 0.5, 0)
        _SmoothK ("平滑混合系数", Range(0, 1)) = 0.3
        _FogColor ("雾颜色", Color) = (0.5, 0.6, 0.8, 1)
        _FogDensity ("雾密度", Range(0, 0.1)) = 0.02
    }

    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }
        Cull Off ZWrite Off ZTest Always

        Pass
        {
            HLSLPROGRAM
            #pragma vertex FullscreenVert
            #pragma fragment frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_TexelSize;
                float4 _SpherePos;
                float  _SphereRadius;
                float4 _BoxPos;
                float4 _BoxSize;
                float  _SmoothK;
                float4 _FogColor;
                float  _FogDensity;
                int    _MaxSteps;
                float  _SurfaceDistance;
                float4 _CameraWorldPos;
                float4x4 _ViewProjInverse;
            CBUFFER_END

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
            };

            Varyings FullscreenVert(uint vertexID : SV_VertexID)
            {
                // 全屏三角形顶点（无需顶点缓冲）
                Varyings output;
                output.uv = float2((vertexID << 1) & 2, vertexID & 2);
                output.positionHCS = float4(output.uv * 2.0 - 1.0, 0.0, 1.0);
                // 注意：部分平台需要翻转 UV，URP Blit Helper 已处理此问题
                return output;
            }

            // ============================================================
            // SDF 基本体
            // ============================================================

            float sdSphere(float3 p, float3 center, float radius)
            {
                return length(p - center) - radius;
            }

            float sdBox(float3 p, float3 center, float3 halfSize)
            {
                float3 d = abs(p - center) - halfSize;
                return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
            }

            // 平滑并集（SDF 核心操作，k 控制混合带宽）
            float smin(float a, float b, float k)
            {
                float h = max(k - abs(a - b), 0.0);
                return min(a, b) - h * h * 0.25 / k;
            }

            // 场景 SDF：组合多个基本体
            float SceneSDF(float3 p)
            {
                float sphere = sdSphere(p, _SpherePos.xyz, _SphereRadius);
                float box    = sdBox(p, _BoxPos.xyz, _BoxSize.xyz);
                float ground = p.y; // 无限地面

                // 球和盒子平滑融合
                float combined = smin(sphere, box, _SmoothK);
                return min(combined, ground);
            }

            // 四面体法线估计（4 次 SDF 采样，比中心差分的 6 次更高效）
            float3 CalcNormal(float3 pos)
            {
                const float eps = 0.001;
                const float2 k = float2(1, -1);
                return normalize(
                    k.xyy * SceneSDF(pos + k.xyy * eps) +
                    k.yyx * SceneSDF(pos + k.yyx * eps) +
                    k.yxy * SceneSDF(pos + k.yxy * eps) +
                    k.xxx * SceneSDF(pos + k.xxx * eps)
                );
            }

            // 软阴影（步进过程中记录最小归一化距离）
            float CalcSoftShadow(float3 ro, float3 rd, float tMin, float tMax)
            {
                float res = 1.0, t = tMin;
                for (int i = 0; i < 24; i++)
                {
                    float h = SceneSDF(ro + rd * t);
                    float s = clamp(8.0 * h / t, 0.0, 1.0);
                    res = min(res, s);
                    t  += clamp(h, 0.01, 0.2);
                    if (res < 0.004 || t > tMax) break;
                }
                return clamp(res * res * (3.0 - 2.0 * res), 0.0, 1.0);
            }

            // 环境光遮蔽（沿法线方向多次采样）
            float CalcAO(float3 pos, float3 normal)
            {
                float occ = 0.0, sca = 1.0;
                [unroll]
                for (int i = 0; i < 5; i++)
                {
                    float h = 0.01 + 0.12 * float(i) / 4.0;
                    float d = SceneSDF(pos + h * normal);
                    occ += (h - d) * sca;
                    sca *= 0.95;
                }
                return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
            }

            // ============================================================
            // 主光线步进循环
            // ============================================================
            float RayMarch(float3 ro, float3 rd, out float hitDist)
            {
                float t = 0.001;
                hitDist = -1.0;
                for (int i = 0; i < _MaxSteps; i++)
                {
                    float3 p = ro + t * rd;
                    float  d = SceneSDF(p);

                    // 自适应命中阈值：远处允许更大误差
                    if (abs(d) < _SurfaceDistance * (1.0 + t * 0.05))
                    {
                        hitDist = t;
                        return 1.0; // 命中
                    }
                    t += d;
                    if (t > 100.0) break;
                }
                return -1.0; // 未命中
            }

            half4 frag(Varyings input) : SV_Target
            {
                float2 uv = input.uv;

                // 从深度缓冲读取场景深度（用于与光线步进结果融合）
                float sceneDepth = SampleSceneDepth(uv);

                // 重建世界空间射线（通过逆投影矩阵）
                float4 clipPos  = float4(uv * 2.0 - 1.0, sceneDepth, 1.0);
                float4 worldPos = mul(_ViewProjInverse, clipPos);
                float3 sceneWorldPos = worldPos.xyz / worldPos.w;

                float3 rayOrigin = _CameraWorldPos.xyz;
                float3 rayDir    = normalize(sceneWorldPos - rayOrigin);

                // 采样原始颜色缓冲
                float3 sceneColor = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv).rgb;

                // 执行光线步进
                float hitDist;
                float hit = RayMarch(rayOrigin, rayDir, hitDist);

                if (hit < 0.0)
                {
                    // 未命中 SDF：返回原始场景颜色（不叠加任何效果）
                    return half4(sceneColor, 1.0);
                }

                // 深度测试：如果 SDF 命中点比场景几何更远，则被遮挡
                float3 hitPos = rayOrigin + rayDir * hitDist;

                // 将命中点投影到裁剪空间，比较深度
                float4 hitClip   = mul(UNITY_MATRIX_VP, float4(hitPos, 1.0));
                float  hitDepth  = hitClip.z / hitClip.w;

                #if UNITY_REVERSED_Z
                    // DirectX/Metal：深度从 1（近）到 0（远）
                    if (hitDepth < sceneDepth) return half4(sceneColor, 1.0);
                #else
                    // OpenGL：深度从 -1（近）到 1（远）
                    if (hitDepth > sceneDepth) return half4(sceneColor, 1.0);
                #endif

                // 计算命中点的着色
                float3 normal   = CalcNormal(hitPos);
                Light mainLight = GetMainLight();

                float diffuse   = saturate(dot(normal, mainLight.direction));
                float shadow    = CalcSoftShadow(
                    hitPos + normal * 0.01,
                    mainLight.direction,
                    0.02, 10.0
                );
                float ao        = CalcAO(hitPos, normal);

                // 材质颜色（棋盘格地面 + 蓝色几何体）
                float3 matColor;
                if (hitPos.y < 0.01)
                {
                    // 棋盘格地面
                    float checker = fmod(floor(hitPos.x) + floor(hitPos.z), 2.0);
                    matColor = lerp(float3(0.9, 0.9, 0.9), float3(0.3, 0.3, 0.3), checker);
                }
                else
                {
                    matColor = float3(0.3, 0.5, 0.9);
                }

                // PBR 近似着色
                float3 ambient  = matColor * 0.15 * ao;
                float3 diffuseC = matColor * diffuse * shadow * mainLight.color;
                float3 finalColor = ambient + diffuseC;

                // 距离雾（与 Unity 场景雾融合）
                float fogFactor = exp(-_FogDensity * hitDist * hitDist);
                finalColor = lerp(_FogColor.rgb, finalColor, saturate(fogFactor));

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 在 Unity 项目中的设置步骤

1. **创建 Shader 和 Feature**
   - 将两段代码分别保存为 `RayMarch.shader` 和 `RayMarchingFeature.cs`
   - 用 `RayMarch.shader` 创建一个 Material

2. **配置 URP Asset**
   - 在 Project Settings → Graphics 中找到当前 URP Asset
   - 找到 UniversalRenderer，在 `Renderer Features` 中点击 `Add Renderer Feature`
   - 选择 `RayMarchingFeature`，将刚才创建的 Material 拖入 `Ray March Material` 槽

3. **确保深度纹理开启**
   - 在 URP Asset 中勾选 `Depth Texture`（必须！否则 `SampleSceneDepth` 返回无效值）

4. **运行测试**
   - 进入 Play 模式，场景中应出现 SDF 球体和盒子（带正确深度排序）

## 实际游戏应用场景

**1. 体积雾效果**
在光线步进循环中不找表面，而是沿射线积分密度，实现与场景几何正确融合的局部体积雾。URP Volume 框架的 Fog 效果就是类似原理。

**2. 实时 SDF 字体渲染**
UI 字体使用 SDF 贴图，通过 `smoothstep` 和 `fwidth` 实现无锯齿缩放，这是 TextMeshPro 的核心原理——可以认为是 2D 版本的光线步进。

**3. 场景探索工具（编辑器扩展）**
在编辑器的 Scene 视图中用光线步进显示物理碰撞体、导航网格、触发器区域等不可见几何，帮助调试。

## 性能考量

| 优化措施 | 效果 | 适用平台 |
|---------|------|---------|
| 减少 MaxSteps（64→32） | 约 50% 性能提升 | 移动端必须 |
| 半分辨率渲染 + 双线性上采样 | 75% 像素减少 | 移动端推荐 |
| 使用包围球预筛选 | 跳过空区域 | 场景复杂时 |
| 提前退出（alpha > 0.99） | 体积效果专用 | 所有平台 |
| Temporal Accumulation | 每帧只渲染 1/4 像素 | PC/主机 |

**移动端警告**：光线步进是 ALU 密集型计算，在 Mali/Adreno 等移动端 GPU 上，128 步的全屏光线步进可能导致严重发热。建议移动端将 MaxSteps 控制在 32 以内，并使用半分辨率渲染。

## 常见踩坑

**坑1：深度纹理格式差异**
不同平台的深度纹理格式不同：PC 是 32 位浮点，移动端可能是 16 位。使用 `SampleSceneDepth` 而不是直接采样 `_CameraDepthTexture`，URP 会自动处理格式差异。

**坑2：Blit 的 UV 翻转**
在某些平台（DX12、Metal）上，Blit 操作的 UV 坐标 Y 轴是翻转的。使用 URP 的 `Blitter.BlitCameraTexture` 而不是手动 Blit，可以自动处理平台差异。

**坑3：UNITY_REVERSED_Z 宏**
深度比较必须处理 Reversed-Z，否则在 DirectX 上深度测试完全反向（所有 SDF 物体都被遮挡，或所有 SDF 物体都遮挡场景几何）。
