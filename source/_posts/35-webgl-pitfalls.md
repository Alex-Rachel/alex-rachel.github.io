---
title: Unity Shader 系列（三十五）：URP Shader 开发常见陷阱与调试指南
date: 2026-04-01 14:40:00
tags: [HLSL, URP, 调试, 常见错误, 平台兼容性]
---

## 为什么需要专门的 URP 调试指南？

将一个在编辑器中完美运行的 Shader 发布到手机端时，可能出现：画面发白、深度排序错乱、法线贴图方向相反、颜色偏亮或偏暗……这些问题大多不是算法错误，而是 **Unity/URP 特有的平台差异、坐标系陷阱和颜色空间问题**。

本篇系统梳理 8 大类常见陷阱，每类给出错误现象、根本原因和正确修复方案，配合 URP 调试工具使用说明。

## 陷阱一：坐标系与手性（左手 vs 右手）

### Unity 坐标系

Unity 使用**左手坐标系**：X 向右，Y 向上，**Z 向屏幕内**（即摄像机朝 +Z 看）。这与 OpenGL 的右手坐标系（Z 向屏幕外）相反。

在 Shader 中计算叉积时必须注意手性：

```hlsl
// OpenGL/GLSL 右手坐标系
// vec3 bitangent = cross(normal, tangent) * tangent.w;

// Unity/HLSL 左手坐标系——结果相同公式，但含义不同
// URP 已在 Core.hlsl 中处理好，直接使用 GetVertexNormalInputs 即可
VertexNormalInputs normalInputs = GetVertexNormalInputs(normalOS, tangentOS);
// normalInputs.tangentWS、bitangentWS、normalWS 已考虑手性
```

### NDC 深度范围

| 平台/API | NDC Z 范围 | 深度 Buffer 值 |
|----------|-----------|--------------|
| DirectX (DX11/DX12) | [0, 1] | 近=1，远=0（Reversed-Z）|
| OpenGL/OpenGL ES | [-1, 1] | 近=0，远=1 |
| Metal (iOS/macOS) | [0, 1] | 近=1，远=0（Reversed-Z）|
| Vulkan | [0, 1] | 取决于设置 |

Unity URP 中用 `UNITY_REVERSED_Z` 宏处理差异：

```hlsl
// 读取深度值时必须考虑 Reversed-Z
float rawDepth = SAMPLE_TEXTURE2D(_CameraDepthTexture, sampler_CameraDepthTexture, uv).r;

#if UNITY_REVERSED_Z
    // DX/Metal：深度 1=近，0=远，需要反转
    float linearDepth = Linear01Depth(1.0 - rawDepth, _ZBufferParams);
#else
    float linearDepth = Linear01Depth(rawDepth, _ZBufferParams);
#endif

// 更简单的方式：URP 提供的宏自动处理
float linearDepth = LinearEyeDepth(rawDepth, _ZBufferParams);
```

## 陷阱二：平台 UV 差异（纹理翻转）

### OpenGL vs DirectX UV 原点

| 平台 | UV 原点 | 纹理 Y 轴方向 |
|------|--------|-------------|
| OpenGL / OpenGL ES | 左下角 | 向上 |
| DirectX / Metal / Vulkan | 左上角 | 向下 |

**症状**：在 Windows（DX11）上正常，在 Metal 或 Android（Vulkan）上图像垂直翻转。

**解决方案**：使用 `_MainTex_TexelSize.y < 0` 检测翻转，或直接用 URP 提供的 `GetNormalizedScreenSpaceUV`：

```hlsl
// 屏幕空间 UV 的正确获取方式（自动处理平台差异）
float2 screenUV = GetNormalizedScreenSpaceUV(IN.positionHCS);

// 手动处理时（抓取纹理 GrabPass 等场景）：
#if UNITY_UV_STARTS_AT_TOP
    // DirectX/Metal：UV.y 需要翻转
    float2 flippedUV = float2(uv.x, 1.0 - uv.y);
#else
    float2 flippedUV = uv;
#endif
```

### Blit 操作的 UV 翻转

使用 URP 的 `Blitter.BlitCameraTexture` 时，已自动处理平台差异。但如果使用旧版 `Graphics.Blit`，需要手动处理：

```hlsl
// 后处理 Shader 中安全获取屏幕 UV
float2 uv = IN.uv;
#if !UNITY_UV_STARTS_AT_TOP
    uv.y = 1.0 - uv.y; // OpenGL 平台翻转
#endif
```

## 陷阱三：颜色空间（最常见的颜色偏差问题）

### Linear vs Gamma 工作流

| 设置 | 含义 | 推荐 |
|------|------|------|
| Gamma 工作流 | 贴图和渲染都在 Gamma 空间 | 旧项目兼容 |
| Linear 工作流 | 贴图 sRGB→Linear 解码，渲染在 Linear 空间，最终 Gamma 编码输出 | 推荐（PBR 正确） |

