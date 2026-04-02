---
title: Unity Shader 系列（五）：Unity 颜色管理与 URP 后处理 — 赛博朋克风格特效
date: 2026-04-01 09:40:00
tags: [HLSL, URP, 颜色空间, 后处理, Color Grading]
categories:
  - Unity Shader 系列
  - 纹理与颜色
---

## Linear vs Gamma：最容易踩的颜色陷阱

许多 Unity 项目的颜色看起来"不对"——材质太亮、阴影太浅、HDR 泛光颜色偏差——根本原因往往是对 Linear/Gamma 工作流的误解。

**核心问题：**人眼对亮度的感知是非线性的（gamma 约 2.2）。显示器为适配人眼也用 gamma 编码存储颜色。但物理光照计算必须在线性空间进行，否则结果是错误的。

**Unity 的两种工作流：**

| 设置 | 位置 | 推荐场景 |
|------|------|---------|
| `Linear` | Project Settings → Player → Color Space | 所有写实渲染项目（URP 默认） |
| `Gamma` | 同上 | 旧项目兼容，2D 像素风格游戏 |

**在 Linear 工作流下，Unity 自动处理：**
- 纹理从 sRGB（gamma 编码）读取时自动线性化（如果纹理标记为 `sRGB`）
- 最终渲染结果自动应用 gamma 编码后输出到显示器
- Shader 中的颜色属性（`Color` 类型）自动从 sRGB 转换为线性传入

**不会自动处理的情况（需要手动注意）：**
- 法线贴图、Mask 贴图：必须在 Import Settings 中取消 `sRGB` 勾选，否则 Unity 会错误地对非颜色数据进行线性化
- 自定义 RenderTexture：需要手动设置 `RenderTextureFormat` 的 sRGB 标志
- 在 Shader 中手动做颜色空间转换

## Shader 中的颜色空间转换

```hlsl
// ===== URP 内置颜色空间转换函数（在 Color.hlsl 中）=====

// Linear → sRGB（输出前编码）
float3 LinearToSRGB(float3 color);

// sRGB → Linear（从非标记纹理手动解码）
float3 SRGBToLinear(float3 color);

// 近似版本（性能更好）
// Gamma 编码近似：pow(color, 1.0/2.2)
// Gamma 解码近似：pow(color, 2.2)

// ===== URP Color Grading 相关 =====
// 获取 Color Grading LUT（用于 Custom Post Process Volume）
// 通过 _InternalLut 访问，但通常不直接使用

// HDR 色调映射（用于 Emission 颜色控制）
// Emission = _EmissionColor * intensity
// 当 intensity > 1 时产生 HDR 发光，配合 Bloom 使用
```

## URP 后处理架构

URP 的后处理系统基于 **Volume** 框架：
1. 在场景中创建 `Global Volume` 对象
2. 添加 `Bloom`、`Color Grading`、`Tonemapping` 等 Override
3. URP 在最终 Blit 阶段自动应用这些效果

**内置效果链（执行顺序）：**
```
Render Scene → Bloom（泛光） → Color Grading（LUT 应用）→ Tonemapping → Film Grain → Vignette → Output
```

**自定义后处理：Custom Renderer Feature**

URP 允许通过 `ScriptableRendererFeature` 插入自定义 Pass：

```csharp
// C# 侧：注册自定义后处理 Pass
public class CyberpunkPostProcess : ScriptableRendererFeature
{
    public CyberpunkSettings settings;

    class CyberpunkPass : ScriptableRenderPass
    {
        // 后处理材质
        Material _material;
        RTHandle _tempRT;

        public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
        {
            // 获取当前帧的颜色缓冲
            var source = renderingData.cameraData.renderer.cameraColorTargetHandle;
            // Blit：将当前帧颜色作为 _MainTex 传入后处理 Shader
            Blitter.BlitCameraTexture(cmd, source, _tempRT, _material, 0);
            Blitter.BlitCameraTexture(cmd, _tempRT, source);
        }
    }
}
```

