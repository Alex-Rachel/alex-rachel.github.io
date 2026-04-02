---
title: Unity Shader 系列（二十八）：URP 后处理完整指南
date: 2026-04-29 12:00:00
tags: [HLSL, URP, 后处理, Volume框架, Renderer Feature]
---

URP 的后处理系统经历了从 Post Processing Stack v2 到原生 Volume 框架的重大重构。本文从 Volume 框架的使用，到自定义 Renderer Feature 的完整 C# 代码，再到移动端性能优化策略，全面覆盖 Unity URP 后处理开发的核心知识。

## URP Volume 框架：内置后处理效果

URP 的后处理通过 Volume 系统管理。Volume 是场景中的触发区域，相机进入时激活对应的后处理参数。

**配置步骤**：
1. 在 URP Asset 中确保 `Post Processing` 已勾选
2. 在相机的 `Additional Camera Data` 组件中开启 `Post Processing`
3. 在场景中创建 Volume（`GameObject → Volume → Global Volume`）
4. 在 Volume 的 Profile 中添加需要的后处理效果

**内置后处理效果参考**：

| 效果 | 主要参数 | 适用场景 |
|------|----------|----------|
| Bloom | Threshold, Intensity, Scatter | 发光物体、UI 特效 |
| Color Grading | LUT, Exposure, Saturation | 整体画面风格 |
| Chromatic Aberration | Intensity | 损伤/过载感觉 |
| Vignette | Intensity, Smoothness | 焦点引导、恐怖气氛 |
| Film Grain | Type, Intensity | 胶片风格、复古感 |
| Depth of Field | Focus Distance, Aperture | 叙事焦点、过场动画 |
| Motion Blur | Intensity | 高速场景、动作游戏 |
| Lens Distortion | Intensity, Scale | 鱼眼效果、眩晕感 |

## 自定义后处理：VolumeComponent + ScriptableRendererFeature

URP 自定义后处理需要三个文件：VolumeComponent（参数定义）、ScriptableRendererFeature（渲染器集成）、Shader（实际效果）。

### 第一步：定义 VolumeComponent

```csharp
// CyberpunkScanlineEffect.cs
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

[System.Serializable, VolumeComponentMenuForRenderPipeline(
    "Custom/Cyberpunk Scanline", typeof(UniversalRenderPipeline))]
public class CyberpunkScanlineEffect : VolumeComponent, IPostProcessComponent
{
    // 所有参数都要用 ClampedFloatParameter 等 Parameter 包装类
    [Header("扫描线")]
    public ClampedFloatParameter scanlineIntensity = new ClampedFloatParameter(0.3f, 0f, 1f);
    public ClampedFloatParameter scanlineFrequency = new ClampedFloatParameter(300f, 50f, 1000f);
    public ClampedFloatParameter scanlineSpeed = new ClampedFloatParameter(1f, 0f, 5f);

    [Header("色彩偏移（赛博朋克色调）")]
    public ClampedFloatParameter colorShiftIntensity = new ClampedFloatParameter(0.5f, 0f, 1f);
    public ColorParameter tintColor = new ColorParameter(new Color(0f, 0.8f, 1f, 1f), false, false, true);

    [Header("色差（Chromatic Aberration）")]
    public ClampedFloatParameter aberrationStrength = new ClampedFloatParameter(0.005f, 0f, 0.02f);
    public ClampedIntParameter aberrationSamples = new ClampedIntParameter(6, 2, 16);

    [Header("噪点")]
    public ClampedFloatParameter noiseIntensity = new ClampedFloatParameter(0.02f, 0f, 0.1f);

    // 是否激活（Volume 混合需要）
    public bool IsActive() => scanlineIntensity.value > 0f || colorShiftIntensity.value > 0f;
    public bool IsTileCompatible() => false;
}
```

### 第二步：实现 ScriptableRendererFeature

