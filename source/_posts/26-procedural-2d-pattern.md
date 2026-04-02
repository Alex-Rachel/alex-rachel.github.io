---
title: Unity Shader 系列（二十六）：Unity 程序化纹理与材质生成
date: 2026-04-27 12:00:00
tags: [HLSL, URP, 程序化纹理, UI Shader, 六边形网格]
---

程序化纹理在游戏开发中有极高的价值——不依赖美术资产、支持无限分辨率、可动态变化、内存占用极低。本文聚焦 Unity URP 中的实用程序化纹理技术，包括避免纹理重复的随机采样、UI Shader 中的程序化图案，以及策略游戏中六边形网格 Shader 的完整实现。

## 避免纹理重复：随机采样（Stochastic Sampling）

大面积地形或地面材质最常见的问题是明显的纹理重复（Tiling）。Stochastic Sampling 通过将纹理坐标加上哈希偏移，使相邻格子的纹理采样有随机旋转/偏移，从视觉上消除重复感。

```hlsl
Shader "Custom/URP/StochasticSampling"
{
    Properties
    {
        _MainTex ("主纹理", 2D) = "white" {}
        _TilingScale ("平铺密度", Float) = 4.0
        _BlendSharpness ("混合锐度", Range(0, 10)) = 2.0
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float _TilingScale;
                float _BlendSharpness;
            CBUFFER_END

            struct Attributes { float4 posOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; };
            struct Varyings { float4 posCS : SV_POSITION; float2 uv : TEXCOORD0; float3 normalWS : TEXCOORD1; float3 posWS : TEXCOORD2; };

            // 高质量 2D 哈希函数
            float2 Hash2D(float2 p)
            {
                p = float2(dot(p, float2(127.1, 311.7)), dot(p, float2(269.5, 183.3)));
                return frac(sin(p) * 43758.5453);
            }

            // Stochastic 采样：消除纹理平铺重复
            // 原理：将 UV 空间划分为随机旋转的六边形格，每格独立采样并混合
            half4 SampleStochastic(TEXTURE2D_PARAM(tex, sampler_tex), float2 uv)
            {
                // 将 UV 转换为三角网格坐标
                // 使用倾斜坐标系（Skewed Coordinates）实现三角形格
                float2 skewUV = uv * float2(1.0, 0.5773503) + float2(0.0, 0.5);
                float2 baseCell = floor(skewUV);

                // 获取三角形格子中的重心坐标（确定在哪个三角形内）
                float2 frac_uv = frac(skewUV);
                float2 vertex1, vertex2, vertex3;
                if (frac_uv.x + frac_uv.y < 1.0)
                {
                    vertex1 = baseCell;
                    vertex2 = baseCell + float2(1, 0);
                    vertex3 = baseCell + float2(0, 1);
                }
                else
                {
                    vertex1 = baseCell + float2(1, 1);
                    vertex2 = baseCell + float2(1, 0);
                    vertex3 = baseCell + float2(0, 1);
                }

                // 每个顶点的随机偏移和旋转
                float2 r1 = Hash2D(vertex1);
                float2 r2 = Hash2D(vertex2);
                float2 r3 = Hash2D(vertex3);

                // 旋转各格子的 UV
                float rot1 = r1.x * 6.28318;
                float rot2 = r2.x * 6.28318;
                float rot3 = r3.x * 6.28318;

                // 各顶点处的 UV（含旋转 + 偏移）
                float2 uv1 = uv + r1 * 0.5; // 简化版：仅偏移
                float2 uv2 = uv + r2 * 0.5;
                float2 uv3 = uv + r3 * 0.5;

                // 三角形内的权重（基于到各顶点的距离）
                float3 weights;
                weights.x = frac_uv.x + frac_uv.y < 1.0 ? 1.0 - frac_uv.x - frac_uv.y : frac_uv.x + frac_uv.y - 1.0;
                weights.y = frac_uv.x;
                weights.z = frac_uv.y;

                // 提高混合锐度（减少模糊感）
                weights = pow(max(weights, 0.001), _BlendSharpness);
                weights /= (weights.x + weights.y + weights.z);

                // 加权混合三个采样
                half4 s1 = SAMPLE_TEXTURE2D(tex, sampler_tex, uv1);
                half4 s2 = SAMPLE_TEXTURE2D(tex, sampler_tex, uv2);
                half4 s3 = SAMPLE_TEXTURE2D(tex, sampler_tex, uv3);

                return s1 * weights.x + s2 * weights.y + s3 * weights.z;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.posCS = TransformObjectToHClip(IN.posOS.xyz);
                OUT.uv = IN.uv * _TilingScale;
                OUT.normalWS = TransformObjectToWorldNormal(IN.normalOS);
                OUT.posWS = TransformObjectToWorld(IN.posOS.xyz);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // 使用 Stochastic 采样代替普通 SAMPLE_TEXTURE2D
                half4 col = SampleStochastic(TEXTURE2D_ARGS(_MainTex, sampler_MainTex), IN.uv);

                // 简单光照
                Light mainLight = GetMainLight();
                float NdotL = saturate(dot(normalize(IN.normalWS), mainLight.direction));
                col.rgb *= NdotL * 0.7 + 0.3;

                return col;
            }
            ENDHLSL
        }
    }
}
```

