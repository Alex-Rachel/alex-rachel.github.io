---
title: Unity Shader 系列（十四）：域重复：无限地板与程序化纹理优化
date: 2026-04-15 12:00:00
tags: [HLSL, URP, 域重复, 程序化纹理, 性能优化]
---

域重复（Domain Repetition）在 Unity 开发中是一项被严重低估的技术。当你需要渲染无限延伸的地面、密集的地砖、重复的建筑外墙细节，或是任何存在大量重复几何的场景时，域重复技术可以在完全不增加 GPU 内存带宽的情况下，让单张纹理渲染出无限变化的视觉效果，同时避免明显的重复感。本文深入讲解 Unity URP 地形 Shader 中的域重复实践，以及如何与 GPU Instancing 协同工作。

## 域重复 vs GPU Instancing

理解这两种技术的分工非常重要，它们解决的是不同层面的重复问题：

| 对比维度 | 域重复（Shader 内） | GPU Instancing |
|---------|-------------------|----------------|
| 适用场景 | 纹理/UV 坐标的无限重复 | 相同 Mesh 的大量实例 |
| 解决的问题 | 贴图重复感、无限地面 | 草地、树木、石头等物件 |
| 内存开销 | 极低（只需一份纹理） | 每个实例需要少量数据 |
| CPU Draw Call | 无变化 | 大幅减少（合批） |
| 典型组合 | 地面 Shader + 域重复 | 草叶 Mesh + GPU Instancing |

**实际项目中往往两者结合**：地面 Shader 内用域重复消除明显的瓷砖接缝感，同时地面上的石头、草丛使用 GPU Instancing 渲染大量实例。

## 核心技术：打破重复感的三种方法

单纯的 `frac(uv * tiling)` 会产生非常明显的周期性重复，高端游戏中有三种常用技术来消除这种感觉：

### 方法一：基于单元格 ID 的随机旋转

每个瓷砖单元随机旋转 0°/90°/180°/270°，视觉上完全打破规律性：

```hlsl
// 返回当前 UV 所在单元格的 ID（整数坐标）
float2 GetCellID(float2 uv, float tileSize)
{
    return floor(uv / tileSize);
}

// 低质量哈希（适合移动端，无 sin 调用）
float Hash2D(float2 p)
{
    p = frac(p * float2(0.1031, 0.1030));
    p += dot(p, p.yx + 33.33);
    return frac((p.x + p.y) * p.x);
}

// 单元格内随机旋转 UV
float2 TileWithRandomRotation(float2 uv, float tileSize)
{
    float2 cellID = GetCellID(uv, tileSize);
    float2 cellUV = frac(uv / tileSize);  // [0,1] 内的局部 UV

    // 随机旋转角度（限定为 90° 的倍数，保证边缘无缝）
    float randVal = Hash2D(cellID);
    float angle   = floor(randVal * 4.0) * 1.5708; // 0, 90, 180, 270 度

    // 绕单元格中心旋转
    float2 centeredUV = cellUV - 0.5;
    float  cosA = cos(angle), sinA = sin(angle);
    float2 rotatedUV = float2(
        cosA * centeredUV.x - sinA * centeredUV.y,
        sinA * centeredUV.x + cosA * centeredUV.y
    );
    return rotatedUV + 0.5;
}
```

### 方法二：随机翻转（性能更好）

只做水平/垂直翻转，避免 sin/cos 的计算开销：

```hlsl
float2 TileWithRandomFlip(float2 uv, float tileSize)
{
    float2 cellID = floor(uv / tileSize);
    float2 cellUV = frac(uv / tileSize);

    // 每个单元格独立决定是否翻转 X 和 Y
    float rx = frac(sin(dot(cellID, float2(127.1, 311.7))) * 43758.5);
    float ry = frac(sin(dot(cellID, float2(269.5, 183.3))) * 43758.5);

    if (rx > 0.5) cellUV.x = 1.0 - cellUV.x;
    if (ry > 0.5) cellUV.y = 1.0 - cellUV.y;

    return cellUV;
}
```

### 方法三：Wang Tiles（完美无缝拼接）

使用预制的 Wang Tile 集（4 色边缘编码的多张瓷砖），确保相邻单元格边缘颜色匹配，实现真正无缝无重复：

