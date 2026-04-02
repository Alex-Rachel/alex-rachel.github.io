---
title: Unity Shader 系列（一）：URP 中的 2D SDF — 圆角 UI、血条与技能遮罩
date: 2026-04-01 09:00:00
tags: [HLSL, URP, SDF, UI Shader, Unity游戏开发]
categories:
  - Unity Shader 系列
  - SDF 技术
---

## 为什么在 Unity UI 中使用 SDF？

传统 Unity UI 使用图片切片（9-Slice Sprite）来绘制圆角矩形、进度条等元素。这种方案有明显局限：需要美术提供多种尺寸的图片资源，放大后边缘模糊，圆角半径固定无法运行时调整。

**2D SDF（有向距离场）Shader 彻底改变了这一局面**：
- 任意分辨率下边缘始终锐利（GPU 数学计算，与分辨率无关）
- 圆角半径、边框宽度、颜色全部通过 Inspector 实时调节
- 单张 Shader 就能实现圆角矩形、圆形进度条、技能 CD 扇形遮罩

**实际游戏应用场景：**
1. **《原神》风格 UI**：角色血条、护盾条，圆角矩形背景板
2. **MOBA 类游戏技能图标**：技能 CD 的扇形遮罩倒计时
3. **卡牌游戏**：卡牌边框高亮描边，鼠标悬停时圆角发光效果

## URP 2D Renderer 与 UI Canvas 集成

在 Unity 中使用自定义 SDF Shader 有两种主要方式：

**方式一：UI 材质（Canvas/CanvasRenderer）**
- 在 `Image` 组件上赋予自定义材质
- Shader Tags 需要设置为 `"Queue"="Transparent"` 和 `"RenderType"="Transparent"`
- 在 URP 2D Renderer 的 `Renderer Feature` 中正常工作

**方式二：Sprite Renderer**
- 适用于世界空间中的 2D 元素
- 配合 URP 的 `2D Renderer` 使用 `Sprites/Lit` 或自定义 Unlit Pass

本文以 UI 材质方案为主，这是游戏 HUD 的最常见需求。

## 核心 SDF 数学：HLSL 实现

HLSL 与 GLSL 的 SDF 数学本质相同，主要差异在 API 命名：
- `mix()` → `lerp()`
- `fract()` → `frac()`
- `vec2/vec3/vec4` → `float2/float3/float4`
- `mat2` → `float2x2`

### 圆角矩形 SDF

```hlsl
// 圆角矩形 SDF（HLSL 版本）
// p: 以矩形中心为原点的 UV 坐标
// halfSize: 矩形半尺寸
// radius: 圆角半径
float sdRoundBox(float2 p, float2 halfSize, float radius)
{
    // 折叠到第一象限，减去圆角半径后求角点距离
    float2 d = abs(p) - halfSize + radius;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
}
```

### 圆形 SDF

```hlsl
float sdCircle(float2 p, float radius)
{
    return length(p) - radius;
}
```

### 扇形 SDF（技能 CD 遮罩）

```hlsl
// 扇形 SDF，用于技能 CD 倒计时遮罩
// angle: 扇形角度（弧度），0 到 TAU
float sdPie(float2 p, float angle)
{
    // 将角度转为方向向量（sin/cos 对）
    float2 sc = float2(sin(angle * 0.5), cos(angle * 0.5));
    p.x = abs(p.x); // X 轴对称
    float l = length(p) - 1.0;
    // 用点积判断是否在扇形内部
    float m = length(p - sc * clamp(dot(p, sc), 0.0, 1.0));
    return max(l, m * sign(sc.y * p.x - sc.x * p.y));
}
```

## 完整 URP UI SDF Shader

这是一个可以直接挂在 Unity UI `Image` 组件上的完整 Shader：