在 Linear 工作流中，**标记为 sRGB 的纹理**（如 Albedo）会在采样时自动做 Gamma→Linear 转换。但手动创建的 `RenderTexture` 默认不带 sRGB 标记。

**症状**：Shader 计算的颜色比预期亮或暗约 2.2 倍。

```hlsl
// 错误：在 Linear 工作流中直接输出，没有考虑 Gamma 编码
// （URP 会自动处理最终输出的 Gamma 编码，不要手动 pow(color, 1/2.2)！）
return half4(color, 1.0); // 正确

// 错误写法（会导致颜色被 Gamma 编码两次）：
return half4(pow(color, 1.0/2.2), 1.0); // 不要这样做！
```

**sRGB 纹理在 Shader 中的正确处理**：

```hlsl
// 非颜色数据的纹理（法线贴图、Roughness 贴图、Mask 贴图）
// 在 Texture Inspector 中取消勾选 "sRGB (Color Texture)"
// 否则它们会被错误地进行 Gamma 校正，导致法线方向偏差

// 如果无法在 Import Settings 中修改，在 Shader 中手动转换：
half3 normalSample = SAMPLE_TEXTURE2D(_NormalMap, sampler_NormalMap, uv).rgb;
// 非颜色贴图不应有 sRGB 解码，如果误标记了，手动去除：
// normalSample = pow(normalSample, 2.2); // 不推荐，应在 Import Settings 修正
```

### 常见颜色空间错误排查

```hlsl
// 调试：输出颜色空间检测信息
half4 frag(Varyings IN) : SV_Target
{
    // 输出一个已知颜色值，在 Scene View 中对比
    // 如果 Linear 工作流下输出 half3(0.5,0.5,0.5) 显示偏暗，说明 Gamma 工作流
    // 正确的 Linear 下 0.5 灰应该在屏幕上显示为约 186/255 的灰
    return half4(0.5, 0.5, 0.5, 1.0);
}
```

## 陷阱四：精度问题（移动端常见闪烁）

### half vs float 的选择

| 类型 | 精度 | 性能 | 适用 |
|------|------|------|------|
| `float`（32位）| ±3.4×10³⁸，7位十进制 | 基准 | 位置、深度、矩阵变换 |
| `half`（16位）| ±65504，约 3 位十进制 | 移动端 2-4x 快 | 颜色、法线、UV |
| `fixed`（已废弃）| [-2, 2] | - | 不要使用 |

**常见精度陷阱**：

```hlsl
// 错误：用 half 存储世界空间位置
// 大世界坐标（>100）用 half 会损失精度，导致顶点抖动
half3 positionWS = TransformObjectToWorld(positionOS); // 不要用 half！

// 正确：位置用 float
float3 positionWS = TransformObjectToWorld(IN.positionOS.xyz);
// 颜色用 half
half3 albedo = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv).rgb;
```

**移动端高精度声明**：

```hlsl
// 在需要高精度的移动端 Shader 顶部添加
#pragma target 2.0          // 移动端最低目标

// 全局精度控制（Fragment Shader 顶部）
#ifdef SHADER_API_MOBILE
    #pragma fragmentoption ARB_precision_hint_fastest
#endif
```

### 大世界坐标精度问题

在大世界场景（World Space 坐标 > 10000）中，`float` 精度不足导致顶点抖动（Vertex Jitter）。解决方案是使用 **Camera-Relative Rendering**：

```hlsl
// URP 2022+ 已内置 Camera-Relative Rendering
// Shader 中的 positionWS 实际上是相对摄像机的偏移，而非绝对世界坐标
// 使用 GetAbsolutePositionWS 获取真实世界坐标（需要 _WorldSpaceCameraPos）
float3 absoluteWS = GetAbsolutePositionWS(IN.positionWS);
```

## 陷阱五：深度缓冲相关

### Z-Fighting（深度冲突）

两个平行的几何面（如贴花、地面标记）距离过近时，深度值抖动导致交替显示。

```hlsl
// 解决方案 1：使用 Offset 命令让面稍微偏向相机
SubShader
{
    Offset -1, -1  // 单位和因子偏移，减小深度值（移向相机）
    Pass { ... }
}

// 解决方案 2：贴花使用 ZWrite Off + ZTest LEqual
ZWrite Off
ZTest LEqual
```

### 深度测试模式选择

```hlsl
// 常用深度设置组合

// 不透明物体（默认）
ZWrite On
ZTest LEqual

// 透明物体（半透明）
ZWrite Off
ZTest LEqual
Blend SrcAlpha OneMinusSrcAlpha

// 贴花（Decal）
ZWrite Off
ZTest LEqual
Offset -1, -1

// UI/全屏后处理 Pass
ZWrite Off
ZTest Always
Cull Off
```

