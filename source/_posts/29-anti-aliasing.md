---
title: Unity Shader 系列（二十九）：Unity URP 抗锯齿方案全比较
date: 2026-04-01 13:40:00
tags: [HLSL, URP, 抗锯齿, TAA, FXAA, MSAA]
---

锯齿是游戏画质的重要负面因素，但不同类型的游戏和平台需要截然不同的抗锯齿方案。本文系统比较 URP 中所有可用的 AA 方案，包括 MSAA、FXAA、TAA、DLSS/FSR 集成，以及自定义 Shader 中的解析抗锯齿技术。

## URP 中的抗锯齿方案概览

Unity URP 提供了多层抗锯齿选项，配置分布在不同位置：

**配置位置说明**：
- **MSAA**：URP Asset → `Quality` → `Anti Aliasing (MSAA)`
- **FXAA / TAA / SMAA**：Camera 组件 → `Additional Camera Data` → `Anti-aliasing`
- **DLSS/FSR**：需要安装对应的 Unity 扩展包

## MSAA：硬件多重采样

MSAA 是传统光栅化管线的标配 AA 方案，直接在 GPU 硬件层面对三角形边缘进行多重采样。

**配置**：
```
URP Asset → Quality → Anti Aliasing (MSAA)
可选：Disabled / 2x / 4x / 8x
```

**原理**：每个像素内有多个子采样点，三角形覆盖率越高，该像素的最终颜色越准确。

**局限性（URP 特有问题）**：
- MSAA 只对几何体光栅化边缘有效，对 Fragment Shader 内部产生的锯齿（如程序化纹理、法线高频变化）无效
- URP 的延迟渲染（Deferred Rendering Path）不支持 MSAA
- 半透明物体不受 MSAA 影响

**移动端性能**：4x MSAA 在 Mali/Adreno 上开销约为 20-40%，但许多移动 GPU 支持 MSAA 的 Framebuffer Compression（AFBC），实际开销可能更低。

```csharp
// C# 动态修改 MSAA（根据帧率动态调整）
void UpdateMSAAQuality(float currentFPS)
{
    var urpAsset = GraphicsSettings.renderPipelineAsset as UniversalRenderPipelineAsset;
    if (urpAsset == null) return;

    if (currentFPS < 30f)
        urpAsset.msaaSampleCount = 1; // 关闭
    else if (currentFPS < 55f)
        urpAsset.msaaSampleCount = 2; // 2x
    else
        urpAsset.msaaSampleCount = 4; // 4x
}
```

## FXAA：快速近似抗锯齿

FXAA 是全屏后处理 AA 方案，通过分析亮度梯度检测边缘，沿边缘方向混合相邻像素。

**URP 配置**：
```
Camera → Additional Camera Data → Anti-aliasing → FXAA
Fast Mode：勾选时使用 5 点采样（质量略降，性能提升约 30%）
```

**手动实现 FXAA（移动端轻量替代版）**：

```hlsl
// 在 URP 自定义 Renderer Feature 中实现轻量 FXAA
half3 LiteFXAA(TEXTURE2D_PARAM(screenTex, sampler_screenTex), float2 uv, float2 texelSize)
{
    // 采样中心 + 4 个正交邻居
    half3 rgbM = SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv).rgb;
    half3 rgbN = SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + float2( 0,  texelSize.y)).rgb;
    half3 rgbS = SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + float2( 0, -texelSize.y)).rgb;
    half3 rgbE = SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + float2( texelSize.x, 0)).rgb;
    half3 rgbW = SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + float2(-texelSize.x, 0)).rgb;

    // 亮度值
    float3 lumaCoeff = float3(0.299, 0.587, 0.114);
    float lumaM = dot(rgbM, lumaCoeff);
    float lumaN = dot(rgbN, lumaCoeff);
    float lumaS = dot(rgbS, lumaCoeff);
    float lumaE = dot(rgbE, lumaCoeff);
    float lumaW = dot(rgbW, lumaCoeff);

    float lumaMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    float lumaMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    float lumaRange = lumaMax - lumaMin;

    // 对比度低的区域跳过（不是边缘）
    if (lumaRange < max(0.0312, lumaMax * 0.125))
        return rgbM;

    // 计算边缘方向
    float2 dir;
    dir.x = -((lumaN + lumaS) - 2.0 * lumaM);
    dir.y =  ((lumaE + lumaW) - 2.0 * lumaM);

    float dirReduce = max(lumaRange * 0.25, 1.0 / 128.0);
    float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, -8.0, 8.0) * texelSize;

    // 沿边缘方向混合（两个采样点的平均）
    half3 rgbA = 0.5 * (
        SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + dir * (1.0/3.0 - 0.5)).rgb +
        SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + dir * (2.0/3.0 - 0.5)).rgb
    );

    // 扩大范围进行验证（FXAA 1.0 原版第二次采样）
    half3 rgbB = rgbA * 0.5 + 0.25 * (
        SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + dir * -0.5).rgb +
        SAMPLE_TEXTURE2D(screenTex, sampler_screenTex, uv + dir *  0.5).rgb
    );

    float lumaB = dot(rgbB, lumaCoeff);
    // 如果扩大范围后亮度超出范围，使用 A 结果
    return (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;
}
```

