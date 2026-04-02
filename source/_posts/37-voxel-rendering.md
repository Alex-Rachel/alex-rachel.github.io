---
title: Unity Shader 系列（三十七）：体素渲染完整实战——Chunk 系统与 URP 体素 Shader
date: 2026-04-01 15:00:00
tags: [HLSL, URP, 体素渲染, Minecraft, Chunk系统]
---

## Unity 体素游戏的技术全景

Minecraft 风格的体素游戏在 Unity 中实现需要解决三个核心工程问题：**数据组织**（如何高效存储亿级体素）、**网格生成**（如何将体素数据转换为可渲染的三角面）、**渲染**（如何高效渲染大量体素面）。本篇从零到一覆盖整个技术栈：Chunk 系统设计、Greedy Meshing 算法、纹理集 UV 计算、顶点 AO，以及完整的 URP 体素 Shader。

## Chunk 系统架构

体素世界不能一次性加载全部数据——即使是 256×256×256 的小地图也需要 16MB 内存。标准做法是将世界分割为固定大小的 **Chunk**（区块），只加载玩家周围的区块。

### Chunk 数据结构

```csharp
using UnityEngine;
using System.Collections.Generic;

// 单个方块类型
public enum BlockType : byte
{
    Air   = 0,
    Grass = 1,
    Dirt  = 2,
    Stone = 3,
    Sand  = 4,
    Water = 5,
}

// 体素世界常量
public static class VoxelConfig
{
    public const int CHUNK_SIZE   = 16;  // X/Z 方向大小
    public const int CHUNK_HEIGHT = 256; // Y 方向高度
    public const int RENDER_DISTANCE = 8; // 渲染距离（Chunk 数）

    // 六个面的方向
    public static readonly Vector3Int[] FaceDirections = {
        Vector3Int.up,    Vector3Int.down,
        Vector3Int.left,  Vector3Int.right,
        Vector3Int.forward, Vector3Int.back
    };
}

// 单个 Chunk 的数据类
public class ChunkData
{
    public Vector2Int ChunkCoord; // Chunk 的世界坐标（以 Chunk 为单位）
    private BlockType[] blocks;   // 扁平化的三维数组

    public ChunkData(Vector2Int coord)
    {
        ChunkCoord = coord;
        blocks = new BlockType[VoxelConfig.CHUNK_SIZE
                             * VoxelConfig.CHUNK_HEIGHT
                             * VoxelConfig.CHUNK_SIZE];
    }

    // 三维坐标 → 一维索引
    private int GetIndex(int x, int y, int z)
    {
        return x + VoxelConfig.CHUNK_SIZE * (y + VoxelConfig.CHUNK_HEIGHT * z);
    }

    public BlockType GetBlock(int x, int y, int z)
    {
        if (x < 0 || x >= VoxelConfig.CHUNK_SIZE ||
            y < 0 || y >= VoxelConfig.CHUNK_HEIGHT ||
            z < 0 || z >= VoxelConfig.CHUNK_SIZE)
            return BlockType.Air;
        return blocks[GetIndex(x, y, z)];
    }

    public void SetBlock(int x, int y, int z, BlockType type)
    {
        if (x < 0 || x >= VoxelConfig.CHUNK_SIZE ||
            y < 0 || y >= VoxelConfig.CHUNK_HEIGHT ||
            z < 0 || z >= VoxelConfig.CHUNK_SIZE)
            return;
        blocks[GetIndex(x, y, z)] = type;
    }

    public bool IsAir(int x, int y, int z)
    {
        return GetBlock(x, y, z) == BlockType.Air;
    }
}
```

## Greedy Meshing：减少三角面数

朴素的体素渲染为每个可见面生成两个三角形。一个 16×16×16 的 Chunk 最多可见面约 16384 个，但 Greedy Meshing 可以将相邻相同材质的面合并为一个大矩形，大幅减少三角面数（实测减少 60~80%）。

