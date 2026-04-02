---
title: Unity Shader 系列（三十三）：UV 动画与极坐标特效——技能指示器与魔法阵
date: 2026-04-01 14:20:00
tags: [HLSL, URP, 极坐标, UV动画, 技能特效]
categories:
  - Unity Shader 系列
  - 坐标与变换
---

## UV 动画是技能特效的基础

在 Unity 游戏开发中，技能特效、HUD 图标、魔法阵、传送门等视觉效果大量依赖 **UV 动画**——通过在每帧修改纹理坐标而非移动几何体来实现运动感。配合极坐标变换，几乎所有旋转对称的特效都可以用极简的代码实现。

本篇覆盖四个核心主题：UV Scrolling/Rotation 标准实现、极坐标变换原理、Unity 中的 ShaderGraph Polar Coordinates 节点，以及两个完整特效 Shader。

## UV Scrolling 与 UV Rotation

### UV 滚动（Scrolling）

最常见的 UV 动画：让纹理沿某个方向持续移动。适合瀑布、传送带、流动能量等效果。

```hlsl
// 在 Fragment Shader 中
float2 ScrollUV(float2 uv, float2 speed)
{
    // _Time.y = 游戏运行秒数（对应 ShaderToy 的 iTime）
    return uv + speed * _Time.y;
}

// 用法示例
float2 uv = IN.uv;
uv = ScrollUV(uv, float2(0.1, 0.05)); // X方向 0.1 UV/秒，Y 方向 0.05 UV/秒
half4 col = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);
```

### UV 旋转（Rotation）

让纹理绕某个中心点旋转。技能准备动画、旋转符文常用此效果。

```hlsl
// 绕 pivot 点旋转 UV，angle 单位：弧度
float2 RotateUV(float2 uv, float2 pivot, float angle)
{
    float s = sin(angle);
    float c = cos(angle);
    // 平移到原点
    uv -= pivot;
    // 旋转矩阵
    uv = float2(uv.x * c - uv.y * s,
                uv.x * s + uv.y * c);
    // 平移回去
    uv += pivot;
    return uv;
}

// 用法示例：绕中心持续旋转
float2 uv = RotateUV(IN.uv, float2(0.5, 0.5), _Time.y * _RotateSpeed);
```

### 多层 UV 叠加

将两层纹理以不同速度叠加，产生复杂的流动感：

```hlsl
float2 uv1 = IN.uv + float2(_Time.y * 0.05, _Time.y * 0.03);
float2 uv2 = RotateUV(IN.uv, float2(0.5, 0.5), _Time.y * 0.5);
half4 layer1 = SAMPLE_TEXTURE2D(_MainTex,   sampler_MainTex,   uv1);
half4 layer2 = SAMPLE_TEXTURE2D(_NoiseTex,  sampler_NoiseTex,  uv2);
// 加法混合：两层叠加
half4 result = saturate(layer1 + layer2 * _NoiseStrength);
```

## 极坐标变换原理

极坐标将 2D 平面上的点从 `(x, y)` 表示为 `(r, θ)`：
- `r = length(p)` — 到中心的距离
- `θ = atan2(y, x)` — 角度，范围 `[-π, π]`

HLSL 实现：

```hlsl
static const float PI  = 3.14159265;
static const float TAU = 6.28318530;

// 笛卡尔 → 极坐标（输出 x=角度[0,1]归一化, y=半径）
float2 ToPolar(float2 p)
{
    float r = length(p);
    float theta = atan2(p.y, p.x) / TAU + 0.5; // 归一化到 [0, 1]
    return float2(theta, r);
}

// 极坐标 → 笛卡尔
float2 FromPolar(float2 polar)
{
    float angle = polar.x * TAU;
    return float2(cos(angle), sin(angle)) * polar.y;
}
```

### 旋涡变换（Swirl）

在极坐标中将角度加上与半径相关的偏移，产生旋涡感：

```hlsl
float2 SwirlUV(float2 uv, float strength, float speed)
{
    // UV 以中心为原点
    float2 p = uv - 0.5;
    float r = length(p);
    float theta = atan2(p.y, p.x);
    // 旋涡：角度偏移量与半径成正比，并随时间旋转
    theta += strength * r + speed * _Time.y;
    // 重建笛卡尔坐标
    return float2(cos(theta), sin(theta)) * r + 0.5;
}
```

