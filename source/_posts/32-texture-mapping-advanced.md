---
title: Unity Shader 系列（三十二）：高级纹理映射——Triplanar、纹理数组与无缝采样
date: 2026-05-03 12:00:00
tags: [HLSL, URP, 三面投影, Triplanar, 无缝纹理]
---

## 为什么普通 UV 不够用？

传统 UV 展开在静态网格上工作良好，但游戏开发中经常遇到以下困境：

- **程序化地形**：运行时生成的地形网格没有预制 UV，或 UV 拉伸严重
- **任意朝向的岩石/树干**：UV 展开无法避免拉伸，角落处纹理变形
- **大面积地表**：简单平铺会产生明显重复感，玩家一眼就能看出图案规律
- **多层地形混合**：草地、泥土、岩石等多种材质需要按高度/法线权重混合

本篇介绍三种解决方案：**Triplanar Mapping（三面投影）**、**Texture Array（纹理数组）** 和 **Stochastic Sampling（随机化采样）**，每种方案都给出完整可用的 URP Shader。

## 核心技术一：Triplanar Mapping

### 原理

从世界空间的 X、Y、Z 三个轴方向分别投影纹理，然后按法线方向权重混合三个采样结果。法线朝向哪个轴，就主要采用那个轴的投影。

```
混合权重 = pow(abs(worldNormal), _Blend)
混合权重 = 归一化（使三个分量之和为 1）
```

### 完整 URP Triplanar Shader