```csharp
public class GreedyMeshBuilder
{
    // 面方向枚举（0=+Y, 1=-Y, 2=+X, 3=-X, 4=+Z, 5=-Z）
    private struct FaceInfo
    {
        public BlockType blockType;
        public bool      merged; // 是否已被合并
    }

    // 对一个方向的切片进行贪心合并
    // axis: 0=X, 1=Y, 2=Z 方向的切片
    // positive: true=正方向面, false=负方向面
    public void GenerateSliceMesh(
        ChunkData chunk,
        int       sliceCoord,  // 切片在 axis 方向的坐标
        int       axis,
        bool      positive,
        List<Vector3> vertices,
        List<int>     triangles,
        List<Vector2> uvs,
        List<Color32> colors)
    {
        // 获取切片尺寸（axis=1 是 Y 轴，切片是 XZ 平面）
        int uSize = axis == 0 ? VoxelConfig.CHUNK_HEIGHT : VoxelConfig.CHUNK_SIZE;
        int vSize = axis == 2 ? VoxelConfig.CHUNK_HEIGHT : VoxelConfig.CHUNK_SIZE;

        var faceGrid = new FaceInfo[uSize, vSize];

        // 填充面网格：哪些位置需要生成这个方向的面
        for (int u = 0; u < uSize; u++)
        {
            for (int v = 0; v < vSize; v++)
            {
                // 根据 axis 转换为 xyz 坐标
                int x = axis == 0 ? sliceCoord : (axis == 2 ? v : u);
                int y = axis == 1 ? sliceCoord : (axis == 2 ? sliceCoord : v);
                int z = axis == 2 ? sliceCoord : (axis == 0 ? v : u);

                BlockType current = chunk.GetBlock(x, y, z);
                int nx = x + (axis == 0 ? (positive ? 1 : -1) : 0);
                int ny = y + (axis == 1 ? (positive ? 1 : -1) : 0);
                int nz = z + (axis == 2 ? (positive ? 1 : -1) : 0);
                BlockType neighbor = chunk.GetBlock(nx, ny, nz);

                // 面可见：当前格子不为空，且邻居为空
                if (current != BlockType.Air && neighbor == BlockType.Air)
                    faceGrid[u, v] = new FaceInfo { blockType = current, merged = false };
                else
                    faceGrid[u, v] = new FaceInfo { blockType = BlockType.Air, merged = true };
            }
        }

        // Greedy Meshing：贪心合并
        for (int u = 0; u < uSize; u++)
        {
            for (int v = 0; v < vSize; v++)
            {
                if (faceGrid[u, v].merged) continue;
                BlockType type = faceGrid[u, v].blockType;

                // 沿 V 方向扩展
                int vEnd = v + 1;
                while (vEnd < vSize && !faceGrid[u, vEnd].merged && faceGrid[u, vEnd].blockType == type)
                    vEnd++;

                // 沿 U 方向扩展（检查整行是否都满足条件）
                int uEnd = u + 1;
                while (uEnd < uSize)
                {
                    bool canExpand = true;
                    for (int vi = v; vi < vEnd; vi++)
                    {
                        if (faceGrid[uEnd, vi].merged || faceGrid[uEnd, vi].blockType != type)
                        {
                            canExpand = false;
                            break;
                        }
                    }
                    if (!canExpand) break;
                    uEnd++;
                }

                // 标记已合并的区域
                for (int ui = u; ui < uEnd; ui++)
                    for (int vi = v; vi < vEnd; vi++)
                        faceGrid[ui, vi].merged = true;

                // 添加合并后的大矩形面
                AddFace(vertices, triangles, uvs, colors,
                        u, v, uEnd - u, vEnd - v,
                        sliceCoord, axis, positive, type);
            }
        }
    }

    void AddFace(List<Vector3> verts, List<int> tris, List<Vector2> uvs, List<Color32> colors,
                 int u, int v, int uSize, int vSize,
                 int sliceCoord, int axis, bool positive, BlockType type)
    {
        int baseIdx = verts.Count;

        // 构建矩形的四个顶点（根据 axis 方向转换坐标）
        Vector3[] faceVerts = new Vector3[4];
        Vector3[] positions = {
            ToWorldPos(u,        v,        sliceCoord, axis, positive),
            ToWorldPos(u + uSize,v,        sliceCoord, axis, positive),
            ToWorldPos(u + uSize,v + vSize,sliceCoord, axis, positive),
            ToWorldPos(u,        v + vSize,sliceCoord, axis, positive),
        };

        verts.AddRange(positions);

        // 法线方向决定三角形绕序
        if (positive)
        {
            tris.AddRange(new[] { baseIdx, baseIdx+1, baseIdx+2, baseIdx, baseIdx+2, baseIdx+3 });
        }
        else
        {
            tris.AddRange(new[] { baseIdx, baseIdx+2, baseIdx+1, baseIdx, baseIdx+3, baseIdx+2 });
        }

        // 纹理集 UV（见下节）
        var atlasUV = GetAtlasUV(type, axis, positive, uSize, vSize);
        uvs.AddRange(atlasUV);

        // 顶点 AO 颜色（见下节）
        colors.AddRange(new Color32[] {
            new Color32(255, 255, 255, 255),
            new Color32(255, 255, 255, 255),
            new Color32(255, 255, 255, 255),
            new Color32(255, 255, 255, 255)
        });
    }

    Vector3 ToWorldPos(int u, int v, int s, int axis, bool positive)
    {
        float offset = positive ? 1 : 0;
        switch (axis)
        {
            case 0: return new Vector3(s + offset, u, v);
            case 1: return new Vector3(u, s + offset, v);
            default: return new Vector3(u, v, s + offset);
        }
    }

    Vector2[] GetAtlasUV(BlockType type, int axis, bool positive, int uSize, int vSize)
    {
        // 见下节纹理集实现
        return new Vector2[4] {
            new Vector2(0, 0), new Vector2(uSize, 0),
            new Vector2(uSize, vSize), new Vector2(0, vSize)
        };
    }
}
```