## 程序化图案作为遮罩：镂空与发光边缘

将程序化图案的 SDF 值用作材质属性的遮罩，可以实现镂空效果和发光边缘：

```hlsl
// 在 Fragment Shader 中
// 圆形网格 SDF 用于镂空
float CircleGridSDF(float2 uv, float scale, float radius)
{
    float2 cell_uv = frac(uv * scale) - 0.5;
    return length(cell_uv) - radius;
}

// 六边形 SDF
float HexagonSDF(float2 p)
{
    p = abs(p);
    return max(dot(p, float2(0.5, 0.866025)), p.x);
}

// 使用 SDF 生成发光边缘
float sdf = HexagonSDF(cellUV) - 0.45; // 六边形边界
float edge = abs(sdf);                  // 边界距离
float glow = 1.0 / (edge * 20.0 + 0.1); // 辉光（类似 1/(d²+ε)）
glow = saturate(glow * 0.3);

// 镂空（裁掉 SDF > 0 的区域）
clip(-sdf - 0.01); // 仅保留六边形内部
```

## 六边形策略地图 Shader：完整实现

策略游戏（如文明系列、火焰纹章）大量使用六边形地图。以下是完整的 URP 六边形地图 Shader，支持悬停高亮、单元格 ID 着色、边界线：