## TAA：时域抗锯齿

TAA 是当前 AAA 游戏最常用的 AA 方案，通过每帧亚像素级抖动 + 历史帧混合来积累超采样效果。

**URP 2022+ 配置**：
```
Camera → Additional Camera Data → Anti-aliasing → TAA
Quality：Low/Medium/High/Very High
Jitter Spread：抖动幅度（默认 1.0，降低可减少 Ghost）
Sharpness：后处理锐化强度（TAA 会轻微模糊，锐化补偿）
History Sharpness：历史帧锐化
```

**TAA 的核心：Jitter 矩阵原理**

```hlsl
// URP 内部的 Jitter 实现（在 Vertex Shader 中应用）
// 每帧将投影矩阵偏移 0.5~1.0 个像素的亚像素量
float2 GetJitterOffset(int frameIndex, float2 screenSize)
{
    // Halton 序列（比随机更均匀的分布）
    float2 jitter;
    // Halton(2, frameIndex) — 以 2 为基数的 Halton 序列
    float f = 0.5; float r = 0.0;
    int i = frameIndex;
    while (i > 0) { r += f * (float)(i & 1); f *= 0.5; i >>= 1; }
    jitter.x = r;

    // Halton(3, frameIndex) — 以 3 为基数的 Halton 序列
    f = 1.0 / 3.0; r = 0.0; i = frameIndex;
    while (i > 0) { r += f * (float)(i % 3); f /= 3.0; i /= 3; }
    jitter.y = r;

    // 将 [0,1) 映射到 [-0.5, 0.5) 并归一化到屏幕空间
    return (jitter - 0.5) / screenSize;
}

// 在投影矩阵中应用 Jitter
Matrix4x4 ApplyJitter(Matrix4x4 proj, float2 jitter)
{
    proj[0][2] += jitter.x * 2.0; // 修改投影矩阵的 X 偏移
    proj[1][2] += jitter.y * 2.0; // 修改投影矩阵的 Y 偏移
    return proj;
}
```

**TAA Ghost（鬼影）问题**：快速运动物体会在历史帧位置留下残影。解决方案是邻域颜色箝制（Color Clamp）——将历史帧颜色限制在当前帧 3×3 邻域的颜色范围内：

```hlsl
// TAA 历史帧混合（含邻域箝制）
half3 TAABlend(
    TEXTURE2D_PARAM(currentTex, sampler_current),
    TEXTURE2D_PARAM(historyTex, sampler_history),
    float2 uv, float2 texelSize, float blendFactor)
{
    half3 current = SAMPLE_TEXTURE2D(currentTex, sampler_current, uv).rgb;

    // 计算当前帧 3×3 邻域的 Min/Max（用于箝制历史帧）
    half3 vMin = current, vMax = current;
    for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++)
    {
        if (dx == 0 && dy == 0) continue;
        half3 neighbor = SAMPLE_TEXTURE2D(currentTex, sampler_current,
            uv + float2(dx, dy) * texelSize).rgb;
        vMin = min(vMin, neighbor);
        vMax = max(vMax, neighbor);
    }

    // 读取历史帧（需要上一帧的运动向量重投影 UV）
    // float2 motionVec = SAMPLE_TEXTURE2D(_MotionVectorTex, ..., uv).rg;
    // float2 prevUV = uv - motionVec; // 简化：静态场景直接用当前 UV
    half3 history = SAMPLE_TEXTURE2D(historyTex, sampler_history, uv).rgb;

    // 将历史帧颜色箝制在当前帧邻域范围内（消除 Ghost）
    history = clamp(history, vMin, vMax);

    // 指数移动平均混合
    return lerp(current, history, blendFactor);
}
```

## DLSS / AMD FSR 集成

**DLSS 2（NVIDIA Deep Learning Super Sampling）**：
- Unity 官方包：`com.unity.render-pipelines.core` + DLSS Plugin
- 在 Project Settings → NVIDIA → DLSS 中启用
- 在 Camera 的 `Additional Camera Data` 中选择 DLSS 质量模式
- 性能模式（Performance）渲染分辨率降至目标的 50%，但输出接近原生质量