## 纹理集（Texture Atlas）与防漏色

体素游戏的所有方块纹理通常打包在一张大纹理（纹理集）上，通过 UV 坐标选择不同的子纹理。

### 防止纹理漏色（Bleeding）

漏色是指纹理集中相邻纹理的像素"渗入"到当前纹理边界，在 Mipmap 降采样时尤为严重。

**解决方案**：UV 坐标向内收缩半个纹素（Texel Padding）：

```csharp
public class TextureAtlas
{
    private int atlasWidth;   // 纹理集宽度（像素）
    private int atlasHeight;  // 纹理集高度
    private int tileSize;     // 每个方块纹理大小（如 16px）

    public int TilesPerRow   => atlasWidth  / tileSize;
    public int TilesPerColumn=> atlasHeight / tileSize;

    // 获取某方块类型在纹理集中的 UV 偏移（左下角 UV）
    public Vector2 GetTileOffset(int tileX, int tileY)
    {
        return new Vector2(
            (float)tileX * tileSize / atlasWidth,
            (float)tileY * tileSize / atlasHeight
        );
    }

    // 获取防漏色 UV 坐标（向内缩进半个 Texel）
    public Vector2[] GetSafeTileUVs(int tileX, int tileY, int uSize, int vSize)
    {
        // 半个 Texel 的 UV 偏移（防止漏色）
        float halfTexelX = 0.5f / atlasWidth;
        float halfTexelY = 0.5f / atlasHeight;

        float u0 = (float)tileX * tileSize / atlasWidth  + halfTexelX;
        float v0 = (float)tileY * tileSize / atlasHeight + halfTexelY;
        float u1 = u0 + (float)tileSize / atlasWidth  - halfTexelX * 2;
        float v1 = v0 + (float)tileSize / atlasHeight - halfTexelY * 2;

        // UV 按面的 uSize/vSize 重复（贪心合并的大面需要 UV 重复）
        return new Vector2[]
        {
            new Vector2(u0,       v0),
            new Vector2(u0 + (u1-u0) * uSize, v0),
            new Vector2(u0 + (u1-u0) * uSize, v0 + (v1-v0) * vSize),
            new Vector2(u0,       v0 + (v1-v0) * vSize)
        };
    }
}
```