### `UNITY_REVERSED_Z` 的正确使用

```hlsl
// 手动重建世界坐标时（如 SSAO、屏幕空间反射）
float rawDepth = SAMPLE_TEXTURE2D_X(_CameraDepthTexture, sampler_CameraDepthTexture, uv).r;

// 方法一：使用 URP 提供的辅助函数（推荐）
float3 worldPos = ComputeWorldSpacePosition(uv, rawDepth, UNITY_MATRIX_I_VP);

// 方法二：手动处理（需要考虑 Reversed-Z）
#if defined(UNITY_REVERSED_Z)
    rawDepth = 1.0 - rawDepth;
#endif
float4 clipPos = float4(uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
float4 worldPos4 = mul(UNITY_MATRIX_I_VP, clipPos);
float3 worldPos = worldPos4.xyz / worldPos4.w;
```

## 陷阱六：透明渲染顺序问题

### 渲染队列（Queue）

Unity 按 Queue 值排序渲染，同一 Queue 内的透明物体按**从远到近**排序（CPU 排序，非 Per-pixel）。

```hlsl
// 常用 Queue 设置
Tags { "Queue" = "Background" }    // 1000，天空盒等
Tags { "Queue" = "Geometry" }      // 2000，不透明物体
Tags { "Queue" = "AlphaTest" }     // 2450，Alpha Test（Cutout）
Tags { "Queue" = "Transparent" }   // 3000，半透明物体
Tags { "Queue" = "Overlay" }       // 4000，UI、光效叠加

// 调整偏移（Decal 在地面不透明物体之后，半透明之前）
Tags { "Queue" = "Geometry+10" }
```

### Alpha Test vs Alpha Blend

```hlsl
// Alpha Test（Cutout）：不透明，可以写深度，支持阴影
// 在 Properties 中暴露 Cutoff 参数
CBUFFER_START(UnityPerMaterial)
    float _AlphaCutoff;
CBUFFER_END

half4 frag(Varyings IN) : SV_Target
{
    half4 col = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);
    // clip 在 alpha < cutoff 时丢弃片元（不渲染该像素）
    clip(col.a - _AlphaCutoff);
    return col;
}

// Alpha Blend（半透明）：透明，不写深度，需要从后往前排序
// SubShader 设置：
// Blend SrcAlpha OneMinusSrcAlpha
// ZWrite Off
```

### 双面半透明问题

半透明材质双面渲染需要**两个 Pass**（先渲背面，再渲正面），否则会出现自穿透问题：

```hlsl
SubShader
{
    Tags { "RenderType"="Transparent" "Queue"="Transparent" }

    // Pass 1：只渲染背面（Cull Front）
    Pass
    {
        Cull Front
        ZWrite Off
        Blend SrcAlpha OneMinusSrcAlpha
        // ... 相同的 HLSL 代码 ...
    }

    // Pass 2：只渲染正面（Cull Back，默认）
    Pass
    {
        Cull Back
        ZWrite Off
        Blend SrcAlpha OneMinusSrcAlpha
        // ... 相同的 HLSL 代码 ...
    }
}
```

## 陷阱七：SRP Batcher 兼容性

URP 的 SRP Batcher 可以大幅减少 DrawCall，但要求每个 Shader 的**每个 Pass 中 `CBUFFER_START(UnityPerMaterial)` 块包含所有 `_` 前缀的 Properties**。

**常见错误**：

```hlsl
// 错误：Properties 中声明了 _MyFloat，但 CBUFFER 中遗漏
Properties { _MainTex("Tex", 2D) = "white" {} _MyFloat("Float", Float) = 1.0 }

CBUFFER_START(UnityPerMaterial)
    float4 _MainTex_ST;
    // 遗漏了 _MyFloat！→ SRP Batcher 降级为非批次，DrawCall 增加
CBUFFER_END

// 正确
CBUFFER_START(UnityPerMaterial)
    float4 _MainTex_ST;
    float  _MyFloat; // 必须包含所有 Properties 中的变量
CBUFFER_END
```

检查 SRP Batcher 兼容性：选中 Shader 文件，Inspector 中查看 SRP Batcher 状态；或者在 Frame Debugger 中查看批次合并情况。

## 陷阱八：关键字与变体爆炸

大量 `#pragma multi_compile` 会导致 Shader 变体数量指数增长，增大包体大小和加载时间。

```hlsl
// 不当使用（每个 multi_compile 让变体数×2）
#pragma multi_compile _ FEATURE_A
#pragma multi_compile _ FEATURE_B
#pragma multi_compile _ FEATURE_C
// 结果：2³ = 8 个变体

// 推荐：用 shader_feature 代替（只编译项目实际用到的变体）
#pragma shader_feature _ FEATURE_A
#pragma shader_feature _ FEATURE_B
// shader_feature 未使用的变体不会被打包
```