### 极坐标扇形遮罩

在极坐标中制作扇形，用于技能范围指示器的扇形显示：

```hlsl
// 返回 [0,1]：1 = 在扇形内，0 = 在扇形外
// sectorAngle: 扇形角度（弧度），fillPercent: 填充进度 [0,1]
float SectorMask(float2 uv, float sectorAngle, float fillPercent, float rotation)
{
    float2 p = uv - 0.5;
    float r = length(p);

    // 半径限制：只在圆环范围内
    float inRing = step(0.3, r) * step(r, 0.5);

    // 角度计算（以 Y 轴正方向为 0 度，顺时针为正）
    float angle = atan2(p.x, p.y); // 注意：x,y 顺序决定 0 度方向
    angle = frac(angle / TAU + rotation + 0.5); // 归一化到 [0, 1]

    // 扇形填充
    float halfSector = sectorAngle / TAU * 0.5;
    float inSector = step(angle, fillPercent * sectorAngle / TAU);

    return inRing * inSector;
}
```

## 实战示例一：旋转技能范围指示器

这是 MOBA/RPG 游戏中常见的地面投影技能范围 Shader，带发光边缘和方向指示扇形。

```hlsl
Shader "Custom/URP/SkillRangeIndicator"
{
    Properties
    {
        _MainColor      ("Fill Color",          Color)    = (0.2, 0.8, 1.0, 0.3)
        _EdgeColor      ("Edge Glow Color",     Color)    = (0.4, 1.0, 1.0, 1.0)
        _SectorColor    ("Sector Color",        Color)    = (1.0, 0.5, 0.1, 0.8)
        _InnerRadius    ("Inner Radius",        Range(0, 0.5)) = 0.1
        _OuterRadius    ("Outer Radius",        Range(0, 0.5)) = 0.45
        _EdgeWidth      ("Edge Glow Width",     Range(0.001, 0.1)) = 0.02
        _SectorAngle    ("Sector Angle (deg)",  Range(0, 360)) = 60
        _FillPercent    ("Fill Percent",        Range(0, 1)) = 1.0
        _RotateSpeed    ("Rotation Speed",      Float) = 0.5
        _GridTex        ("Grid/Pattern Tex",    2D)    = "white" {}
        _GridScrollSpeed("Grid Scroll Speed",   Float) = 0.1
    }
    SubShader
    {
        Tags
        {
            "RenderType"     = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue"          = "Transparent"
        }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Cull Off // 双面渲染（地面贴片两面都可见）

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
            };

            TEXTURE2D(_GridTex); SAMPLER(sampler_GridTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainColor;
                float4 _EdgeColor;
                float4 _SectorColor;
                float  _InnerRadius;
                float  _OuterRadius;
                float  _EdgeWidth;
                float  _SectorAngle;
                float  _FillPercent;
                float  _RotateSpeed;
                float  _GridScrollSpeed;
            CBUFFER_END

            static const float PI  = 3.14159265;
            static const float TAU = 6.28318530;

            // UV 旋转辅助
            float2 RotateUV(float2 uv, float2 pivot, float angle)
            {
                float s = sin(angle), c = cos(angle);
                uv -= pivot;
                uv = float2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
                return uv + pivot;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = IN.uv;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.uv;
                float2 p  = uv - 0.5; // 以中心为原点
                float  r  = length(p);
                float  t  = _Time.y;

                // ===== 圆环基础形状 =====
                float inCircle = step(_InnerRadius, r) * step(r, _OuterRadius);
                // 边缘发光（外圈和内圈各一条光边）
                float outerEdge = 1.0 - smoothstep(_OuterRadius - _EdgeWidth, _OuterRadius, r);
                float innerEdge = smoothstep(_InnerRadius, _InnerRadius + _EdgeWidth, r);
                float edgeMask  = (1.0 - innerEdge) + (1.0 - outerEdge * step(r, _OuterRadius));
                edgeMask = saturate(edgeMask * inCircle);

                // ===== 扇形遮罩 =====
                float sectorAngleRad = _SectorAngle * PI / 180.0;
                float angle = atan2(p.x, p.y); // Y 轴向上为 0 度
                angle = frac(angle / TAU + 0.5); // 归一化 [0,1]
                float sectorNorm = sectorAngleRad / TAU;
                float inSector   = step(angle, _FillPercent * sectorNorm) * inCircle;

                // ===== 网格纹理（旋转滚动）=====
                float2 gridUV = RotateUV(uv, float2(0.5, 0.5), t * _RotateSpeed);
                // 向外滚动效果
                float2 polarUV = float2(atan2(p.y, p.x) / TAU + 0.5, r);
                polarUV.y += t * _GridScrollSpeed; // 极坐标中的径向滚动
                half4 grid = SAMPLE_TEXTURE2D(_GridTex, sampler_GridTex, polarUV);

                // ===== 合成输出 =====
                // 底层：半透明圆环填充
                half4 col = _MainColor;
                col.rgb += grid.rgb * 0.2; // 叠加网格纹理增加细节

                // 扇形指向区域：使用扇形颜色
                col = lerp(col, _SectorColor, inSector * (1.0 - edgeMask));

                // 发光边缘叠加
                col.rgb = lerp(col.rgb, _EdgeColor.rgb, edgeMask);
                col.a   = saturate(col.a + edgeMask * _EdgeColor.a);

                // 遮罩：只在圆环范围内显示
                col.a *= inCircle;

                // 呼吸动画：边缘亮度随时间脉动
                float breathe = 0.8 + 0.2 * sin(t * 3.0);
                col.rgb *= breathe;

                return col;
            }
            ENDHLSL
        }
    }
}
```