```csharp
// CyberpunkScanlineFeature.cs
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public class CyberpunkScanlineFeature : ScriptableRendererFeature
{
    [SerializeField] private Shader _shader;
    private Material _material;
    private CyberpunkScanlinePass _pass;

    public override void Create()
    {
        if (_shader == null) return;
        _material = CoreUtils.CreateEngineMaterial(_shader);
        _pass = new CyberpunkScanlinePass(_material);
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        // 编辑器预览时也执行
        if (renderingData.cameraData.cameraType == CameraType.Preview) return;

        // 从 Volume 栈获取当前参数
        var stack = VolumeManager.instance.stack;
        var effect = stack.GetComponent<CyberpunkScanlineEffect>();
        if (effect == null || !effect.IsActive()) return;

        _pass.Setup(effect);
        renderer.EnqueuePass(_pass);
    }

    protected override void Dispose(bool disposing)
    {
        CoreUtils.Destroy(_material);
    }

    class CyberpunkScanlinePass : ScriptableRenderPass
    {
        private Material _material;
        private CyberpunkScanlineEffect _effect;
        private RTHandle _tempRT;

        // Shader 属性 ID（预取比 string 查找快）
        private static readonly int ScanlineIntensityID = Shader.PropertyToID("_ScanlineIntensity");
        private static readonly int ScanlineFrequencyID = Shader.PropertyToID("_ScanlineFrequency");
        private static readonly int ScanlineSpeedID = Shader.PropertyToID("_ScanlineSpeed");
        private static readonly int ColorShiftID = Shader.PropertyToID("_ColorShiftIntensity");
        private static readonly int TintColorID = Shader.PropertyToID("_TintColor");
        private static readonly int AberrationStrengthID = Shader.PropertyToID("_AberrationStrength");
        private static readonly int AberrationSamplesID = Shader.PropertyToID("_AberrationSamples");
        private static readonly int NoiseIntensityID = Shader.PropertyToID("_NoiseIntensity");

        public CyberpunkScanlinePass(Material material)
        {
            _material = material;
            renderPassEvent = RenderPassEvent.BeforeRenderingPostProcessing;
        }

        public void Setup(CyberpunkScanlineEffect effect) { _effect = effect; }

        public override void OnCameraSetup(CommandBuffer cmd, ref RenderingData renderingData)
        {
            RenderTextureDescriptor desc = renderingData.cameraData.cameraTargetDescriptor;
            desc.depthBufferBits = 0;
            RenderingUtils.ReAllocateIfNeeded(ref _tempRT, desc, name: "_CyberpunkTempRT");
        }

        public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
        {
            if (_material == null || _effect == null) return;

            // 将当前 Volume 参数传入 Shader
            _material.SetFloat(ScanlineIntensityID, _effect.scanlineIntensity.value);
            _material.SetFloat(ScanlineFrequencyID, _effect.scanlineFrequency.value);
            _material.SetFloat(ScanlineSpeedID, _effect.scanlineSpeed.value);
            _material.SetFloat(ColorShiftID, _effect.colorShiftIntensity.value);
            _material.SetColor(TintColorID, _effect.tintColor.value);
            _material.SetFloat(AberrationStrengthID, _effect.aberrationStrength.value);
            _material.SetInt(AberrationSamplesID, _effect.aberrationSamples.value);
            _material.SetFloat(NoiseIntensityID, _effect.noiseIntensity.value);

            CommandBuffer cmd = CommandBufferPool.Get("Cyberpunk Scanline");
            var cameraTarget = renderingData.cameraData.renderer.cameraColorTargetHandle;

            // 后处理标准流程：源 → 临时 → 源（双 Blit 防止读写同一 RT）
            Blitter.BlitCameraTexture(cmd, cameraTarget, _tempRT);
            Blitter.BlitCameraTexture(cmd, _tempRT, cameraTarget, _material, 0);

            context.ExecuteCommandBuffer(cmd);
            CommandBufferPool.Release(cmd);
        }

        public override void OnCameraCleanup(CommandBuffer cmd) { }
    }
}
```

### 第三步：后处理 Shader

```hlsl
// CyberpunkScanline.shader
Shader "Hidden/URP/CyberpunkScanline"
{
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }
        ZWrite Off Cull Off ZTest Always

        Pass
        {
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            TEXTURE2D_X(_BlitTexture); SAMPLER(sampler_BlitTexture);

            CBUFFER_START(UnityPerMaterial)
                float _ScanlineIntensity;
                float _ScanlineFrequency;
                float _ScanlineSpeed;
                float _ColorShiftIntensity;
                float4 _TintColor;
                float _AberrationStrength;
                int _AberrationSamples;
                float _NoiseIntensity;
            CBUFFER_END

            // 简单噪点哈希
            float Hash(float2 uv)
            {
                return frac(sin(dot(uv, float2(12.9898, 78.233))) * 43758.5453);
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.texcoord;

                // ===== 色差（径向 RGB 分离）=====
                float2 center = uv - 0.5;
                float3 color = 0.0;
                float totalWeight = 0.0;
                for (int i = 0; i < _AberrationSamples; i++)
                {
                    float t = (float)i / (float)(_AberrationSamples - 1);
                    float scale = 1.0 + (t - 0.5) * _AberrationStrength;
                    float2 aberrUV = 0.5 + center * scale;

                    // 每次采样 RGB 的不同通道（红向外，蓝向内）
                    float rScale = 1.0 + t * _AberrationStrength;
                    float bScale = 1.0 - t * _AberrationStrength;
                    color.r += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_BlitTexture,
                                    0.5 + center * rScale).r;
                    color.g += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_BlitTexture,
                                    aberrUV).g;
                    color.b += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_BlitTexture,
                                    0.5 + center * bScale).b;
                    totalWeight += 1.0;
                }
                color /= totalWeight;

                // ===== 扫描线 =====
                // 高频扫描线（水平条纹）
                float scanlineY = uv.y * _ScanlineFrequency - _Time.y * _ScanlineSpeed;
                float scanline = pow(abs(sin(scanlineY * 3.14159)), 3.0);
                scanline = lerp(1.0 - _ScanlineIntensity, 1.0, scanline);
                color *= scanline;

                // ===== 赛博朋克色调偏移 =====
                // 将颜色向赛博朋克风格偏移（青色/品红高光）
                float luminance = dot(color, float3(0.299, 0.587, 0.114));
                float3 tinted = lerp(color, color * _TintColor.rgb * 1.5, _ColorShiftIntensity * 0.4);
                color = lerp(color, tinted, _ColorShiftIntensity);

                // 暗部加青色，高光加品红（典型赛博朋克分色调）
                float3 shadowTint = float3(0.0, 0.2, 0.4) * _ColorShiftIntensity;
                float3 highlightTint = float3(0.4, 0.0, 0.3) * _ColorShiftIntensity;
                color += lerp(shadowTint, highlightTint, luminance) * 0.3;

                // ===== 动态噪点 =====
                float noise = Hash(uv * 1000.0 + frac(_Time.y)) - 0.5;
                color += noise * _NoiseIntensity;

                return half4(saturate(color), 1.0);
            }
            ENDHLSL
        }
    }
}
```