```hlsl
Shader "Custom/URP/HexagonMap"
{
    Properties
    {
        // 六边形参数
        _HexScale ("六边形缩放", Float) = 5.0
        _BorderWidth ("边界线宽度", Range(0, 0.1)) = 0.03
        _BorderColor ("边界线颜色", Color) = (0.2, 0.2, 0.2, 1.0)

        // 悬停效果
        _HoveredCellID ("悬停格 ID（XY）", Vector) = (-1, -1, 0, 0)
        _HoverColor ("悬停颜色", Color) = (1.0, 0.8, 0.2, 0.5)
        _HoverPulseSpeed ("高亮脉冲速度", Float) = 2.0

        // 地图数据纹理（R=地形类型, G=单位标记, B=选中状态）
        _MapDataTex ("地图数据纹理", 2D) = "black" {}

        // 地形颜色
        _GrassColor ("草原色", Color) = (0.3, 0.6, 0.2, 1)
        _DesertColor ("沙漠色", Color) = (0.8, 0.7, 0.3, 1)
        _WaterColor ("水域色", Color) = (0.1, 0.3, 0.7, 1)
        _MountainColor ("山脉色", Color) = (0.5, 0.4, 0.35, 1)
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_MapDataTex); SAMPLER(sampler_MapDataTex);

            CBUFFER_START(UnityPerMaterial)
                float _HexScale;
                float _BorderWidth;
                float4 _BorderColor;
                float4 _HoveredCellID;
                float4 _HoverColor;
                float _HoverPulseSpeed;
                float4 _GrassColor, _DesertColor, _WaterColor, _MountainColor;
            CBUFFER_END

            struct Attributes { float4 posOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings { float4 posCS : SV_POSITION; float2 uv : TEXCOORD0; };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.posCS = TransformObjectToHClip(IN.posOS.xyz);
                OUT.uv = IN.uv;
                return OUT;
            }

            // 六边形网格核心函数
            // 返回：xy = 格子内局部坐标（[-0.5, 0.5]），zw = 格子 ID（整数坐标）
            float4 HexGrid(float2 p)
            {
                // 使用轴坐标系（Axial Coordinates）计算六边形格子
                // 尖顶朝上的六边形
                float2 q = float2(p.x * 1.1547005, p.y + p.x * 0.5773503); // 转换到倾斜坐标
                float2 pi = floor(q);
                float2 pf = frac(q);

                float v = fmod(pi.x + pi.y, 3.0); // 确定三角形类型

                float ca = step(1.0, v);
                float cb = step(2.0, v);

                // 候选格子中心
                float2 ma = step(pf.xy, pf.yx);

                // 选择最近的六边形中心
                float2 cellID;
                float2 localPos;

                if (ca < 0.5)
                {
                    cellID = pi + float2(1.0 - ma.x, 1.0 - ma.y);
                    localPos = pf - float2(1.0 - ma.x, 1.0 - ma.y);
                }
                else if (cb < 0.5)
                {
                    cellID = pi + float2(ma.x, 1.0 - ma.y);
                    localPos = pf - float2(ma.x, 1.0 - ma.y);
                }
                else
                {
                    cellID = pi + float2(1.0 - ma.x, ma.y);
                    localPos = pf - float2(1.0 - ma.x, ma.y);
                }

                return float4(localPos, cellID);
            }

            // 六边形 SDF（正六边形）
            float HexSDF(float2 p)
            {
                p = abs(p);
                return max(dot(p, float2(0.866025, 0.5)), p.y);
            }

            // 简单哈希（格子 ID → 颜色）
            float Hash21(float2 p)
            {
                return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = (IN.uv * 2.0 - 1.0) * _HexScale;

                // 获取六边形格子信息
                float4 hexInfo = HexGrid(uv);
                float2 localPos = hexInfo.xy;
                float2 cellID = hexInfo.zw;

                // 六边形 SDF（用于边界线）
                float hexDist = HexSDF(localPos);
                float border = smoothstep(0.5 - _BorderWidth, 0.5, hexDist);

                // 从地图数据纹理读取格子类型
                // 将 cellID 映射到纹理 UV
                float2 mapUV = (cellID + float2(_HexScale, _HexScale)) / (float2(_HexScale, _HexScale) * 2.0);
                float4 mapData = SAMPLE_TEXTURE2D(_MapDataTex, sampler_MapDataTex, mapUV);
                float terrainType = mapData.r; // [0,1] 映射到 4 种地形

                // 根据地形类型选择颜色
                half3 terrainColor;
                if (terrainType < 0.25)
                    terrainColor = _GrassColor.rgb;
                else if (terrainType < 0.5)
                    terrainColor = _DesertColor.rgb;
                else if (terrainType < 0.75)
                    terrainColor = _WaterColor.rgb;
                else
                    terrainColor = _MountainColor.rgb;

                // 也可以用随机颜色（测试用）
                // float hue = Hash21(cellID);
                // terrainColor = 0.5 + 0.5 * cos(float3(0, 2.094, 4.189) + hue * 6.28);

                // 悬停高亮效果
                float2 hoveredID = _HoveredCellID.xy;
                bool isHovered = (abs(cellID.x - hoveredID.x) < 0.5) &&
                                 (abs(cellID.y - hoveredID.y) < 0.5);
                float pulse = 0.5 + 0.5 * sin(_Time.y * _HoverPulseSpeed);
                float hoverStrength = isHovered ? (_HoverColor.a * pulse) : 0.0;
                terrainColor = lerp(terrainColor, _HoverColor.rgb, hoverStrength);

                // 单位标记（地图数据 G 通道）
                if (mapData.g > 0.5)
                {
                    // 在格子中心绘制小圆点表示单位
                    float unitDot = smoothstep(0.15, 0.1, length(localPos));
                    terrainColor = lerp(terrainColor, float3(1, 0.2, 0.2), unitDot);
                }

                // 混合边界线
                half3 finalColor = lerp(terrainColor, _BorderColor.rgb, border);

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## C# 地图数据管理

```csharp
// HexMapDataManager.cs
using UnityEngine;

public class HexMapDataManager : MonoBehaviour
{
    [SerializeField] private Material hexMapMaterial;
    [SerializeField] private int mapWidth = 32;
    [SerializeField] private int mapHeight = 32;

    private Texture2D _mapDataTexture;
    private Color[] _mapData;

    // 地形类型枚举
    public enum TerrainType { Grass = 0, Desert = 1, Water = 2, Mountain = 3 }