## 实战示例二：魔法阵 Shader

多层旋转 UV + 噪声扰动 + 加法混合，实现地面魔法阵效果。

```hlsl
Shader "Custom/URP/MagicCircle"
{
    Properties
    {
        _OuterRing      ("Outer Ring Tex",      2D)    = "white" {}
        _MiddleRing     ("Middle Ring Tex",     2D)    = "white" {}
        _InnerSymbol    ("Inner Symbol Tex",    2D)    = "white" {}
        _NoiseTex       ("Noise Distortion",    2D)    = "gray"  {}
        _Color1         ("Color 1 (Outer)",     Color) = (0.3, 0.6, 1.0, 1.0)
        _Color2         ("Color 2 (Middle)",    Color) = (0.8, 0.3, 1.0, 1.0)
        _Color3         ("Color 3 (Inner)",     Color) = (1.0, 1.0, 0.5, 1.0)
        _RotateSpeed1   ("Outer Rotate Speed",  Float) = 0.2
        _RotateSpeed2   ("Middle Rotate Speed", Float) = -0.5
        _RotateSpeed3   ("Inner Rotate Speed",  Float) = 1.0
        _NoiseStrength  ("Noise Distortion",    Range(0, 0.1)) = 0.02
        _GlowPower      ("Glow Intensity",      Range(0, 5)) = 2.0
        _FadeRadius     ("Fade at Edge",        Range(0.1, 0.5)) = 0.45
    }
    SubShader
    {
        Tags
        {
            "RenderType"     = "Transparent"
            "RenderPipeline" = "UniversalPipeline"
            "Queue"          = "Transparent+10"
        }
        Blend One One   // 加法混合：魔法阵叠加在地面上发光
        ZWrite Off
        Cull Off

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float2 uv : TEXCOORD0; };

            TEXTURE2D(_OuterRing);   SAMPLER(sampler_OuterRing);
            TEXTURE2D(_MiddleRing);  SAMPLER(sampler_MiddleRing);
            TEXTURE2D(_InnerSymbol); SAMPLER(sampler_InnerSymbol);
            TEXTURE2D(_NoiseTex);    SAMPLER(sampler_NoiseTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _Color1, _Color2, _Color3;
                float  _RotateSpeed1, _RotateSpeed2, _RotateSpeed3;
                float  _NoiseStrength;
                float  _GlowPower;
                float  _FadeRadius;
            CBUFFER_END

            static const float TAU = 6.28318530;

            float2 RotateAroundCenter(float2 uv, float angle)
            {
                float s = sin(angle), c = cos(angle);
                float2 p = uv - 0.5;
                p = float2(p.x * c - p.y * s, p.x * s + p.y * c);
                return p + 0.5;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = IN.uv;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.uv;
                float  t  = _Time.y;
                float  r  = length(uv - 0.5);

                // ===== 噪声扰动 UV =====
                // 使用极坐标 UV 采样噪声，产生有机流动感
                float2 p = uv - 0.5;
                float2 polarUV = float2(atan2(p.y, p.x) / TAU + 0.5, r);
                half2 noise = SAMPLE_TEXTURE2D(_NoiseTex, sampler_NoiseTex, polarUV + t * 0.05).rg;
                float2 distortedUV = uv + (noise * 2.0 - 1.0) * _NoiseStrength;

                // ===== 三层旋转环 =====
                float2 uv1 = RotateAroundCenter(distortedUV, t * _RotateSpeed1 * TAU);
                float2 uv2 = RotateAroundCenter(distortedUV, t * _RotateSpeed2 * TAU);
                float2 uv3 = RotateAroundCenter(distortedUV, t * _RotateSpeed3 * TAU);

                half4 outer  = SAMPLE_TEXTURE2D(_OuterRing,   sampler_OuterRing,   uv1);
                half4 middle = SAMPLE_TEXTURE2D(_MiddleRing,  sampler_MiddleRing,  uv2);
                half4 inner  = SAMPLE_TEXTURE2D(_InnerSymbol, sampler_InnerSymbol, uv3);

                // ===== 颜色化 =====
                half3 c1 = outer.r  * _Color1.rgb * outer.a;
                half3 c2 = middle.r * _Color2.rgb * middle.a;
                half3 c3 = inner.r  * _Color3.rgb * inner.a;

                // 加法混合三层
                half3 finalColor = c1 + c2 + c3;

                // ===== 全局发光强度 =====
                finalColor *= _GlowPower;

                // ===== 边缘衰减（圆形遮罩）=====
                float edgeFade = 1.0 - smoothstep(_FadeRadius * 0.8, _FadeRadius, r);
                float alpha = edgeFade;

                // ===== 呼吸脉冲 =====
                float pulse = 0.85 + 0.15 * sin(t * 2.5);
                finalColor *= pulse;

                return half4(finalColor, alpha);
            }
            ENDHLSL
        }
    }
}
```