## URP 内置后处理详细配置

### Bloom 配置要点

```
Threshold：0.9（只让超亮区域产生光晕，避免全图模糊）
Intensity：0.5~1.0（过高会导致画面过曝）
Scatter：0.5~0.7（控制光晕扩散范围）
High Quality Filtering：移动端关闭（节省性能）
```

**踩坑**：URP Bloom 在 HDR 关闭时效果很差，务必在 Camera 的 `Additional Camera Data` 中开启 HDR。

### Color Grading 配置要点

URP 支持两种工作流：
- **HDR 模式**（推荐）：在线性 HDR 空间调色，质量最高
- **LDR 模式**：在 LDR 空间调色，性能更好但质量有限

LUT（Look Up Table）是最高效的颜色风格化方案，只需一次纹理查找即可应用复杂的颜色变换：

```csharp
// C# 脚本动态切换 LUT（根据区域/时间变化）
var colorGrading = volume.profile.TryGet<ColorAdjustments>(out var colorAdj);
if (colorAdj != null)
{
    colorAdj.colorFilter.value = dayNightBlend > 0.5 ? nightColor : dayColor;
}
```

## 移动端后处理性能优化

移动端 GPU 的带宽限制和 Tile-based 架构对后处理性能影响极大：

**禁用/降级建议**：

| 效果 | 移动端建议 | 原因 |
|------|-----------|------|
| Depth of Field | 关闭或用 Gaussian 模式 | Bokeh 模式开销极大 |
| Motion Blur | 关闭 | 需要额外 Pass |
| Screen Space Ambient Occlusion | 关闭 | 多 Pass 带宽消耗 |
| Bloom | 开启但降低质量 | 禁用 High Quality Filtering |
| Color Grading | 使用 LUT（低开销）| 避免复杂曲线调整 |
| Film Grain | 关闭 | 带宽浪费 |

**URP 移动端后处理最佳实践**：
- 将多个轻量后处理合并到单个 Pass（减少全屏 Blit 次数）
- 使用 `RenderPassEvent.AfterRenderingPostProcessing` 合批
- 避免在后处理 Shader 中使用依赖型纹理读取（Dependent Texture Read）

```hlsl
// 错误：依赖型读取（UV 基于另一个纹理采样结果）
float2 offset = tex2D(_OffsetTex, uv).rg; // 第一次采样
float3 color = tex2D(_MainTex, uv + offset); // 第二次采样依赖第一次结果

// 正确：所有 UV 偏移在 Vertex Shader 预计算，Fragment 直接使用
```

## 完整的 C# 自定义效果注册流程

```csharp
// 在 URP Asset 中注册自定义 Renderer Feature 的步骤：
// 1. 创建 CyberpunkScanlineFeature.cs
// 2. 在 Project 面板中选择 URP Renderer Asset（ForwardRenderer）
// 3. Inspector → Renderer Features → Add Renderer Feature → 选择 CyberpunkScanlineFeature
// 4. 在 Scene 中创建 Volume（Global）
// 5. 在 Volume 的 Profile 中添加 CyberpunkScanlineEffect
// 6. 调整参数即可在 Game View 中看到效果
```

## ShaderGraph 后处理实现

ShaderGraph 2022+ 支持全屏效果（Fullscreen Shader Graph），可以直接在 Graph 中实现后处理，无需手写 Blit Shader：

1. 右键 Project → `Create → Shader Graph → URP → Fullscreen Shader Graph`
2. 添加 `URP Sample Buffer` 节点（类型选 `BlitSource`）获取当前屏幕颜色
3. 添加 `Screen Position` 节点获取 UV
4. 在 Graph 中实现后处理逻辑
5. 在 Renderer Feature 中将此 Shader Graph 编译的材质指定给 `Blitter`

后处理是提升游戏画质感的最高效手段之一。一个好的 Volume 参数配置加上 1-2 个自定义效果，可以让普通场景瞬间拥有商业游戏的视觉质感。关键是要理解每种效果的性能开销，在移动端上做出正确的取舍。