## 完整示例：赛博朋克风格后处理 Shader

色相偏移 + 扫描线 + 故障噪声（Glitch）的完整 URP Custom Post Process Shader：

```hlsl
Shader "Custom/URP/PostProcess/Cyberpunk"
{
    Properties
    {
        // 后处理 Shader 通常不在 Inspector 暴露参数，由 C# Volume 控制
        [HideInInspector] _MainTex ("Screen Texture", 2D) = "white" {}
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
        }

        // 后处理不需要深度测试/写入
        Cull Off
        ZWrite Off
        ZTest Always

        Pass
        {
            Name "CyberpunkPost"

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            // _BlitTexture 是 URP Blit 框架注入的屏幕纹理
            // 通过 Blit.hlsl 的 vert 函数自动处理全屏三角形

            // 可调参数（由 C# 通过 Material.SetFloat 传入）
            // 在 CBUFFER 中声明保证 SRP Batcher 兼容
            CBUFFER_START(UnityPerMaterial)
                float _ChromaticAberration;   // 色差强度
                float _ScanlineIntensity;     // 扫描线强度
                float _ScanlineFrequency;     // 扫描线频率
                float _GlitchStrength;        // 故障强度
                float _GlitchSpeed;           // 故障速度
                float _VignetteStrength;      // 暗角强度
                float _HueShift;              // 色相偏移（0~1）
                float _SaturationBoost;       // 饱和度增强
                float _Contrast;              // 对比度
            CBUFFER_END

            // ======== 颜色工具函数 ========

            // RGB → HSV（用于色相调整）
            float3 RGBtoHSV(float3 c)
            {
                float4 K = float4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
                float4 p = c.g < c.b ? float4(c.bg, K.wz) : float4(c.gb, K.xy);
                float4 q = c.r < p.x ? float4(p.xyw, c.r) : float4(c.r, p.yzx);
                float d = q.x - min(q.w, q.y);
                float e = 1.0e-10;
                return float3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
            }

            // HSV → RGB
            float3 HSVtoRGB(float3 c)
            {
                float4 K = float4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
                float3 p = abs(frac(c.xxx + K.xyz) * 6.0 - K.www);
                return c.z * lerp(K.xxx, saturate(p - K.xxx), c.y);
            }

            // ======== 噪声（用于 Glitch 效果） ========
            float hash11(float p)
            {
                return frac(sin(p * 127.1) * 43758.5453);
            }

            float hash21(float2 p)
            {
                return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
            }

            // ======== 色差（Chromatic Aberration）========
            // 红/绿/蓝通道各自在 UV 上微小偏移，模拟镜头色散
            float3 chromaticAberration(TEXTURE2D_X(tex), SAMPLER(samp), float2 uv, float strength)
            {
                // 从屏幕中心向外的方向
                float2 dir = uv - 0.5;
                float2 offset = dir * strength * 0.01;

                float r = SAMPLE_TEXTURE2D_X(tex, samp, uv + offset).r;
                float g = SAMPLE_TEXTURE2D_X(tex, samp, uv).g;
                float b = SAMPLE_TEXTURE2D_X(tex, samp, uv - offset).b;
                return float3(r, g, b);
            }

            // ======== 扫描线 ========
            float scanlines(float2 uv, float frequency, float intensity)
            {
                // 水平扫描线（基于 UV.y）
                float line = sin(uv.y * frequency * 3.14159 * 2.0) * 0.5 + 0.5;
                // 动态扫描（随时间向下移动）
                float moving = frac(uv.y - _Time.y * 0.1) > 0.99 ? 0.5 : 0.0;
                return 1.0 - intensity * (1.0 - line) - moving * intensity * 0.5;
            }

            // ======== 故障效果（Glitch）========
            float3 glitchEffect(TEXTURE2D_X(tex), SAMPLER(samp), float2 uv, float strength, float speed)
            {
                float time = _Time.y * speed;

                // 将屏幕分成水平条带，每条带随机偏移
                float stripHeight = 0.05 + hash11(floor(time * 3.0)) * 0.1;
                float stripID = floor(uv.y / stripHeight);
                float glitchTime = floor(time * 10.0 + stripID);

                // 随机触发故障（不是每帧都触发）
                float trigger = step(0.92, hash11(glitchTime));
                float glitchOffsetX = (hash21(float2(stripID, glitchTime)) - 0.5) * strength * 0.1;

                // 应用水平偏移
                float2 glitchUV = uv + float2(glitchOffsetX * trigger, 0.0);

                // 颜色偏移（模拟数字信号错误）
                float r = SAMPLE_TEXTURE2D_X(tex, samp, glitchUV + float2(strength * 0.005 * trigger, 0)).r;
                float g = SAMPLE_TEXTURE2D_X(tex, samp, glitchUV).g;
                float b = SAMPLE_TEXTURE2D_X(tex, samp, glitchUV - float2(strength * 0.005 * trigger, 0)).b;
                return float3(r, g, b);
            }

            // ======== 暗角（Vignette）========
            float vignetteEffect(float2 uv, float strength)
            {
                float2 center = uv - 0.5;
                float dist = length(center);
                return 1.0 - smoothstep(0.4, 0.9, dist) * strength;
            }

            // ======== 对比度/亮度调整 ========
            float3 adjustContrast(float3 color, float contrast)
            {
                // pivot = 0.5（中点不变）
                return (color - 0.5) * contrast + 0.5;
            }

            // ======== 片元着色器 ========
            half4 frag(Varyings input) : SV_Target
            {
                float2 uv = input.texcoord;

                // === 1. 色差效果 ===
                float3 col = chromaticAberration(
                    TEXTURE2D_X_ARGS(_BlitTexture, sampler_LinearClamp),
                    uv,
                    _ChromaticAberration
                );

                // === 2. 故障效果（叠加在色差之上）===
                if (_GlitchStrength > 0.001)
                {
                    col = glitchEffect(
                        TEXTURE2D_X_ARGS(_BlitTexture, sampler_LinearClamp),
                        uv,
                        _GlitchStrength,
                        _GlitchSpeed
                    );
                }

                // === 3. 色相偏移（赛博朋克青紫色调）===
                float3 hsv = RGBtoHSV(col);
                hsv.x = frac(hsv.x + _HueShift);  // 色相偏移（frac 保证循环）
                hsv.y = saturate(hsv.y * _SaturationBoost);  // 饱和度增强
                col = HSVtoRGB(hsv);

                // === 4. 对比度调整 ===
                col = adjustContrast(col, _Contrast);

                // === 5. 扫描线叠加 ===
                float scanFactor = scanlines(uv, _ScanlineFrequency, _ScanlineIntensity);
                col *= scanFactor;

                // === 6. 暗角 ===
                float vignette = vignetteEffect(uv, _VignetteStrength);
                col *= vignette;

                // === 7. 色调映射 + Gamma（后处理中通常不再做，由 URP 自动处理）===
                // 注意：URP 的 Color Grading Pass 在 Custom Post Process 之后，
                // 如果自定义 Pass 插在 Color Grading 之前，不需要手动做 Tonemapping

                return half4(col, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## HDR 与 Bloom 的正确配合

在 Unity Linear 工作流中，`_EmissionColor` 超过 1 就进入 HDR 范围，Bloom 效果只提取亮度超过阈值的像素：

```hlsl
// 材质中正确设置 Emission 的方式
// 在 Properties 中：
[HDR] _EmissionColor ("Emission Color", Color) = (0, 0, 0, 1)