## ShaderGraph 中的极坐标节点

Unity ShaderGraph 内置了 **Polar Coordinates** 节点：

1. 从 ShaderGraph 节点搜索中添加 `Polar Coordinates`
2. **输入**：
   - `UV`：原始 UV（通常来自 UV 节点）
   - `Center`：旋转中心（默认 (0.5, 0.5)）
   - `Radial Scale`：径向缩放
   - `Length Scale`：角度方向缩放
3. **输出**：极坐标 UV（X = 角度归一化，Y = 半径）

典型连接方式（旋转纹理）：

```
UV → Polar Coordinates → Add(Time * Speed) → Sample Texture 2D
```

ShaderGraph 中实现技能指示器扇形：

1. `UV → Subtract(0.5)` 得到中心化 UV
2. `Polar Coordinates` 输出极坐标
3. `Step(FillPercent, polar.x)` 生成扇形遮罩
4. 结合 `Length` 节点的圆形遮罩做 `Multiply` 得到圆环扇形

## UV 动画性能考量

- **`_Time.y` 精度**：Unity 的 `_Time.y` 在长时间运行后可能产生浮点精度问题（约运行 10 小时后开始出现闪烁）。对于需要极高精度的 UV 动画，使用 `frac(_Time.y * speed)` 将值限制在 [0,1] 范围内
- **三角函数成本**：`sin`/`cos` 在移动端 GPU 比较昂贵。技巧：`RotateUV` 每帧只计算一次旋转矩阵，不要在循环内反复调用
- **多层叠加**：魔法阵的三层旋转纹理在 mid-range 移动设备上通常没有问题，但超过 5 层需要考虑合并
- **LOD 与距离淡出**：技能指示器在远距离应该淡出，可以通过相机距离驱动 `_FadeRadius` 参数实现
- **抗锯齿**：扇形边缘的 `step` 函数会产生硬锯齿。改用 `smoothstep` 加 2-3 像素宽度过渡，或在 MSAA 开启时效果自然平滑

UV 动画和极坐标变换是游戏特效中性价比最高的技术：代码量极少，视觉冲击力强，CPU 消耗为零，是每个 Unity 特效 Shader 工程师必须熟练掌握的基础技能。