## 顶点 AO（Vertex Ambient Occlusion）

体素 AO 不需要光线追踪，通过检查顶点周围邻居体素的遮蔽情况计算环境光遮蔽值，存储在顶点颜色中。

```csharp
// 计算单个顶点的 AO 值（0=完全遮蔽，1=完全开放）
byte CalculateVertexAO(ChunkData chunk, Vector3Int vertexPos, int axis, bool positive)
{
    // 顶点在面的角落，需要检查周围的 3 个邻居
    // side1, side2: 相邻的两个侧面体素
    // corner: 对角体素
    Vector3Int normal = new Vector3Int(
        axis == 0 ? (positive ? 1 : -1) : 0,
        axis == 1 ? (positive ? 1 : -1) : 0,
        axis == 2 ? (positive ? 1 : -1) : 0
    );

    // 根据顶点位置确定两个侧面方向（简化实现）
    // 完整实现需要根据顶点在面的四个角分别计算

    // AO 公式：0 个邻居遮蔽 → AO=3, 1个 → AO=2, 2个 → AO=1, side1+side2都遮蔽 → AO=0
    int side1Occluded = 0; // 0 or 1
    int side2Occluded = 0;
    int cornerOccluded = 0;

    // 如果两个侧面都有体素，角落方向不可见（不检查 corner）
    int aoValue;
    if (side1Occluded == 1 && side2Occluded == 1)
        aoValue = 0;
    else
        aoValue = 3 - (side1Occluded + side2Occluded + cornerOccluded);

    // 归一化到 0-255（存入 Color32.r）
    return (byte)(aoValue * 255 / 3);
}
```

## 完整 URP 体素地形 Shader

```hlsl
Shader "Custom/URP/VoxelTerrain"
{
    Properties
    {
        _AtlasTex       ("Texture Atlas",       2D)    = "white" {}
        _AtlasTileSize  ("Tile Size (0-1 UV)",  Float) = 0.0625  // 1/16，16×16 纹理集
        _FogColor       ("Fog Color",           Color) = (0.6, 0.7, 0.8, 1.0)
        _FogStart       ("Fog Start Distance",  Float) = 80
        _FogEnd         ("Fog End Distance",    Float) = 160
        _AmbientColor   ("Ambient Color",       Color) = (0.3, 0.35, 0.4, 1.0)
        _AOStrength     ("AO Strength",         Range(0, 1)) = 0.7
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
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _SHADOWS_SOFT
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR;     // 顶点 AO 存储在顶点颜色的 R 通道
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 positionWS  : TEXCOORD0;
                float3 normalWS    : TEXCOORD1;
                float2 uv          : TEXCOORD2;
                float  ao          : TEXCOORD3; // AO 值
                float  fogFactor   : TEXCOORD4;
            };

            TEXTURE2D(_AtlasTex); SAMPLER(sampler_AtlasTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _AtlasTex_ST;
                float  _AtlasTileSize;
                float4 _FogColor;
                float  _FogStart;
                float  _FogEnd;
                float4 _AmbientColor;
                float  _AOStrength;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                VertexPositionInputs posInputs = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.positionHCS = posInputs.positionCS;
                OUT.positionWS  = posInputs.positionWS;
                OUT.normalWS    = TransformObjectToWorldNormal(IN.normalOS);
                OUT.uv = IN.uv; // UV 直接来自网格生成（已包含纹理集偏移）

                // AO 从顶点颜色 R 通道读取，映射到 [AOStrength, 1] 范围
                OUT.ao = lerp(_AOStrength, 1.0, IN.color.r);

                // 线性雾计算（在顶点阶段计算，Fragment 阶段 Lerp）
                float dist = length(_WorldSpaceCameraPos - posInputs.positionWS);
                OUT.fogFactor = saturate((dist - _FogStart) / (_FogEnd - _FogStart));

                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // ===== 纹理采样 =====
                half4 albedo = SAMPLE_TEXTURE2D(_AtlasTex, sampler_AtlasTex, IN.uv);

                // ===== 光照 =====
                float3 normalWS = normalize(IN.normalWS);

                // 获取主光源（含阴影衰减）
                float4 shadowCoord = TransformWorldToShadowCoord(IN.positionWS);
                Light mainLight = GetMainLight(shadowCoord);
                float NdotL = saturate(dot(normalWS, mainLight.direction));

                // 面方向光照（顶部面最亮，底部面最暗）
                // 体素游戏常用此技巧替代复杂光照，性能更好
                float faceDimming = 1.0;
                if (abs(normalWS.y + 1.0) < 0.1) faceDimming = 0.5;  // 底部面
                else if (abs(normalWS.x) > 0.5 || abs(normalWS.z) > 0.5) faceDimming = 0.75; // 侧面

                // 漫反射：主光源 + 环境光
                half3 diffuse = mainLight.color * NdotL * mainLight.shadowAttenuation * faceDimming;
                half3 ambient = _AmbientColor.rgb;
                half3 lighting = diffuse + ambient;

                // ===== 应用 AO =====
                half3 color = albedo.rgb * lighting * IN.ao;

                // ===== 距离雾 =====
                color = lerp(color, _FogColor.rgb, IN.fogFactor);

                return half4(color, 1.0);
            }
            ENDHLSL
        }

        // 阴影投射
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
    }
}
```