```hlsl
// 需要一张 Wang Tile 贴图集（2×2 或 4×4 排列的变体瓷砖）
float2 WangTileUV(float2 uv, TEXTURE2D(tileAtlas), float tileSize, int atlasSize)
{
    float2 cellID  = floor(uv / tileSize);
    float2 cellUV  = frac(uv / tileSize);

    // 四个角的哈希值决定选择哪块瓷砖
    float2 hash  = float2(
        frac(sin(dot(cellID, float2(127.1, 311.7))) * 43758.5),
        frac(sin(dot(cellID, float2(269.5, 183.3))) * 43758.5)
    );

    // 选取图集中的哪个瓷砖（atlasSize × atlasSize 的网格）
    float2 tileIndex = floor(hash * float(atlasSize));
    float2 atlasUV   = (tileIndex + cellUV) / float(atlasSize);
    return atlasUV;
}
```

## 完整示例：URP 无限地板 Shader

这个 Shader 实现了使用域重复的高质量无限地板：每格随机翻转 + 多尺度细节叠加 + 视距随机化消除重复感。

```hlsl
Shader "Custom/URP/InfiniteFloor"
{
    Properties
    {
        _MainTex ("地面主纹理", 2D) = "white" {}
        _NormalMap ("法线贴图", 2D) = "bump" {}
        _DetailTex ("细节纹理（小尺度）", 2D) = "white" {}
        _TileSize ("瓷砖大小（世界单位）", Float) = 2.0
        _DetailTileSize ("细节瓷砖大小", Float) = 0.25
        _NormalStrength ("法线强度", Range(0, 3)) = 1.0
        _Roughness ("粗糙度", Range(0, 1)) = 0.8
        _Metallic ("金属度", Range(0, 1)) = 0.0

        // 视距渐变（避免远处重复感）
        _FarBlendStart ("远距渐变开始", Float) = 20.0
        _FarBlendEnd ("远距渐变结束", Float) = 50.0
        _FarColor ("远处颜色", Color) = (0.5, 0.5, 0.5, 1)

        // 随机化强度
        _RandomColorVariation ("颜色随机变化强度", Range(0, 0.3)) = 0.05
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
        }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _SHADOWS_SOFT
            #pragma multi_compile _ _ADDITIONAL_LIGHTS

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_MainTex);    SAMPLER(sampler_MainTex);
            TEXTURE2D(_NormalMap);  SAMPLER(sampler_NormalMap);
            TEXTURE2D(_DetailTex);  SAMPLER(sampler_DetailTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _NormalMap_ST;
                float4 _DetailTex_ST;
                float  _TileSize;
                float  _DetailTileSize;
                float  _NormalStrength;
                float  _Roughness;
                float  _Metallic;
                float  _FarBlendStart;
                float  _FarBlendEnd;
                float4 _FarColor;
                float  _RandomColorVariation;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 worldPos    : TEXCOORD0;
                float3 worldNormal : TEXCOORD1;
                float3 worldTangent : TEXCOORD2;
                float3 worldBitangent : TEXCOORD3;
                float4 shadowCoord : TEXCOORD4;
            };

            // 无 sin 快速哈希
            float Hash(float2 p)
            {
                p = frac(p * float2(0.1031, 0.1030));
                p += dot(p, p.yx + 33.33);
                return frac((p.x + p.y) * p.x);
            }

            // 域重复：基于世界位置的随机翻转瓷砖 UV
            float2 RepeatTileUV(float2 worldXZ, float tileSize)
            {
                float2 cellID = floor(worldXZ / tileSize);
                float2 cellUV = frac(worldXZ / tileSize);

                // 随机翻转（每个单元格独立）
                float rx = Hash(cellID * 1.731);
                float ry = Hash(cellID * 2.537 + 5.0);

                if (rx > 0.5) cellUV.x = 1.0 - cellUV.x;
                if (ry > 0.5) cellUV.y = 1.0 - cellUV.y;

                return cellUV;
            }

            // 每个瓷砖的随机颜色偏移（轻微颜色变化打破单调感）
            float3 GetTileColorVariation(float2 worldXZ, float tileSize)
            {
                float2 cellID = floor(worldXZ / tileSize);
                float rand = Hash(cellID + 100.0);
                // 在中性灰周围随机扰动
                return float3(rand, Hash(cellID + 200.0), Hash(cellID + 300.0)) * 2.0 - 1.0;
            }

            Varyings vert(Attributes input)
            {
                Varyings output;
                VertexPositionInputs posInputs = GetVertexPositionInputs(input.positionOS.xyz);
                VertexNormalInputs   norInputs = GetVertexNormalInputs(input.normalOS, input.tangentOS);

                output.positionHCS    = posInputs.positionCS;
                output.worldPos       = posInputs.positionWS;
                output.worldNormal    = norInputs.normalWS;
                output.worldTangent   = norInputs.tangentWS;
                output.worldBitangent = norInputs.bitangentWS;
                output.shadowCoord    = GetShadowCoord(posInputs);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float3 worldPos = input.worldPos;
                float2 worldXZ  = worldPos.xz;

                // ---- 域重复 UV（大瓷砖）----
                float2 tileUV   = RepeatTileUV(worldXZ, _TileSize);

                // ---- 域重复 UV（细节层，更小的瓷砖）----
                float2 detailUV = RepeatTileUV(worldXZ, _DetailTileSize);

                // ---- 采样主纹理和细节纹理 ----
                float3 mainColor   = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, tileUV).rgb;
                float3 detailColor = SAMPLE_TEXTURE2D(_DetailTex, sampler_DetailTex, detailUV).rgb;

                // 细节叠加（overlay 混合：增强细节而不改变整体色调）
                float3 albedo = mainColor * (detailColor * 2.0);

                // 每格轻微颜色变化（在视觉敏感的中距离特别有效）
                float3 colorVar = GetTileColorVariation(worldXZ, _TileSize);
                albedo += colorVar * _RandomColorVariation;
                albedo = saturate(albedo);

                // ---- 法线贴图 ----
                float4 normalSample = SAMPLE_TEXTURE2D(_NormalMap, sampler_NormalMap, tileUV);
                float3 normalTS     = UnpackNormalScale(normalSample, _NormalStrength);

                float3x3 TBN = float3x3(
                    normalize(input.worldTangent),
                    normalize(input.worldBitangent),
                    normalize(input.worldNormal)
                );
                float3 worldNormal = normalize(mul(normalTS, TBN));

                // ---- 与相机的距离（用于远距离 LOD 渐变）----
                float camDist = length(worldPos - GetCameraPositionWS());
                float farBlend = smoothstep(_FarBlendStart, _FarBlendEnd, camDist);

                // 远处渐变到纯色（避免远处纹理噪点和重复感）
                albedo = lerp(albedo, _FarColor.rgb, farBlend);
                worldNormal = lerp(worldNormal, normalize(input.worldNormal), farBlend);

                // ---- URP 标准 PBR 光照 ----
                InputData lightingInput;
                lightingInput.positionWS            = worldPos;
                lightingInput.normalWS              = worldNormal;
                lightingInput.viewDirectionWS       = normalize(GetCameraPositionWS() - worldPos);
                lightingInput.shadowCoord           = input.shadowCoord;
                lightingInput.fogCoord              = 0;
                lightingInput.vertexLighting        = half3(0, 0, 0);
                lightingInput.bakedGI               = SampleSH(worldNormal);
                lightingInput.normalizedScreenSpaceUV = float2(0, 0);
                lightingInput.shadowMask            = unity_ProbesOcclusion;

                SurfaceData surfaceData;
                surfaceData.albedo              = albedo;
                surfaceData.metallic            = _Metallic;
                surfaceData.specular            = 0;
                surfaceData.smoothness          = 1.0 - _Roughness;
                surfaceData.normalTS            = normalTS;
                surfaceData.emission            = 0;
                surfaceData.occlusion           = 1.0;
                surfaceData.alpha               = 1.0;
                surfaceData.clearCoatMask       = 0;
                surfaceData.clearCoatSmoothness = 0;

                return UniversalFragmentPBR(lightingInput, surfaceData);
            }
            ENDHLSL
        }

        // ShadowCaster Pass（标准，无特殊处理）
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
    }
}
```