```hlsl
Shader "Custom/URP/RoundedUIElement"
{
    Properties
    {
        // 主颜色（支持透明度）
        _Color ("Fill Color", Color) = (0.2, 0.6, 1.0, 1.0)
        // 边框颜色
        _BorderColor ("Border Color", Color) = (1.0, 1.0, 1.0, 1.0)
        // 边框宽度（UV 空间，0.0 = 无边框）
        _BorderWidth ("Border Width", Range(0.0, 0.1)) = 0.01
        // 圆角半径（UV 空间）
        _Radius ("Corner Radius", Range(0.0, 0.5)) = 0.1
        // 抗锯齿宽度（屏幕像素对应的 UV 大小，通常 0.002~0.005）
        _AAWidth ("AA Width", Range(0.001, 0.01)) = 0.003
        // 进度条填充量（0~1，用于血条/CD）
        _FillAmount ("Fill Amount", Range(0.0, 1.0)) = 1.0
        // 用于 UI 的主贴图（可选）
        [PerRendererData] _MainTex ("Main Texture", 2D) = "white" {}
    }

    SubShader
    {
        // UI 专用标签：透明度队列，不写入深度
        Tags
        {
            "Queue" = "Transparent"
            "RenderType" = "Transparent"
            "IgnoreProjector" = "True"
            "RenderPipeline" = "UniversalPipeline"
            "PreviewType" = "Plane"
            "CanUseSpriteAtlas" = "True"
        }

        Cull Off          // UI 通常需要双面渲染
        Lighting Off
        ZWrite Off        // UI 不写深度
        Blend SrcAlpha OneMinusSrcAlpha  // 标准透明混合

        Pass
        {
            Name "UIForward"

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // 启用 GPU Instancing（批量合并 UI drawcall）
            #pragma multi_compile_instancing

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            // 纹理和采样器声明（URP 标准写法）
            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            // 常量缓冲区（SRP Batcher 合并所必需）
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _Color;
                float4 _BorderColor;
                float  _BorderWidth;
                float  _Radius;
                float  _AAWidth;
                float  _FillAmount;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS   : POSITION;    // 对象空间顶点位置
                float2 uv           : TEXCOORD0;   // UV 坐标
                float4 color        : COLOR;        // 顶点颜色（UI tint）
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS  : SV_POSITION;  // 裁剪空间位置
                float2 uv           : TEXCOORD0;    // 纹理 UV
                float2 localUV      : TEXCOORD1;    // 以中心为原点的 UV [-0.5, 0.5]
                float4 color        : COLOR;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== SDF 工具函数 ========

            // 圆角矩形 SDF
            float sdRoundBox(float2 p, float2 halfSize, float radius)
            {
                float2 d = abs(p) - halfSize + radius;
                return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
            }

            // 基于 SDF 的抗锯齿遮罩（1 = 内部，0 = 外部）
            float sdfMask(float d, float aaWidth)
            {
                return saturate(-d / aaWidth + 0.5);
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                // URP 标准顶点变换：对象空间 → 裁剪空间
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = TRANSFORM_TEX(IN.uv, _MainTex);
                // 将 UV [0,1] 转换为以中心为原点的 [-0.5, 0.5]
                OUT.localUV = IN.uv - 0.5;
                OUT.color = IN.color;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // 采样主贴图（UI Image 组件传入的 Sprite）
                half4 texColor = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);

                // 计算圆角矩形 SDF
                // halfSize 留出边框宽度的空间
                float2 halfSize = float2(0.5, 0.5) - _BorderWidth;
                float d = sdRoundBox(IN.localUV, halfSize, _Radius);

                // 边框 SDF（稍微扩展的外轮廓）
                float dBorder = sdRoundBox(IN.localUV, float2(0.5, 0.5), _Radius);

                // 进度条裁剪（水平方向，从左到右）
                // 把 UV.x 从 [-0.5, 0.5] 重映射到 [0, 1] 后比较
                float progressClip = step(IN.localUV.x + 0.5, _FillAmount);
                // 垂直方向进度条：改用 IN.localUV.y

                // 计算遮罩（SDF 抗锯齿）
                float fillMask   = sdfMask(d, _AAWidth);
                float borderMask = sdfMask(dBorder, _AAWidth) * (1.0 - sdfMask(d + _BorderWidth * 0.5, _AAWidth));

                // 混合填充颜色与贴图
                half4 fillColor = _Color * texColor * IN.color;
                fillColor.a *= fillMask * progressClip;

                // 边框叠加（在填充层之上）
                half4 borderFinal = _BorderColor;
                borderFinal.a *= borderMask;

                // Alpha 混合：先填充，再叠加边框
                half4 result;
                result.rgb = lerp(fillColor.rgb, borderFinal.rgb, borderFinal.a);
                result.a = saturate(fillColor.a + borderFinal.a);

                return result;
            }
            ENDHLSL
        }
    }

    // 降级：无 URP 时使用 Sprites/Default
    FallBack "Sprites/Default"
}
```

## ShaderGraph 等价实现