## 体素破坏特效 Shader

方块被破坏时，碎片飞散的顶点动画 Shader：

```hlsl
Shader "Custom/URP/VoxelBreakEffect"
{
    Properties
    {
        _MainTex        ("Block Texture",   2D)    = "white" {}
        _LifeTime       ("Life Time",       Float) = 1.0
        _Gravity        ("Gravity",         Float) = 9.8
        _SpreadRadius   ("Spread Radius",   Float) = 2.0
        _RotateSpeed    ("Rotate Speed",    Float) = 5.0
        _ElapsedTime    ("Elapsed Time",    Float) = 0.0  // C# 每帧传入
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

        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR; // R=碎片ID（决定飞散方向）
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
                float  alpha       : TEXCOORD1;
            };

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float  _LifeTime;
                float  _Gravity;
                float  _SpreadRadius;
                float  _RotateSpeed;
                float  _ElapsedTime;
            CBUFFER_END

            // 伪随机数（基于碎片 ID）
            float3 RandomDir(float id)
            {
                float a = id * 137.508;
                float b = id * 98.76543;
                return normalize(float3(sin(a) * cos(b), abs(sin(b)) + 0.3, cos(a) * cos(b)));
            }

            float3x3 RotationMatrix(float3 axis, float angle)
            {
                float s = sin(angle), c = cos(angle);
                float oc = 1.0 - c;
                return float3x3(
                    oc * axis.x * axis.x + c,
                    oc * axis.x * axis.y - axis.z * s,
                    oc * axis.z * axis.x + axis.y * s,
                    oc * axis.x * axis.y + axis.z * s,
                    oc * axis.y * axis.y + c,
                    oc * axis.y * axis.z - axis.x * s,
                    oc * axis.z * axis.x - axis.y * s,
                    oc * axis.y * axis.z + axis.x * s,
                    oc * axis.z * axis.z + c
                );
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                float t    = _ElapsedTime;
                float life = t / _LifeTime;  // [0, 1]

                // 碎片 ID（从顶点颜色读取，每个碎片的顶点有相同 ID）
                float id = IN.color.r * 255.0;

                // 飞散方向（随机）
                float3 flyDir  = RandomDir(id);
                float3 flyPos  = flyDir * _SpreadRadius * t;

                // 重力（向下加速）
                flyPos.y -= 0.5 * _Gravity * t * t;

                // 旋转（碎片在飞行中旋转）
                float3 rotAxis = normalize(float3(sin(id), cos(id * 2.3), sin(id * 1.7)));
                float  rotAngle = t * _RotateSpeed * (frac(id * 0.618) - 0.5) * 2.0;
                float3x3 rotMat = RotationMatrix(rotAxis, rotAngle);

                // 应用位移和旋转
                float3 posOS = mul(rotMat, IN.positionOS.xyz) + flyPos;
                OUT.positionHCS = TransformObjectToHClip(posOS);
                OUT.uv = TRANSFORM_TEX(IN.uv, _MainTex);

                // Alpha 随时间淡出
                OUT.alpha = 1.0 - smoothstep(0.5, 1.0, life);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                half4 col = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);
                col.a *= IN.alpha;
                return col;
            }
            ENDHLSL
        }
    }
}
```