## 域重复减少 Draw Call：替代大量 GameObject 实例

这是域重复最强大的实际应用之一。考虑这个场景：一个地下城地面需要显示数百个刻痕、污渍、金属嵌片等细节。

**传统方案**：创建数百个 Decal GameObject 或手动摆放的小 Mesh，产生大量 Draw Call。

**域重复方案**：在地面 Shader 内用程序化逻辑生成这些细节，完全在 GPU 中计算，零额外 Draw Call：

```hlsl
// 在地面 Shader 的 frag 中添加：
// 程序化金属嵌片（每隔 3 个单元格出现一次）
float2 metalCellID = floor(worldXZ / (_TileSize * 3.0));
float  metalRand   = Hash(metalCellID * 7.31);

if (metalRand > 0.7) // 30% 的单元格有金属嵌片
{
    float2 metalLocalUV = frac(worldXZ / (_TileSize * 3.0));
    float  metalDist    = length(metalLocalUV - 0.5);

    if (metalDist < 0.15) // 圆形金属嵌片
    {
        // 混合金属质感
        albedo  = lerp(albedo, float3(0.8, 0.75, 0.7), 0.8);
        _Metallic = 0.9;
        surfaceData.smoothness = 0.7;
    }
}
```

## 与 GPU Instancing 的实际配合