```hlsl
Shader "Custom/URP/TriplanarMapping"
{
    Properties
    {
        _MainTex        ("Albedo Texture",      2D)     = "white" {}
        _NormalMap      ("Normal Map",          2D)     = "bump"  {}
        _NormalStrength ("Normal Strength",     Range(0, 2)) = 1.0
        _Tiling         ("World Space Tiling",  Float)  = 1.0
        _Blend          ("Blend Sharpness",     Range(1, 8)) = 4.0
        _Smoothness     ("Smoothness",          Range(0, 1)) = 0.3
        _Metallic       ("Metallic",            Range(0, 1)) = 0.0
    }
    SubShader
    {
        Tags
        {
            "RenderType"       = "Opaque"
            "RenderPipeline"   = "UniversalPipeline"
            "Queue"            = "Geometry"
        }

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _SHADOWS_SOFT

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
            };

            struct Varyings
            {
                float4 positionHCS  : SV_POSITION;
                float3 positionWS   : TEXCOORD0;   // 世界空间位置（用于 triplanar 投影）
                float3 normalWS     : TEXCOORD1;
                float3 tangentWS    : TEXCOORD2;
                float3 bitangentWS  : TEXCOORD3;
            };

            TEXTURE2D(_MainTex);   SAMPLER(sampler_MainTex);
            TEXTURE2D(_NormalMap); SAMPLER(sampler_NormalMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float  _Tiling;
                float  _Blend;
                float  _NormalStrength;
                float  _Smoothness;
                float  _Metallic;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                VertexPositionInputs posInputs = GetVertexPositionInputs(IN.positionOS.xyz);
                VertexNormalInputs   norInputs = GetVertexNormalInputs(IN.normalOS, IN.tangentOS);

                OUT.positionHCS = posInputs.positionCS;
                OUT.positionWS  = posInputs.positionWS;
                OUT.normalWS    = norInputs.normalWS;
                OUT.tangentWS   = norInputs.tangentWS;
                OUT.bitangentWS = norInputs.bitangentWS;
                return OUT;
            }

            // ===== Triplanar 采样核心函数 =====
            // 返回三个轴方向的混合权重（已归一化）
            float3 TriplanarWeights(float3 worldNormal, float blend)
            {
                float3 w = pow(abs(worldNormal), blend);
                // 归一化，防止混合权重之和不为 1
                return w / (w.x + w.y + w.z + 1e-6);
            }

            // 三面投影采样颜色纹理
            half4 SampleTriplanar(TEXTURE2D_PARAM(tex, smp), float3 worldPos, float3 weights, float tiling)
            {
                // 三个轴的 UV（世界坐标直接用作纹理坐标）
                half4 xProj = SAMPLE_TEXTURE2D(tex, smp, worldPos.zy * tiling); // YZ 面
                half4 yProj = SAMPLE_TEXTURE2D(tex, smp, worldPos.xz * tiling); // XZ 面（地面）
                half4 zProj = SAMPLE_TEXTURE2D(tex, smp, worldPos.xy * tiling); // XY 面

                return xProj * weights.x + yProj * weights.y + zProj * weights.z;
            }

            // 三面投影采样法线贴图（需要在各轴的切线空间中重建法线）
            float3 SampleTriplanarNormal(TEXTURE2D_PARAM(tex, smp),
                                         float3 worldPos, float3 worldNormal,
                                         float3 weights, float tiling, float strength)
            {
                // 分别采样三个面的法线
                half4 xN = SAMPLE_TEXTURE2D(tex, smp, worldPos.zy * tiling);
                half4 yN = SAMPLE_TEXTURE2D(tex, smp, worldPos.xz * tiling);
                half4 zN = SAMPLE_TEXTURE2D(tex, smp, worldPos.xy * tiling);

                // 解包法线（DXT5nm 格式：.ag 通道，或标准 .rgb 格式）
                float3 nX = UnpackNormal(xN);
                float3 nY = UnpackNormal(yN);
                float3 nZ = UnpackNormal(zN);

                // 法线强度控制
                nX.xy *= strength;
                nY.xy *= strength;
                nZ.xy *= strength;

                // 各轴的法线变换到世界空间
                // X 面：tangent=Z, bitangent=Y
                // Y 面：tangent=X, bitangent=Z
                // Z 面：tangent=X, bitangent=Y
                float3 nXWS = float3(nX.z * sign(worldNormal.x), nX.y, nX.x * sign(worldNormal.x));
                float3 nYWS = float3(nY.x, nY.z * sign(worldNormal.y), nY.y * sign(worldNormal.y));
                float3 nZWS = float3(nZ.x, nZ.y, nZ.z * sign(worldNormal.z));

                return normalize(nXWS * weights.x + nYWS * weights.y + nZWS * weights.z + worldNormal);
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float3 worldNormal = normalize(IN.normalWS);
                float3 weights = TriplanarWeights(worldNormal, _Blend);

                // 三面投影采样颜色和法线
                half4 albedo = SampleTriplanar(TEXTURE2D_ARGS(_MainTex, sampler_MainTex),
                                               IN.positionWS, weights, _Tiling);
                float3 normal = SampleTriplanarNormal(TEXTURE2D_ARGS(_NormalMap, sampler_NormalMap),
                                                      IN.positionWS, worldNormal, weights,
                                                      _Tiling, _NormalStrength);

                // URP 标准光照
                InputData inputData = (InputData)0;
                inputData.positionWS = IN.positionWS;
                inputData.normalWS   = normal;
                inputData.viewDirectionWS = GetWorldSpaceNormalizeViewDir(IN.positionWS);
                inputData.shadowCoord = TransformWorldToShadowCoord(IN.positionWS);

                SurfaceData surfaceData = (SurfaceData)0;
                surfaceData.albedo      = albedo.rgb;
                surfaceData.alpha       = 1.0;
                surfaceData.smoothness  = _Smoothness;
                surfaceData.metallic    = _Metallic;
                surfaceData.normalTS    = float3(0, 0, 1); // 法线已在世界空间处理

                return UniversalFragmentPBR(inputData, surfaceData);
            }
            ENDHLSL
        }

        // 阴影投射 Pass（必须包含，否则物体不产生阴影）
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
    }
}
```

**踩坑提示**：`_Blend` 参数越高，三个轴的混合边界越锐利。地形一般用 4，岩石/鹅卵石用 6-8。过低（<2）会导致边缘模糊，看起来像故障纹理。

## 核心技术二：多套 UV 通道

Unity 的网格最多支持 4 套 UV（UV0 到 UV3），在 Shader 中分别用 `TEXCOORD0` 到 `TEXCOORD3` 访问。

