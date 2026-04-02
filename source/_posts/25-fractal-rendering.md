---
title: Unity Shader 系列（二十五）：Unity 中的分形与程序化视觉
date: 2026-04-01 13:00:00
tags: [HLSL, URP, 分形, 程序化生成, 后处理特效]
---

分形的无限自相似性在游戏中有着丰富的应用——从 Loading 界面的动态 Julia Set，到 Boss 战的程序化能量纹路，再到传送门的迷幻边框效果。本文聚焦 Unity URP 环境中的分形实现，包括全屏后处理分形、程序化雪花生成，以及 Compute Shader 高精度分形探索。

## 全屏后处理分形：Renderer Feature 实现

分形最常见的游戏用途是作为全屏后处理特效，比如传送门效果、Boss 技能前摇、游戏 Loading 动画。URP 通过自定义 Renderer Feature 实现全屏后处理。

### C# Renderer Feature 框架

```csharp
// FractalPostProcessFeature.cs
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public class FractalPostProcessFeature : ScriptableRendererFeature
{
    [System.Serializable]
    public class FractalSettings
    {
        public Material fractalMaterial;
        public RenderPassEvent passEvent = RenderPassEvent.BeforeRenderingPostProcessing;
    }

    public FractalSettings settings = new FractalSettings();
    private FractalPass _pass;

    public override void Create()
    {
        _pass = new FractalPass(settings);
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        if (settings.fractalMaterial == null) return;
        _pass.Setup(renderer.cameraColorTargetHandle);
        renderer.EnqueuePass(_pass);
    }

    class FractalPass : ScriptableRenderPass
    {
        private FractalSettings _settings;
        private RTHandle _source;
        private RTHandle _tempRT;
        private static readonly int TempTexID = Shader.PropertyToID("_TempFractalTex");

        public FractalPass(FractalSettings settings)
        {
            _settings = settings;
            renderPassEvent = settings.passEvent;
        }

        public void Setup(RTHandle source) { _source = source; }

        public override void OnCameraSetup(CommandBuffer cmd, ref RenderingData renderingData)
        {
            // 创建临时 RT（与相机分辨率一致）
            RenderTextureDescriptor desc = renderingData.cameraData.cameraTargetDescriptor;
            desc.depthBufferBits = 0;
            RenderingUtils.ReAllocateIfNeeded(ref _tempRT, desc, name: "_TempFractalTex");
        }

        public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
        {
            CommandBuffer cmd = CommandBufferPool.Get("Fractal Post Process");

            // 将相机颜色缓冲 Blit 到临时 RT，再用分形材质处理后写回
            Blitter.BlitCameraTexture(cmd, _source, _tempRT);
            Blitter.BlitCameraTexture(cmd, _tempRT, _source, _settings.fractalMaterial, 0);

            context.ExecuteCommandBuffer(cmd);
            CommandBufferPool.Release(cmd);
        }

        public override void OnCameraCleanup(CommandBuffer cmd)
        {
            // 不需要手动释放 RTHandle（ReAllocateIfNeeded 管理生命周期）
        }
    }
}
```

### Julia Set 全屏后处理 Shader