**AMD FSR（FidelityFX Super Resolution）**：
- Unity 通过 `com.unity.render-pipelines.universal` 2022.2+ 内置支持 FSR 1.0
- 配置位置：URP Asset → Quality → Upscaling Filter → FSR
- FSR 2.0+ 需要通过 AMD GPUOpen 的 Unity 扩展包

```csharp
// C# 运行时切换升频模式
void SetUpscalingMode(bool useDLSS, float quality)
{
    Camera cam = Camera.main;
    var camData = cam.GetComponent<UniversalAdditionalCameraData>();

    if (useDLSS && SystemInfo.deviceName.Contains("NVIDIA"))
    {
        // DLSS 需要 NVIDIA Plugin
        // camData.antialiasing = AntialiasingMode.None; // DLSS 自带 AA
    }
    else
    {
        // 使用 URP 内置 FSR
        var urpAsset = GraphicsSettings.renderPipelineAsset as UniversalRenderPipelineAsset;
        urpAsset.upscalingFilter = UpscalingFilterSelection.FSR;

        // 降低渲染分辨率（FSR 在较低分辨率上升频）
        cam.allowDynamicResolution = true;
        ScalableBufferManager.ResizeBuffers(quality, quality); // quality: 0.5~1.0
    }
}
```

## SDF 渲染的解析抗锯齿

对于使用 SDF 绘制的形状（圆形 UI、程序化图案、HUD 元素），`ddx/ddy`（或 `fwidth`）提供了近乎零开销的精确抗锯齿。

```hlsl
// URP HLSL 中的 fwidth 用法
// fwidth(x) = abs(ddx(x)) + abs(ddy(x))，等价于 GLSL 中的 fwidth

float CircleSDF(float2 uv, float radius)
{
    return length(uv) - radius;
}

half4 frag(Varyings IN) : SV_Target
{
    float2 uv = IN.uv * 2.0 - 1.0;

    float d = CircleSDF(uv, 0.5);

    // 方法一：使用 fwidth（自动计算屏幕空间导数）
    float fw = fwidth(d);
    float alpha = smoothstep(fw, -fw, d); // 1像素宽的平滑过渡

    // 方法二：手动指定过渡宽度（适合需要精确控制的场景）
    float pixelWidth = length(float2(ddx(d), ddy(d))); // 等价于 fwidth / sqrt(2)
    float alpha2 = smoothstep(pixelWidth, -pixelWidth, d);

    return half4(_Color.rgb, alpha);
}
```

**`fwidth` 注意事项**：
- 在 `discard` 后使用会导致导数计算错误（梯度信息在 2×2 像素块中共享）
- 在 Fragment Shader 的条件分支内使用可能不稳定，建议在分支前计算
- 移动端 TBDR 架构上 `ddx/ddy` 开销极低，PC 上略高

## 各方案适用平台选择指南

| 平台 | 首选方案 | 备选方案 | 避免 |
|------|----------|----------|------|
| PC（中端及以上） | TAA 或 DLSS | FXAA | 高倍 MSAA |
| PC（NVIDIA 卡） | DLSS 2/3 | TAA | - |
| 主机（PS5/XSX） | TAA | FSR 2 | - |
| 移动高端 | FXAA | 2x MSAA | TAA（Ghost 问题在移动端更明显） |
| 移动低端 | FXAA Fast Mode | 关闭 AA | MSAA、TAA |
| VR | MSAA 4x | FXAA | TAA（会加剧晕动症） |

**选择决策**：
1. 是否有 NVIDIA GPU？→ DLSS，效果最好
2. 是否是运动较少的场景（策略、解谜）？→ FXAA，轻量且无 Ghost
3. 是否是动作游戏，画质优先？→ TAA，启用运动向量消除 Ghost
4. 是否是 VR 或移动端？→ MSAA 或 FXAA，TAA 会加重晕动症
5. 是否是 2D SDF UI 元素？→ fwidth 解析抗锯齿，零开销最优质

## 常见踩坑

**MSAA 不生效**：检查 URP Asset 中是否已设置 MSAA，同时相机的 Rendering Path 不能是 Deferred（Deferred 不支持 MSAA）。

**TAA 造成文字模糊**：将 UI 相机的 AA 模式设置为 FXAA 或关闭，避免 TAA 对高频文字内容造成模糊。TAA 更适合 3D 场景相机。

**FXAA 对粒子无效**：FXAA 基于亮度梯度检测边缘，对半透明粒子的边缘效果有限。粒子抗锯齿应使用软粒子（深度淡化）而非 FXAA。

**fwidth 在 if 分支内失效**：GLSL/HLSL 的 `dFdx/dFdy/fwidth` 在条件分支内计算结果未定义，务必在分支外提前计算。

抗锯齿不是"开了就好"的黑盒特性，理解每种方案的原理和局限性，才能在不同平台和游戏类型中做出正确的权衡。