```hlsl
struct Attributes
{
    float4 positionOS : POSITION;
    float2 uv0        : TEXCOORD0;  // 主纹理 UV（通常是 UV0）
    float2 uv1        : TEXCOORD1;  // 光照贴图 UV（Lightmap 用 UV1）
    float2 uv2        : TEXCOORD2;  // 细节贴图 UV 或特殊用途
    float2 uv3        : TEXCOORD3;  // 遮罩/混合贴图 UV
};

// 在顶点 Shader 中传递
struct Varyings
{
    float4 positionHCS : SV_POSITION;
    float2 uv0         : TEXCOORD0;
    float2 uv1         : TEXCOORD1;
    float4 uv23        : TEXCOORD2;  // 打包 uv2.xy + uv3.xy
};

Varyings vert(Attributes IN)
{
    Varyings OUT;
    OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
    OUT.uv0  = TRANSFORM_TEX(IN.uv0, _MainTex);
    OUT.uv1  = IN.uv1;    // Lightmap UV 不做 Transform
    OUT.uv23 = float4(IN.uv2, IN.uv3);
    return OUT;
}
```

## 核心技术三：Texture Array 地形多层混合

`TEXTURE2D_ARRAY` 将多张相同尺寸的纹理打包成一个资源，通过整数索引访问，避免多次纹理绑定切换。

### C# 创建 Texture2DArray

```csharp
using UnityEngine;

public class TerrainTextureArrayBuilder : MonoBehaviour
{
    [Header("按顺序放置：草地、泥土、岩石、雪地")]
    public Texture2D[] terrainTextures;

    public Texture2DArray BuildArray()
    {
        if (terrainTextures == null || terrainTextures.Length == 0) return null;

        int width  = terrainTextures[0].width;
        int height = terrainTextures[0].height;
        int count  = terrainTextures.Length;

        // 注意：所有纹理必须相同尺寸和格式
        var array = new Texture2DArray(width, height, count,
                                       terrainTextures[0].format,
                                       true, // 生成 Mipmap
                                       false); // 非线性颜色空间

        for (int i = 0; i < count; i++)
        {
            // 逐 mip 级别复制数据
            for (int mip = 0; mip < terrainTextures[i].mipmapCount; mip++)
            {
                Graphics.CopyTexture(terrainTextures[i], 0, mip, array, i, mip);
            }
        }

        array.Apply(false, true); // makeNoLongerReadable=true 节省内存
        return array;
    }
}
```

### Texture Array 地形 Shader

```hlsl
Shader "Custom/URP/TerrainTextureArray"
{
    Properties
    {
        _TerrainArray  ("Terrain Texture Array", 2DArray) = "" {}
        _SplatMap      ("Splat Map (RGBA=4 layers)", 2D) = "red" {}
        _Tiling        ("Texture Tiling", Float) = 4.0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #pragma require  2darray   // 声明需要 Texture2DArray 支持
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 positionWS  : TEXCOORD0;
                float3 normalWS    : TEXCOORD1;
                float2 uv          : TEXCOORD2;
            };

            TEXTURE2D_ARRAY(_TerrainArray); SAMPLER(sampler_TerrainArray);
            TEXTURE2D(_SplatMap);           SAMPLER(sampler_SplatMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _SplatMap_ST;
                float  _Tiling;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                VertexPositionInputs posInputs = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.positionHCS = posInputs.positionCS;
                OUT.positionWS  = posInputs.positionWS;
                OUT.normalWS    = TransformObjectToWorldNormal(IN.normalOS);
                OUT.uv = TRANSFORM_TEX(IN.uv, _SplatMap);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // 读取混合权重（RGBA 对应 4 层材质的权重）
                half4 splat = SAMPLE_TEXTURE2D(_SplatMap, sampler_SplatMap, IN.uv);

                // 世界空间 UV 用于纹理采样（平铺）
                float2 worldUV = IN.positionWS.xz * _Tiling;

                // 分别采样 4 层地形纹理
                // SAMPLE_TEXTURE2D_ARRAY 第三个参数是数组索引（必须是 float）
                half4 layer0 = SAMPLE_TEXTURE2D_ARRAY(_TerrainArray, sampler_TerrainArray, worldUV, 0.0); // 草地
                half4 layer1 = SAMPLE_TEXTURE2D_ARRAY(_TerrainArray, sampler_TerrainArray, worldUV, 1.0); // 泥土
                half4 layer2 = SAMPLE_TEXTURE2D_ARRAY(_TerrainArray, sampler_TerrainArray, worldUV, 2.0); // 岩石
                half4 layer3 = SAMPLE_TEXTURE2D_ARRAY(_TerrainArray, sampler_TerrainArray, worldUV, 3.0); // 雪地

                // 按权重混合（splat.r + splat.g + splat.b + splat.a 应约等于 1）
                half4 albedo = layer0 * splat.r
                             + layer1 * splat.g
                             + layer2 * splat.b
                             + layer3 * splat.a;

                // 简单漫反射光照
                float3 normalWS = normalize(IN.normalWS);
                Light mainLight = GetMainLight(TransformWorldToShadowCoord(IN.positionWS));
                float NdotL = saturate(dot(normalWS, mainLight.direction));
                half3 lighting = mainLight.color * (NdotL * mainLight.shadowAttenuation + 0.2);

                return half4(albedo.rgb * lighting, 1.0);
            }
            ENDHLSL
        }
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
    }
}
```