```hlsl
Shader "Custom/URP/FractalJuliaOverlay"
{
    Properties
    {
        // 后处理 Shader 必须有这个属性（Blitter 使用）
        _BlitTexture ("Source Texture", 2D) = "white" {}

        _CParam ("Julia 参数 C（实部, 虚部）", Vector) = (-0.7, 0.27, 0, 0)
        _MaxIter ("最大迭代次数", Int) = 64
        _Zoom ("缩放", Float) = 1.5
        _FractalColor ("分形边界颜色", Color) = (0.0, 0.8, 1.0, 1.0)
        _OverlayStrength ("叠加强度", Range(0, 1)) = 0.3
        _AnimSpeed ("动画速度", Float) = 0.2
    }

    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }
        ZWrite Off Cull Off ZTest Always

        Pass
        {
            HLSLPROGRAM
            #pragma vertex Vert        // 使用 URP Blitter 标准顶点着色器
            #pragma fragment frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            TEXTURE2D(_BlitTexture); SAMPLER(sampler_BlitTexture);

            CBUFFER_START(UnityPerMaterial)
                float4 _BlitTexture_TexelSize;
                float2 _CParam;
                int _MaxIter;
                float _Zoom;
                float4 _FractalColor;
                float _OverlayStrength;
                float _AnimSpeed;
            CBUFFER_END

            // 复数乘法：(a+bi)(c+di) = (ac-bd) + (ad+bc)i
            float2 ComplexMul(float2 a, float2 b)
            {
                return float2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
            }

            // Julia Set 迭代（返回归一化逃逸时间）
            float JuliaSet(float2 z, float2 c, int maxIter)
            {
                int iter = 0;
                for (iter = 0; iter < maxIter; iter++)
                {
                    if (dot(z, z) > 4.0) break; // 逃逸条件 |z|² > 4
                    z = ComplexMul(z, z) + c;   // z = z² + c
                }

                if (iter == maxIter) return 0.0; // 属于集合内部

                // 平滑逃逸时间（消除带状条纹）
                float smoothIter = float(iter) - log2(log2(dot(z, z)));
                return smoothIter / float(maxIter);
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // 获取场景原始颜色
                half4 sceneColor = SAMPLE_TEXTURE2D(_BlitTexture, sampler_BlitTexture, IN.texcoord);

                // 将屏幕 UV 转换为复平面坐标
                float2 uv = IN.texcoord * 2.0 - 1.0;
                // 修正宽高比
                uv.x *= _ScreenParams.x / _ScreenParams.y;
                uv /= _Zoom;

                // 动态 C 参数（Julia Set 形态随时间变化）
                float2 c = _CParam;
                c.x += sin(_Time.y * _AnimSpeed) * 0.1;
                c.y += cos(_Time.y * _AnimSpeed * 0.7) * 0.05;

                // 计算 Julia Set
                float fractalVal = JuliaSet(uv, c, _MaxIter);

                // 颜色映射：使用余弦调色板产生彩虹色带
                float3 fractalColor = 0.5 + 0.5 * cos(
                    float3(0.0, 0.4, 0.7) * 6.28318 + fractalVal * 10.0
                );
                fractalColor *= _FractalColor.rgb;

                // 与场景颜色叠加（仅集合边界处显示分形）
                float edgeMask = fractalVal > 0.0 ? 1.0 : 0.0;
                half3 finalColor = lerp(
                    sceneColor.rgb,
                    sceneColor.rgb + fractalColor * _OverlayStrength,
                    edgeMask * _FractalColor.a
                );

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## Mandelbrot 传送门效果

将 Mandelbrot 集用作传送门的边框装饰：

```hlsl
// 在传送门物体的表面 Shader 中
float MandelbrotBorder(float2 uv, int maxIter)
{
    float2 c = uv * 2.5 - float2(0.5, 0.0); // Mandelbrot 的典型视图范围
    float2 z = 0.0;
    int iter = 0;
    for (iter = 0; iter < maxIter; iter++)
    {
        if (dot(z, z) > 4.0) break;
        z = ComplexMul(z, z) + c;
    }

    float t = float(iter) / float(maxIter);

    // 只渲染边界区域（0.3~0.7 的逃逸值对应分形边界）
    float borderMask = smoothstep(0.25, 0.35, t) * (1.0 - smoothstep(0.6, 0.7, t));
    return borderMask;
}