## 调试工具

### Frame Debugger（帧调试器）

Window → Analysis → Frame Debugger，可以：

- 逐 DrawCall 检查每一步渲染结果
- 查看每个 Pass 的 Shader 变体、材质属性、渲染状态（ZWrite、Blend 等）
- 识别 SRP Batcher 批次合并失败的原因

### URP Rendering Debugger（URP 2022+）

Window → Analysis → Rendering Debugger（或运行时按 Ctrl+Backspace），可以：

- 单独查看 Albedo、法线、深度、Roughness、Metallic 等 G-Buffer
- 可视化 Shadow Map、Light Map、Reflection Probe
- 过度绘制（Overdraw）可视化——找到透明物体性能瓶颈

```csharp
// 代码切换调试模式（运行时调试用）
using UnityEngine.Rendering.Universal;
var debugger = DebugManager.instance;
debugger.enableRuntimeUI = true;
```

### RenderDoc 集成

对于需要深入分析的问题（着色器像素级调试、纹理格式验证），使用 RenderDoc：

1. 在 RenderDoc 中启动 Unity Editor（不是直接运行 Unity）
2. 或者在 Unity 中通过 Window → Analysis → RenderDoc 捕获帧
3. 在 RenderDoc 的 Texture Viewer 中验证 RT 格式是否符合预期
4. 在 Shader Viewer 中查看实际执行的 HLSL 反汇编

## 常见错误快速对照表

| 症状 | 可能原因 | 检查点 |
|------|---------|-------|
| 颜色偏亮约 2.2 倍 | 颜色空间混用 | 检查 sRGB Texture 标记、工作流设置 |
| 移动端法线贴图方向相反 | Y 轴翻转 | 法线贴图 Import → Flip Green Channel |
| 深度排序错乱 | Queue 设置或 ZWrite | 检查 Queue 值和 ZWrite Off/On |
| 大场景顶点抖动 | float 精度不足 | 启用 Camera-Relative Rendering |
| 某些平台纹理翻转 | UV 原点差异 | 使用 `UNITY_UV_STARTS_AT_TOP` 宏 |
| 阴影不显示 | 缺少 ShadowCaster Pass | 添加 `UsePass "Universal Render Pipeline/Lit/ShadowCaster"` |
| SRP Batcher 不生效 | CBUFFER 不完整 | 确保 `CBUFFER_START(UnityPerMaterial)` 包含所有 Properties |
| 透明物体互相穿插 | 渲染顺序问题 | 使用 `ZTest Always` 或分离 Pass |
| 移动端画面闪烁 | half 精度不足 | 位置/矩阵改用 float |
| 编译失败（无错误信息）| Shader 变体溢出 | 减少 multi_compile 数量 |

## 代码修复对比示例

### 修复：深度读取（Reversed-Z 问题）

```hlsl
// 错误：未考虑 Reversed-Z，在 DX11 上深度值全部接近 1（远处）
float depth = SAMPLE_TEXTURE2D(_CameraDepthTexture, sampler_CameraDepthTexture, uv).r;
float linearDepth = Linear01Depth(depth, _ZBufferParams);
// 在 Metal/DX11 上：linearDepth 在近处为 0，远处为 1（反了！）

// 正确：使用 URP 的 LinearEyeDepth 自动处理
float depth = SAMPLE_TEXTURE2D(_CameraDepthTexture, sampler_CameraDepthTexture, uv).r;
float eyeDepth = LinearEyeDepth(depth, _ZBufferParams); // 单位：米，从摄像机到片元的距离
```

### 修复：颜色空间（Linear 工作流中的程序颜色）

```hlsl
// 错误：直接使用美术给的 Gamma 空间颜色值做光照计算
float3 ambientColor = float3(0.5, 0.3, 0.1); // 这个值在 Gamma 空间！

// 正确：在 Linear 工作流中，程序颜色需要转换
// 方法 1：直接在 Inspector 中用 Color 属性（Unity 自动处理 sRGB 转换）
// 方法 2：手动 Gamma→Linear
float3 ambientColor = pow(float3(0.5, 0.3, 0.1), 2.2);

// 最佳实践：将颜色暴露为 Properties，让 Unity 的 Color Picker 自动处理
CBUFFER_START(UnityPerMaterial)
    half4 _AmbientColor; // 在 Inspector 中设置，自动正确的颜色空间
CBUFFER_END
```

系统掌握这些陷阱，能让你在面对平台差异问题时快速定位根因，而不是漫无目的地调参数。调试 Shader 的核心方法论永远是：**输出中间值为颜色，逐步缩小问题范围**——Frame Debugger 和 Rendering Debugger 是你最好的朋友。