## 核心技术四：消除纹理重复——Stochastic Sampling

大地形或大面积墙面如果直接平铺纹理，人眼会立刻识别出重复图案。**Stochastic Sampling（随机偏移采样）**通过对每个纹理格子施加随机 UV 偏移来打破重复感。

```hlsl
Shader "Custom/URP/StochasticTexture"
{
    Properties
    {
        _MainTex    ("Main Texture",        2D)    = "white" {}
        _NormalMap  ("Normal Map",          2D)    = "bump"  {}
        _Tiling     ("Tiling",              Float) = 4.0
        _UseStoch   ("Use Stochastic",      Float) = 1.0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 positionWS  : TEXCOORD0;
                float3 normalWS    : TEXCOORD1;
                float2 uv          : TEXCOORD2;
            };

            TEXTURE2D(_MainTex);   SAMPLER(sampler_MainTex);
            TEXTURE2D(_NormalMap); SAMPLER(sampler_NormalMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float  _Tiling;
                float  _UseStoch;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.positionWS  = TransformObjectToWorld(IN.positionOS.xyz);
                OUT.normalWS    = TransformObjectToWorldNormal(IN.normalOS);
                OUT.uv = IN.uv * _Tiling;
                return OUT;
            }

            // 哈希函数：输入 2D 格子坐标，输出随机 4D 偏移
            float4 Hash4(float2 p)
            {
                float4 p4 = frac(float4(p.xyxy) * float4(0.1031, 0.1030, 0.0973, 0.1099));
                p4 += dot(p4, p4.wzxy + 33.33);
                return frac((p4.xxyz + p4.yzzw) * p4.zywx);
            }

            // Stochastic 采样：对每个格子施加随机偏移，消除平铺感
            // 相比普通 tex.Sample，增加约 4x 采样次数，但对视觉质量提升显著
            half4 SampleStochastic(TEXTURE2D_PARAM(tex, smp), float2 uv)
            {
                float2 iuv = floor(uv);
                float2 fuv = frac(uv);

                // 四角格子的随机偏移
                float4 ofa = Hash4(iuv + float2(0, 0));
                float4 ofb = Hash4(iuv + float2(1, 0));
                float4 ofc = Hash4(iuv + float2(0, 1));
                float4 ofd = Hash4(iuv + float2(1, 1));

                // 平滑混合曲线（避免在格子边界处产生硬接缝）
                float2 b = smoothstep(0.25, 0.75, fuv);

                // 四次采样，每个格子用自己的随机偏移
                half4 cola = SAMPLE_TEXTURE2D(tex, smp, uv + ofa.xy);
                half4 colb = SAMPLE_TEXTURE2D(tex, smp, uv + ofb.xy);
                half4 colc = SAMPLE_TEXTURE2D(tex, smp, uv + ofc.xy);
                half4 cold = SAMPLE_TEXTURE2D(tex, smp, uv + ofd.xy);

                return lerp(lerp(cola, colb, b.x),
                            lerp(colc, cold, b.x), b.y);
            }

            // 快速版本：仅 2 次采样，使用低频噪声贴图驱动插值
            // 适合移动端，效果略差但性能好
            half4 SampleStochasticCheap(TEXTURE2D_PARAM(tex, smp), float2 uv)
            {
                // 用低频自噪声（基于 UV 本身生成）
                float k = frac(sin(dot(floor(uv * 0.1), float2(127.1, 311.7))) * 43758.5453);
                float index  = k * 8.0;
                float fi     = floor(index);
                float ff     = frac(index);

                float2 offA = sin(float2(3.0, 7.0) * (fi + 0.0));
                float2 offB = sin(float2(3.0, 7.0) * (fi + 1.0));

                return lerp(
                    SAMPLE_TEXTURE2D(tex, smp, uv + offA),
                    SAMPLE_TEXTURE2D(tex, smp, uv + offB),
                    smoothstep(0.2, 0.8, ff)
                );
            }

            half4 frag(Varyings IN) : SV_Target
            {
                half4 albedo;
                if (_UseStoch > 0.5)
                    albedo = SampleStochastic(TEXTURE2D_ARGS(_MainTex, sampler_MainTex), IN.uv);
                else
                    albedo = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);

                half4 normalSample = _UseStoch > 0.5
                    ? SampleStochastic(TEXTURE2D_ARGS(_NormalMap, sampler_NormalMap), IN.uv)
                    : SAMPLE_TEXTURE2D(_NormalMap, sampler_NormalMap, IN.uv);

                // 简单光照
                float3 normalWS = normalize(IN.normalWS);
                Light mainLight = GetMainLight();
                float NdotL = saturate(dot(normalWS, mainLight.direction));

                return half4(albedo.rgb * (NdotL * mainLight.color + 0.2), 1.0);
            }
            ENDHLSL
        }
    }
}
```