在开放世界游戏中，地面使用域重复渲染表面细节，地面上的植被使用 GPU Instancing。两者之间有一个关键的性能边界：

- **密度极高（每平方米超过 10 株）的草地**：使用 Geometry Shader 或 Compute Shader 驱动的草叶，通过域重复计算每根草的随机偏移和朝向
- **中等密度的树木/石头**：GPU Instancing，通过 `DrawMeshInstanced` 批量提交
- **地面纹理细节**：域重复 Shader，零额外 Draw Call

```csharp
// 通过 Material Property Block 为 Instancing 传递域重复参数
// 不同实例可以有不同的 TileSize，而无需为每个实例单独创建 Material
MaterialPropertyBlock mpb = new MaterialPropertyBlock();
for (int i = 0; i < groundMeshes.Length; i++)
{
    mpb.SetFloat("_TileSize", tileSizes[i]);   // 每块地面独立瓷砖尺寸
    mpb.SetFloat("_FarBlendStart", farStarts[i]);
    groundRenderers[i].SetPropertyBlock(mpb);   // 不破坏 Instancing 合批
}
```

## ShaderGraph 对应实现思路

在 ShaderGraph 中实现随机翻转瓷砖：
1. `Position` 节点（World Space）提取 xz 分量
2. `Divide` + `Floor` 计算单元格 ID
3. `Fraction` 计算单元格内 UV
4. 自定义 `Custom Function` 节点嵌入哈希函数（ShaderGraph 的内置节点无法轻松实现）
5. `Branch` 节点根据哈希值决定是否翻转
6. 最终 UV 输入到 `Sample Texture 2D` 节点

ShaderGraph 的限制：复杂的域重复逻辑（尤其是 Wang Tiles）难以只用节点表达，建议通过 Custom Function 节点嵌入 HLSL 代码。

## 性能考量

| 平台 | 优化建议 |
|------|---------|
| PC/主机 | 完整的双层域重复 + Wang Tiles，视觉质量优先 |
| 移动端高端 | 单层域重复 + 随机翻转，去掉细节层 |
| 移动端低端 | 关闭法线贴图，只保留随机翻转 UV |
| VR | 注意双眼渲染开销翻倍，减少纹理采样次数 |

**GPU 采样次数**：本 Shader 每片段有 3 次纹理采样（主纹理 + 细节 + 法线）。移动端限制在 2 次以内，PC/主机可以扩展到 5-6 次（增加 Wang Tiles、湿度图等）。

## 常见踩坑

**坑1：`frac()` 与 `fmod()` 在负数上的行为不同**
HLSL 中 `frac(-0.1) = 0.9`（正确），而 `fmod(-0.1, 1.0) = -0.1`（对负值不符合预期）。当相机进入负坐标区域时，用 `fmod` 实现域重复会在坐标轴负侧产生错误的 UV，必须使用 `frac`。

**坑2：法线贴图的切线空间不一致**
地面 Mesh 的切线方向（Tangent）会影响法线贴图的效果。如果 Mesh 是程序化生成的或者从 DCC 工具导入但未计算切线，法线贴图会出现方向错误。使用 `CalculateTangentSpace` 或在 Import Settings 中勾选 `Calculate` 选项。

**坑3：远距离渐变与雾的交互**
场景中同时有 Unity 场景雾和 Shader 内的 `farBlend` 渐变，两者应该使用相同的起止距离，否则地面会出现两次不连续的颜色过渡。

**坑4：Shader Stripping 导致变体丢失**
在 Build 时，Unity 的 Shader Stripping 可能删除某些 multi_compile 变体。如果发现 Build 后阴影不正确，检查 Project Settings → Graphics → Shader Stripping 的设置，确保需要的光照关键字变体被保留。