如果你的团队使用 ShaderGraph，同样效果的节点连接思路如下：

1. **UV 准备**：`UV` 节点 → `Subtract(0.5)` → 得到以中心为原点的坐标
2. **SDF 计算**：使用 `Rounded Rectangle` 节点（内置，位于 `Procedural/Shape` 分类）
   - 输入：`UV`、`Width`、`Height`、`Radius`
   - 输出：边缘遮罩（0/1）
3. **进度裁剪**：`Split` 取 X 通道 → `Comparison(Less)` 与 `Fill Amount` 比较
4. **边框**：用两个 `Rounded Rectangle`（大、小）相减得到边框遮罩
5. **颜色混合**：`Lerp` 节点，用边框遮罩混合填充色和边框色
6. **输出**：连接到 `Unlit Master`（UI 不需要光照）的 `Color` 和 `Alpha`

注意：ShaderGraph 的 `Rounded Rectangle` 输出值与 SDF 不完全一致，如果需要精确的 SDF 距离值（用于动态效果），建议用 `Custom Function` 节点包裹上面的 HLSL 代码。

## 性能考量

| 平台 | 建议 |
|------|------|
| 移动端（OpenGL ES 3.0） | 去掉边框层（减少一次 SDF 计算），使用 `half` 精度 |
| PC（DX11） | 完整功能，可增加外发光（Outer Glow：SDF 负值区域的渐变） |
| 主机 | 同 PC，可增加 MSAA 配合 SDF 的超分辨率抗锯齿 |

**移动端优化要点：**
- 将 `float` 替换为 `half`：`half4 fillColor`、`half d` 等
- 减少 `smoothstep` 调用数量（每个 SDF 层一次即可）
- 使用 `#pragma shader_feature` 关闭不需要的功能变体（边框、进度）

## 与 URP 渲染流程集成

这个 UI Shader 工作在 **URP 的 Transparent Pass** 中：
- Canvas 使用 `Screen Space - Overlay` 模式时，UI 在所有 3D 场景之后渲染
- Canvas 使用 `World Space` 模式时，按深度排序与 3D 物体混合
- **不需要** URP Light 系统（UI 通常是 Unlit 的）

如果需要 UI 元素与 3D 光照交互（如世界空间血条跟随角色），改用 `World Space Canvas` + 在 Shader 中添加 `GetMainLight()` 光照计算。

## 常见踩坑

1. **SRP Batcher 报错**：Shader 中的 Property 必须全部放入 `CBUFFER_START(UnityPerMaterial)...CBUFFER_END`，否则会报 "not compatible with SRP Batcher" 并严重影响 UI 批次合并

2. **HLSL 中没有 `fract()`**：用 `frac()` 代替；没有 `mix()`：用 `lerp()` 代替

3. **UI Image 的 UV 方向**：Unity UI 的 UV 原点在左下角，这与 URP 的 NDC 坐标（Z 轴 [0,1]）不同，但与 OpenGL UV 约定相同，不需要翻转

4. **`_MainTex_ST` 必须声明**：即使不使用 Tiling/Offset，也必须在 CBUFFER 中声明 `float4 _MainTex_ST`，并在顶点着色器中调用 `TRANSFORM_TEX`，否则材质球预览会出错

5. **Canvas Scaler 影响 SDF 比例**：当 Canvas 的 `Reference Resolution` 与实际分辨率不同时，`_AAWidth` 参数需要相应调整，建议通过脚本动态传入 `1.0 / Screen.height` 的派生值

## 扩展：外发光效果

在上面 Shader 基础上，利用 SDF 的负值区域可以轻松实现外发光：

```hlsl
// 在 frag 着色器中添加外发光层
// SDF 在形状外部为正值，用于计算发光强度
float glowDist = sdRoundBox(IN.localUV, float2(0.5, 0.5), _Radius);
float glowIntensity = exp(-glowDist * _GlowFalloff) * (1.0 - sdfMask(glowDist, _AAWidth));
half4 glowColor = _GlowColor;
glowColor.a *= glowIntensity * _GlowStrength;

// 将发光层与最终结果混合
result.rgb += glowColor.rgb * glowColor.a;
result.a = saturate(result.a + glowColor.a);
```

掌握了 SDF UI Shader 的基础之后，下一篇文章将介绍程序化噪声在 Unity URP 特效中的应用——FBM 驱动的火焰、烟雾和程序化材质。