## ShaderGraph 实现思路

ShaderGraph 中有内置的 **Triplanar** 节点（搜索 "Triplanar"），可直接使用：

1. 添加 `Triplanar` 节点，连接 Texture 和 Tiling 输入
2. `Blend` 参数控制混合锐利度（对应 HLSL 中的 `pow(abs(normal), blend)`）
3. 法线贴图需要单独 Triplanar 节点 + Normal Strength 节点

**ShaderGraph 没有内置 Stochastic Sampling 节点**——需要用 Custom Function 节点引入上述 `SampleStochastic` 函数。

## 性能对比

| 技术 | GPU 采样次数 | 适用场景 | 移动端建议 |
|------|-------------|----------|-----------|
| 普通 UV 采样 | 1 | 静态网格，有 UV | 推荐 |
| Triplanar（三面） | 3 | 无 UV 地形/岩石 | 慎用，改 Biplanar |
| Biplanar（双面） | 2 | 三面投影的优化版 | 可用 |
| Texture Array | 4（4 层） | 多层地形混合 | 可用 |
| Stochastic（标准） | 4 | 消除平铺感 | 改为 Cheap 版 |
| Stochastic（Cheap） | 2 | 移动端无平铺 | 推荐 |

## 常见踩坑

1. **Triplanar 法线接缝**：三个轴边界处法线混合必须在世界空间计算，不能在切线空间混合，否则产生可见接缝
2. **Texture2DArray 所有纹理必须同尺寸**：格式和大小不一致会导致导入失败，建议统一 2048×2048 或 1024×1024
3. **Stochastic 采样产生模糊**：`smoothstep(0.25, 0.75, fuv)` 的区间决定混合范围，区间过宽会导致边缘模糊，过窄会有硬接缝，0.25~0.75 是经验最优值
4. **`_Tiling` 参数与 Texture Import 设置冲突**：如果纹理导入时设置了 Repeat 且 Shader 中 _Tiling 很大，移动端可能遇到 UV 精度问题，建议 `_Tiling` 不超过 20
5. **ShadowCaster Pass**：自定义 Shader 必须包含 `UsePass "Universal Render Pipeline/Lit/ShadowCaster"`，否则物体不产生阴影

掌握这三种高级纹理映射技术，就能应对游戏项目中几乎所有的复杂贴图需求——无论是程序化地形、怪物皮肤还是大型环境场景。