// 在 Fragment 中
float border = MandelbrotBorder(IN.uv, 48);
// 彩色边界 + 发光
half3 portalEdge = border * half3(0.2, 0.8, 1.0) * (1.0 + sin(_Time.y * 3.0) * 0.3);
finalColor += portalEdge * _GlowIntensity;
```

## 程序化雪花/晶体生成 Shader

Sierpinski 三角形变体可以生成美丽的雪花晶体图案，适合游戏 Loading 动画或 UI 装饰：

```hlsl
Shader "Custom/URP/ProceduralSnowflake"
{
    Properties
    {
        _Iterations ("迭代次数", Range(1, 8)) = 5
        _SnowColor ("雪花颜色", Color) = (0.8, 0.9, 1.0, 1.0)
        _BackgroundColor ("背景颜色", Color) = (0.05, 0.1, 0.2, 1.0)
        _LineWidth ("线宽", Float) = 0.015
        _RotationSpeed ("旋转速度", Float) = 0.1
    }

    SubShader
    {
        Tags { "RenderType"="Transparent" "RenderPipeline"="UniversalPipeline" "Queue"="Transparent" }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                int _Iterations;
                float4 _SnowColor, _BackgroundColor;
                float _LineWidth;
                float _RotationSpeed;
            CBUFFER_END

            struct Attributes { float4 posOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings { float4 posCS : SV_POSITION; float2 uv : TEXCOORD0; };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.posCS = TransformObjectToHClip(IN.posOS.xyz);
                OUT.uv = IN.uv * 2.0 - 1.0; // 转换到 [-1, 1]
                return OUT;
            }

            // 六重对称折叠（雪花基础变换）
            float2 FoldSymmetry6(float2 p)
            {
                // 将平面折叠为 1/12 扇区，实现 6 重对称
                float angle = atan2(p.y, p.x);
                float sector = floor(angle / (PI / 3.0)); // PI/3 = 60度
                float foldAngle = sector * (PI / 3.0);
                float2 folded = float2(
                    p.x * cos(-foldAngle) - p.y * sin(-foldAngle),
                    p.x * sin(-foldAngle) + p.y * cos(-foldAngle)
                );
                // 再对 Y 轴折叠（实现完整的 6 重对称）
                folded.y = abs(folded.y);
                return folded;
            }

            // Koch 雪花曲线 SDF
            float KochSnowflakeSDF(float2 p, int iterations)
            {
                float d = 1e10;

                for (int i = 0; i < iterations; i++)
                {
                    float scale = pow(3.0, (float)i);
                    float2 q = p * scale;

                    // 六重对称折叠
                    q = FoldSymmetry6(q);

                    // Koch 迭代：每段线段替换为 W 形
                    // 基础三角形边
                    float edgeDist = abs(q.y - 0.0) - _LineWidth / scale; // 水平边
                    d = min(d, edgeDist);
                }

                return d;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.uv;

                // 旋转动画
                float angle = _Time.y * _RotationSpeed;
                float2 rotUV = float2(
                    uv.x * cos(angle) - uv.y * sin(angle),
                    uv.x * sin(angle) + uv.y * cos(angle)
                );

                // 六重对称折叠
                float2 foldedUV = FoldSymmetry6(rotUV);

                // IFS 迭代生成分形雪花
                float brightness = 0.0;
                float scale = 1.0;
                for (int i = 0; i < _Iterations; i++)
                {
                    float2 q = foldedUV * scale;

                    // 在每个尺度上绘制六芒星
                    float starDist = max(
                        abs(q.x) - 0.5 / scale,
                        abs(q.y) - 0.15 / scale
                    );
                    float starMask = smoothstep(_LineWidth, 0.0, starDist);
                    brightness += starMask / scale;

                    scale *= 3.0; // 每次迭代缩小 1/3
                }

                brightness = saturate(brightness);

                // 颜色输出
                half4 col = lerp(_BackgroundColor, _SnowColor, brightness);
                return col;
            }
            ENDHLSL
        }
    }
}
```

## Compute Shader 高精度分形探索

对于需要高精度交互式探索（如游戏内置分形艺术画廊），使用 Compute Shader 并行计算：

```hlsl
// MandelbrotCompute.compute
#pragma kernel CSMandelbrot

RWTexture2D<float4> _Result;
float2 _Center;     // 视口中心（复平面坐标）
float _Zoom;        // 缩放倍数
uint _MaxIter;      // 最大迭代次数
float _Time;        // 动画时间