## GPU Instancing 与间接渲染优化

体素渲染的主要性能瓶颈是大量 Chunk 的 DrawCall。使用 GPU Instancing 和 `DrawMeshInstancedIndirect` 可以大幅降低 CPU 开销：

```csharp
// Chunk 管理器中批量渲染所有 Chunk
public class ChunkRenderer : MonoBehaviour
{
    public Mesh   chunkMesh;     // 统一的区块 Mesh（或程序化生成）
    public Material chunkMaterial;
    private List<Matrix4x4> chunkTransforms = new List<Matrix4x4>();

    void Update()
    {
        // 收集所有可见 Chunk 的变换矩阵
        chunkTransforms.Clear();
        foreach (var chunk in LoadedChunks)
        {
            if (IsChunkVisible(chunk))
                chunkTransforms.Add(chunk.transform.localToWorldMatrix);
        }

        // 每次最多 1023 个实例（Unity GPU Instancing 限制）
        for (int i = 0; i < chunkTransforms.Count; i += 1023)
        {
            int count = Mathf.Min(1023, chunkTransforms.Count - i);
            var batch = chunkTransforms.GetRange(i, count).ToArray();
            Graphics.DrawMeshInstanced(chunkMesh, 0, chunkMaterial, batch);
        }
    }
}
```

## 游戏应用场景

| 技术 | 具体游戏应用 |
|------|------------|
| Greedy Meshing | 沙盒建造游戏的高效地形渲染 |
| 纹理集 + AO | Minecraft 风格视觉效果 |
| Chunk 流式加载 | 无缝大世界，内存控制在 500MB 以内 |
| GPU Instancing | 批量渲染 100+ Chunk，DrawCall < 10 |
| 破坏特效 Shader | 方块破坏/爆炸视觉反馈 |
| 水面透明 Shader | 体素水体（半透明 + 折射） |

## 性能考量

- **Chunk 大小的选择**：16×16 是最常见的选择，平衡了网格生成时间（约 0.5ms/Chunk）和 DrawCall 数量。32×32 减少 DrawCall 但网格重建更慢
- **Greedy Meshing 适用场景**：均匀材质大面积（草地、石墙）效果显著；凌乱的自然地形（洞穴、矿脉）效果有限
- **AO 的性能影响**：顶点 AO 计算在网格生成时完成（离线），运行时零额外开销，推荐始终启用
- **Mipmap 与纹理集漏色**：建议在纹理集 Texture Import 中启用 Mipmap，但 Filter Mode 选 `Trilinear`，不要选 `Bilinear`。同时纹理集中每个方块纹理之间至少留 2px 间距

Unity 中的体素渲染是一个既考验数学（AO、Greedy Meshing）又考验工程（Chunk 系统、内存管理）的综合课题，但每一个技术点都有清晰的优化路径——从最简单的朴素实现出发，逐步引入优化，最终可以在 Unity 中构建出媲美商业体素游戏的流畅体验。