// 在 Fragment Shader 中：
half3 emission = _EmissionColor.rgb; // 已在 Linear 空间
// 当 _EmissionColor 的亮度 > 1 时，URP Bloom 会自动提取并发光
// 无需手动乘以强度，直接使用 HDR 颜色值

// 技巧：用 emission 的亮度控制自发光（如 UI 能量条满时发光）
float energyLevel = 0.8; // 0~1
half3 glowEmission = _EmissionColor.rgb * energyLevel * 3.0; // ×3 进入 HDR 范围
```

## URP Color Grading LUT 工作原理

URP 的 Color Grading 使用 3D LUT（Look-Up Table）实现：
1. 将渲染好的 HDR 画面通过 Tonemapping 映射到 [0,1]
2. 用映射后的 RGB 值作为 3D 坐标，查找 LUT 纹理中的目标颜色
3. 输出最终 sRGB 颜色

**自定义 LUT 工作流：**
1. 从 Unity 导出基础 LUT 图片（`Post Processing → Export LUT`）
2. 在 Photoshop/DaVinci Resolve 中调色
3. 保存为 `.png` 并导入 Unity（取消 sRGB，格式选 `R8G8B8`）
4. 在 `Color Lookup` Volume Override 中指定

## ShaderGraph 实现色彩调整

ShaderGraph 在 URP 中也支持后处理（通过 `Fullscreen Shader Graph`）：
1. 创建 `Fullscreen Shader Graph`（6.0+ 支持）
2. 节点连接：
   - `URP Sample Buffer` 节点（采样屏幕颜色）
   - `Hue` 节点（调整色相）
   - `Saturation` 节点（调整饱和度）
   - `Contrast` 节点（调整对比度）
3. 在 `Custom Post Process Volume` C# 脚本中引用材质

## 性能考量

| 效果 | 移动端开销 | 建议 |
|------|-----------|------|
| 色差（3 次采样） | 低-中 | 强度限制在 0.3 以内 |
| 扫描线（纯数学） | 极低 | 可在移动端保留 |
| Glitch（随机 + 采样） | 中 | 移动端可降低触发频率 |
| 色相/饱和度调整 | 低 | HSV 转换约 8 条指令 |
| 暗角（smoothstep） | 极低 | 可在所有平台使用 |

**移动端优化：**
- 色差的 3 次采样中，绿通道直接用屏幕中心 UV，只有红蓝偏移，减少 1 次采样
- 扫描线用 `step` 代替 `sin`（更快，但有锯齿感）
- Glitch 效果默认关闭（`_GlitchStrength = 0`），用 `#pragma shader_feature` 编译变体