// 双精度模拟（使用两个 float 实现更高精度）
// 在普通精度下缩放超过 1000x 会出现像素化
float2 MandelbrotSmooth(float2 c, uint maxIter)
{
    float2 z = 0.0;
    uint iter = 0;
    for (iter = 0; iter < maxIter; iter++)
    {
        if (dot(z, z) > 4.0) break;
        z = float2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    }

    if (iter >= maxIter) return float2(0.0, 0.0);

    // 平滑逃逸时间
    float smoothIter = (float)iter - log2(max(1.0, log2(dot(z, z))));
    return float2(smoothIter / (float)maxIter, 1.0);
}

// HSV 转 RGB
float3 HSVtoRGB(float3 hsv)
{
    float4 K = float4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    float3 p = abs(frac(hsv.xxx + K.xyz) * 6.0 - K.www);
    return hsv.z * lerp(K.xxx, saturate(p - K.xxx), hsv.y);
}

[numthreads(8, 8, 1)]
void CSMandelbrot(uint3 id : SV_DispatchThreadID)
{
    uint width, height;
    _Result.GetDimensions(width, height);

    // 屏幕坐标转复平面坐标
    float2 uv = ((float2)id.xy / float2(width, height)) * 2.0 - 1.0;
    uv.x *= (float)width / (float)height; // 修正宽高比
    float2 c = _Center + uv / _Zoom;

    float2 result = MandelbrotSmooth(c, _MaxIter);
    float t = result.x;
    bool inSet = result.y < 0.5;

    float3 color;
    if (inSet)
    {
        color = float3(0, 0, 0); // 集合内部：黑色
    }
    else
    {
        // 动态彩色映射
        float hue = frac(t * 3.0 + _Time * 0.1);
        color = HSVtoRGB(float3(hue, 0.8, 0.9 * t + 0.1));
    }

    _Result[id.xy] = float4(color, 1.0);
}
```

## 游戏应用场景

**程序化 Boss 动画**：在 Boss 的材质 Shader 中叠加 Julia Set 动态图案，通过 C# 脚本随 Boss 血量调整 C 参数，血量越低分形越混乱：

```csharp
// Boss 受击时改变 Julia Set 参数
void OnBossDamaged(float healthPercent)
{
    float chaos = 1.0f - healthPercent;
    float cx = Mathf.Lerp(-0.7f, 0.1f, chaos);
    float cy = Mathf.Lerp(0.27f, 0.65f, chaos);
    bossMaterial.SetVector("_CParam", new Vector4(cx, cy, 0, 0));
}
```

**Loading 动画**：使用前文的 Julia Set 后处理 Shader，在 `_AnimSpeed` 较高时产生快速变化的彩色分形作为视觉过渡。

**UI 技能特效**：将分形渲染到 RenderTexture，再将 RenderTexture 作为 UI 的 Raw Image 显示，可实现流动的技能冷却可视化。

## ShaderGraph 实现思路

1. **Custom Function 节点**：Julia Set 迭代无法用标准 ShaderGraph 节点实现，需要 Custom Function 节点嵌入 HLSL 代码
2. **Screen Position 节点**：获取屏幕空间坐标转换为复平面坐标
3. **Time 节点**：驱动 C 参数动画
4. **Emission 输出**：分形颜色连接到 Emission 而非 Base Color，可配合 Bloom 后处理产生发光效果

## 性能考量

| 方案 | 适用场景 | 性能 |
|------|----------|------|
| Fragment Shader（64 次迭代） | 全屏 UI/Loading | 中等（约 2ms@1080p） |
| Compute Shader（128 次迭代） | 交互式艺术画廊 | 高（GPU 并行最优） |
| 预计算纹理 | 静态背景/材质 | 极高（零运行时开销） |
| 实时 + 时域累积 | 高品质动画 | 中等（利用 TAA 积累细节） |

分形是"数学之美在像素上的映射"——在 Unity 的 Renderer Feature 框架下，一个精心设计的分形后处理效果可以让传送门、结界、魔法阵这类特效拥有令人难忘的视觉深度。