    void Start()
    {
        _mapDataTexture = new Texture2D(mapWidth, mapHeight, TextureFormat.RGBA32, false);
        _mapDataTexture.filterMode = FilterMode.Point; // 六边形地图需要点采样
        _mapData = new Color[mapWidth * mapHeight];

        // 初始化地图（示例：随机生成）
        for (int y = 0; y < mapHeight; y++)
        for (int x = 0; x < mapWidth; x++)
        {
            int idx = y * mapWidth + x;
            float terrainVal = (float)Random.Range(0, 4) / 4.0f + 0.1f;
            _mapData[idx] = new Color(terrainVal, 0, 0, 1);
        }

        _mapDataTexture.SetPixels(_mapData);
        _mapDataTexture.Apply();
        hexMapMaterial.SetTexture("_MapDataTex", _mapDataTexture);
    }

    // 设置悬停格子（可在 Update 中根据鼠标射线检测调用）
    public void SetHoveredCell(Vector2 cellID)
    {
        hexMapMaterial.SetVector("_HoveredCellID", new Vector4(cellID.x, cellID.y, 0, 0));
    }

    // 动态修改地形类型
    public void SetTerrainType(int x, int y, TerrainType type)
    {
        int idx = y * mapWidth + x;
        float terrainVal = (float)((int)type) / 4.0f + 0.1f;
        _mapData[idx].r = terrainVal;
        _mapDataTexture.SetPixels(_mapData);
        _mapDataTexture.Apply();
    }
}
```

## 程序化棋盘/砖墙材质

```hlsl
// 程序化砖墙（支持缩放、颜色随机化、缝隙宽度控制）
half4 BrickWall(float2 uv, float brickScale, float mortarWidth)
{
    uv *= brickScale;

    // 每行偏移半块砖（砖墙错缝）
    float row = floor(uv.y);
    float offset = frac(row * 0.5) * 0.5; // 奇偶行错位 0.5
    float2 brickUV = float2(uv.x + offset, uv.y);

    float2 cellID = floor(brickUV);
    float2 localUV = frac(brickUV);

    // 灰泥（缝隙）：UV 靠近边缘时为灰色
    float mortarX = smoothstep(0.0, mortarWidth, localUV.x) *
                    (1.0 - smoothstep(1.0 - mortarWidth, 1.0, localUV.x));
    float mortarY = smoothstep(0.0, mortarWidth, localUV.y) *
                    (1.0 - smoothstep(1.0 - mortarWidth, 1.0, localUV.y));
    float brick = mortarX * mortarY; // 1 = 砖块，0 = 缝隙

    // 每块砖随机颜色变化（增加真实感）
    float randColor = frac(sin(dot(cellID, float2(12.9898, 78.233))) * 43758.5453);
    half3 brickColor = lerp(
        half3(0.6, 0.25, 0.15),  // 基础砖色
        half3(0.75, 0.35, 0.2),  // 随机变亮
        randColor * 0.5
    );
    half3 mortarColor = half3(0.8, 0.78, 0.75); // 灰泥色

    return half4(lerp(mortarColor, brickColor, brick), 1.0);
}
```

## UI Shader 中的程序化图案

战斗 HUD、技能效果、地图遮罩都可以使用程序化图案，避免使用大量 UI 图片资源：

```hlsl
// 技能冷却效果：径向进度条（程序化，无需图片）
half4 SkillCooldown(float2 uv, float progress, float4 activeColor, float4 coolColor)
{
    float2 centered = uv * 2.0 - 1.0;
    float dist = length(centered);

    // 圆环遮罩
    float ring = smoothstep(0.95, 0.85, dist) * smoothstep(0.5, 0.6, dist);

    // 角度进度：将角度与 progress 对比
    float angle = atan2(centered.y, centered.x) / (2.0 * PI) + 0.5;
    float filled = step(angle, progress);

    half4 color = lerp(coolColor, activeColor, filled);
    color.a *= ring;
    return color;
}
```

## 性能考量

| 技术 | 开销 | 适用场景 |
|------|------|----------|
| 标准 UV 平铺 | 极低 | 无重复要求的背景 |
| Stochastic Sampling | 中（3× 纹理采样） | 地形、地面、大面积材质 |
| 六边形网格 SDF | 低（无纹理采样） | 策略游戏地图 UI |
| 程序化砖墙 | 极低（纯数学） | 室内场景、UI 背景 |

**踩坑提醒**：Stochastic Sampling 的权重混合会导致法线贴图采样在边界处出现插值错误。处理法线时需要特别注意，应在切线空间混合而非世界空间，否则会出现光照接缝。

程序化纹理是游戏开发中性价比最高的视觉优化手段之一——一个精心设计的数学函数，可以替代数张需要美术制作和内存加载的纹理资源。