## 常见踩坑

1. **Gamma 空间下的颜色看起来"过曝"**：如果项目用 Gamma 色彩空间，美术在 Linear 显示器上调的颜色在 Gamma 空间会显得更亮。团队要统一在 Linear 空间工作。

2. **法线贴图/Mask 贴图被错误地 sRGB 处理**：在 Texture Import Settings 中，法线贴图要选 `Normal map` 类型（自动关闭 sRGB），自定义数据纹理要手动取消 `sRGB Color` 勾选。混淆后法线会偏蓝，AO/Roughness 贴图值会非线性偏移。

3. **后处理 Shader 中不要手动做 Gamma 编码**：URP 的后处理 Pass 在 Linear 空间运行，最终由 URP 的输出阶段自动处理 Gamma。如果手动 `pow(color, 1.0/2.2)`，颜色会被双重 Gamma 编码变得过暗。

4. **HDR 颜色属性 `[HDR]` 标签**：在 Properties 中不加 `[HDR]` 的颜色属性只能设置 [0,1] 范围，Inspector 中的颜色选择器不会显示强度滑块，无法设置超过 1 的 HDR 值。

5. **`_Time.y` 在暂停时不会停止**：Unity 的 `_Time.y` 是不受 `Time.timeScale = 0` 影响的（实际上受影响，但 UI 后处理材质可能使用 `_UnscaledTime`）。如果需要响应游戏暂停，在 C# 中传入自定义 float 代替直接使用 `_Time.y`。

下一篇文章将转向 3D SDF 在 Unity 中的实际应用——体积雾、软粒子，以及如何用 URP Custom Render Feature 实现基于 SDF 的局部雾效。
