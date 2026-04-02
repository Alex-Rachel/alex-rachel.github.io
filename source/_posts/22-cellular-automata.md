---
title: Unity Shader 系列（二十二）：Compute Shader 实现元胞自动机
date: 2026-04-01 12:30:00
tags: [HLSL, URP, Compute Shader, 元胞自动机, 程序化纹理]
categories:
  - Unity Shader 系列
  - GPU 计算与模拟
---

元胞自动机（Cellular Automata）和反应扩散系统（Reaction-Diffusion）是程序化纹理生成的强大工具。在 Unity 中，Compute Shader 让这些计算密集型模拟可以完全在 GPU 上运行，以极高效率生成皮革纹、斑纹、裂纹、生命游戏等动态或静态纹理。

## 为什么用 Compute Shader？

传统 CPU 实现的元胞自动机每帧需要遍历所有格子（O(N²)），1024×1024 的网格每帧需要约 100 万次计算，CPU 难以实时完成。Compute Shader 将每个格子的计算分配给一个 GPU 线程，在并行执行下可在数毫秒内完成百万次计算。

## 生命游戏：Compute Shader 完整实现

### Compute Shader（GameOfLife.compute）

```hlsl
// GameOfLife.compute
#pragma kernel CSUpdate
#pragma kernel CSInit

// 双缓冲：读旧状态，写新状态
Texture2D<float> _ReadTex;
RWTexture2D<float> _WriteTex;

uint _Width;
uint _Height;
float _Seed; // 随机种子（初始化用）

// 简单哈希函数
float Hash(float2 p)
{
    return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
}

// 读取邻居（环绕边界）
float GetCell(int2 pos)
{
    // 环绕边界处理
    int2 wrappedPos = int2(
        ((pos.x % (int)_Width) + (int)_Width) % (int)_Width,
        ((pos.y % (int)_Height) + (int)_Height) % (int)_Height
    );
    return _ReadTex[wrappedPos];
}

// 计算 8 邻居存活数
int CountNeighbors(int2 center)
{
    int count = 0;
    for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++)
    {
        if (dx == 0 && dy == 0) continue; // 跳过自身
        count += (int)(GetCell(center + int2(dx, dy)) > 0.5);
    }
    return count;
}

// 初始化核：随机填充
[numthreads(8, 8, 1)]
void CSInit(uint3 id : SV_DispatchThreadID)
{
    float rnd = Hash(float2(id.x + _Seed * 100.0, id.y + _Seed * 73.0));
    _WriteTex[id.xy] = (rnd > 0.7) ? 1.0 : 0.0; // 约 30% 的格子初始存活
}

// 更新核：B3/S23 规则（康威生命游戏）
[numthreads(8, 8, 1)]
void CSUpdate(uint3 id : SV_DispatchThreadID)
{
    int2 pos = (int2)id.xy;
    float currentState = GetCell(pos);
    int neighbors = CountNeighbors(pos);

    float newState = 0.0;
    if (currentState > 0.5)
    {
        // 存活规则：2 或 3 个邻居则继续存活
        newState = (neighbors == 2 || neighbors == 3) ? 1.0 : 0.0;
    }
    else
    {
        // 诞生规则：恰好 3 个邻居则诞生
        newState = (neighbors == 3) ? 1.0 : 0.0;
    }

    _WriteTex[id.xy] = newState;
}
```

### C# 控制脚本（GameOfLifeController.cs）

```csharp
using UnityEngine;

public class GameOfLifeController : MonoBehaviour
{
    [SerializeField] private ComputeShader computeShader;
    [SerializeField] private int width = 512;
    [SerializeField] private int height = 512;
    [SerializeField] private float updateInterval = 0.1f; // 更新间隔（秒）

    private RenderTexture[] _textures; // 双缓冲
    private int _currentIndex = 0;
    private float _timer;

    private int _kernelInit;
    private int _kernelUpdate;

    // 供 Renderer 使用的当前状态纹理
    public RenderTexture CurrentTexture => _textures[_currentIndex];

    void Start()
    {
        // 创建双缓冲 RenderTexture
        _textures = new RenderTexture[2];
        for (int i = 0; i < 2; i++)
        {
            _textures[i] = new RenderTexture(width, height, 0, RenderTextureFormat.RFloat);
            _textures[i].enableRandomWrite = true; // Compute Shader 必须开启
            _textures[i].filterMode = FilterMode.Point; // CA 需要点采样
            _textures[i].Create();
        }

        _kernelInit = computeShader.FindKernel("CSInit");
        _kernelUpdate = computeShader.FindKernel("CSUpdate");

        Initialize();
    }

    void Initialize()
    {
        computeShader.SetInt("_Width", width);
        computeShader.SetInt("_Height", height);
        computeShader.SetFloat("_Seed", Random.value);

        // 运行初始化核
        computeShader.SetTexture(_kernelInit, "_WriteTex", _textures[_currentIndex]);
        computeShader.Dispatch(_kernelInit, width / 8, height / 8, 1);
    }

    void Update()
    {
        _timer += Time.deltaTime;
        if (_timer >= updateInterval)
        {
            _timer -= updateInterval;
            Step();
        }

        // 鼠标交互：左键点击播种细胞
        if (Input.GetMouseButton(0))
        {
            PaintCells(Input.mousePosition);
        }
    }

    void Step()
    {
        int readIndex = _currentIndex;
        int writeIndex = 1 - _currentIndex;

        computeShader.SetInt("_Width", width);
        computeShader.SetInt("_Height", height);
        computeShader.SetTexture(_kernelUpdate, "_ReadTex", _textures[readIndex]);
        computeShader.SetTexture(_kernelUpdate, "_WriteTex", _textures[writeIndex]);

        // 分发线程组（线程组大小 8×8，所以需要 width/8 个线程组）
        computeShader.Dispatch(_kernelUpdate, width / 8, height / 8, 1);

        _currentIndex = writeIndex; // 交换缓冲
    }

    void PaintCells(Vector3 screenPos)
    {
        // 将屏幕坐标转换为纹理坐标并播种
        // 此处需要额外的 Compute Shader 核或直接用 SetPixel（性能较差）
        // 生产中建议用 CommandBuffer + BlitWithMaterial 方式处理
    }

    void OnDestroy()
    {
        foreach (var tex in _textures)
            tex?.Release();
    }
}
```

## Gray-Scott 反应扩散系统：生成兽皮纹理

Gray-Scott 系统用两种物质 U（激活剂）和 V（抑制剂）的扩散反应模拟自然界中的图案生成——豹纹、斑马纹、珊瑚纹都源于此类机制。

### Compute Shader（ReactionDiffusion.compute）

```hlsl
// ReactionDiffusion.compute
#pragma kernel CSReactionDiffusion

// 使用 float2 存储 (u, v) 两个物质浓度
Texture2D<float2> _ReadState;
RWTexture2D<float2> _WriteState;

uint _Width;
uint _Height;

// Gray-Scott 参数——不同参数产生不同图案
float _DiffU;       // U 的扩散系数（推荐 0.21）
float _DiffV;       // V 的扩散系数（推荐 0.105）
float _FeedRate;    // 进料率 F（控制图案类型）
float _KillRate;    // 消除率 k

// 计算 9 点拉普拉斯（对角线权重 0.05，十字权重 0.2，中心 -1.0）
float2 Laplacian(int2 pos)
{
    int2 sz = int2(_Width, _Height);

    // 获取 9 个采样点（环绕边界）
    float2 c  = _ReadState[pos];
    float2 n  = _ReadState[int2((pos.x    ) % sz.x, (pos.y + 1) % sz.y)];
    float2 s  = _ReadState[int2((pos.x    ) % sz.x, (pos.y - 1 + sz.y) % sz.y)];
    float2 e  = _ReadState[int2((pos.x + 1) % sz.x, (pos.y    ) % sz.y)];
    float2 w  = _ReadState[int2((pos.x - 1 + sz.x) % sz.x, (pos.y    ) % sz.y)];
    float2 ne = _ReadState[int2((pos.x + 1) % sz.x, (pos.y + 1) % sz.y)];
    float2 nw = _ReadState[int2((pos.x - 1 + sz.x) % sz.x, (pos.y + 1) % sz.y)];
    float2 se = _ReadState[int2((pos.x + 1) % sz.x, (pos.y - 1 + sz.y) % sz.y)];
    float2 sw = _ReadState[int2((pos.x - 1 + sz.x) % sz.x, (pos.y - 1 + sz.y) % sz.y)];

    return (n + s + e + w) * 0.2 + (ne + nw + se + sw) * 0.05 - c;
}

[numthreads(8, 8, 1)]
void CSReactionDiffusion(uint3 id : SV_DispatchThreadID)
{
    int2 pos = (int2)id.xy;
    float2 state = _ReadState[pos];
    float u = state.x;
    float v = state.y;

    // 计算拉普拉斯
    float2 lap = Laplacian(pos);

    // Gray-Scott 方程
    float uvv = u * v * v; // 反应项
    float du = _DiffU * lap.x - uvv + _FeedRate * (1.0 - u);
    float dv = _DiffV * lap.y + uvv - (_FeedRate + _KillRate) * v;

    float newU = saturate(u + du);
    float newV = saturate(v + dv);

    _WriteState[pos] = float2(newU, newV);
}
```

### 关键参数对照表（图案类型）

| F（进料率） | k（消除率） | 生成图案 |
|------------|------------|----------|
| 0.035 | 0.065 | 斑点（豹纹） |
| 0.040 | 0.060 | 波纹条纹（斑马纹） |
| 0.025 | 0.055 | 迷宫纹（脑珊瑚） |
| 0.050 | 0.065 | 孤子（稳定泡泡） |
| 0.060 | 0.062 | 不稳定增殖（细菌样） |

## URP Renderer Feature 可视化

将计算结果实时渲染到场景需要自定义 Renderer Feature。

```csharp
// CAVisualizerFeature.cs
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public class CAVisualizerFeature : ScriptableRendererFeature
{
    [System.Serializable]
    public class Settings
    {
        public Material visualizeMaterial;
        public RenderPassEvent renderPassEvent = RenderPassEvent.AfterRenderingOpaques;
    }

    public Settings settings = new Settings();
    private CAVisualizerPass _pass;

    public override void Create()
    {
        _pass = new CAVisualizerPass(settings);
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        renderer.EnqueuePass(_pass);
    }

    class CAVisualizerPass : ScriptableRenderPass
    {
        private Settings _settings;

        public CAVisualizerPass(Settings settings)
        {
            _settings = settings;
            renderPassEvent = settings.renderPassEvent;
        }

        public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
        {
            if (_settings.visualizeMaterial == null) return;

            CommandBuffer cmd = CommandBufferPool.Get("CA Visualizer");

            // 找到场景中的 CA 控制器，获取当前纹理
            var controller = Object.FindObjectOfType<GameOfLifeController>();
            if (controller != null)
            {
                _settings.visualizeMaterial.SetTexture("_MainTex", controller.CurrentTexture);
                // 在指定渲染目标上绘制全屏 Quad
                cmd.DrawProcedural(Matrix4x4.identity, _settings.visualizeMaterial, 0,
                    MeshTopology.Triangles, 3);
            }

            context.ExecuteCommandBuffer(cmd);
            CommandBufferPool.Release(cmd);
        }
    }
}
```

## 程序化纹理应用：皮革/斑纹/裂纹材质

反应扩散系统的稳定状态（运行足够帧数后）可以直接烘焙为静态纹理用于材质：

```hlsl
// 材质 Shader：使用 RD 纹理生成皮革外观
Shader "Custom/URP/LeatherMaterial"
{
    Properties
    {
        _RDTexture ("RD 纹理（V通道）", 2D) = "white" {}
        _BaseColor ("底色", Color) = (0.3, 0.15, 0.05, 1)
        _PatternColor ("图案颜色", Color) = (0.1, 0.05, 0.02, 1)
        _NormalStrength ("法线强度", Float) = 1.0
        _Smoothness ("光滑度", Range(0, 1)) = 0.3
    }

    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_RDTexture); SAMPLER(sampler_RDTexture);

            CBUFFER_START(UnityPerMaterial)
                float4 _RDTexture_ST;
                float4 _BaseColor;
                float4 _PatternColor;
                float _NormalStrength;
                float _Smoothness;
            CBUFFER_END

            struct Attributes { float4 posOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; };
            struct Varyings { float4 posCS : SV_POSITION; float2 uv : TEXCOORD0; float3 normalWS : TEXCOORD1; float3 posWS : TEXCOORD2; };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.posCS = TransformObjectToHClip(IN.posOS.xyz);
                OUT.uv = TRANSFORM_TEX(IN.uv, _RDTexture);
                OUT.normalWS = TransformObjectToWorldNormal(IN.normalOS);
                OUT.posWS = TransformObjectToWorld(IN.posOS.xyz);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // 读取 RD 纹理的 V 通道作为图案掩码
                float pattern = SAMPLE_TEXTURE2D(_RDTexture, sampler_RDTexture, IN.uv).g;

                // 根据 RD 值生成法线扰动（模拟皮革浮雕）
                float2 texelSize = 1.0 / float2(512, 512);
                float patternR = SAMPLE_TEXTURE2D(_RDTexture, sampler_RDTexture, IN.uv + float2(texelSize.x, 0)).g;
                float patternU = SAMPLE_TEXTURE2D(_RDTexture, sampler_RDTexture, IN.uv + float2(0, texelSize.y)).g;
                float3 bumpNormal = normalize(float3(
                    (patternR - pattern) * _NormalStrength,
                    (patternU - pattern) * _NormalStrength,
                    1.0
                ));

                // 将切线空间法线转换到世界空间（简化版）
                float3 normalWS = normalize(IN.normalWS + bumpNormal * 0.3);

                // 颜色混合
                half3 albedo = lerp(_BaseColor.rgb, _PatternColor.rgb, step(0.5, pattern));

                // 简单 Lambert 光照
                Light mainLight = GetMainLight();
                float NdotL = saturate(dot(normalWS, mainLight.direction));
                half3 finalColor = albedo * (mainLight.color * NdotL + 0.2);

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 游戏实战应用

**传染病/火势蔓延模拟**：将生命游戏规则改为有概率传播的 SIR（易感-感染-恢复）模型，用于 RTS 游戏的地图事件或 Roguelike 游戏的火焰蔓延。

**程序化 Boss 皮肤动态变化**：在 Boss 战中实时运行 RD 系统，让 Boss 的皮肤纹理随血量/阶段变化，从规则斑点变为混乱条纹。

**地图生成辅助**：用元胞自动机生成洞穴/地下城地图（经典 Cave Generation 算法），再用 Marching Squares 转换为可行走网格。

## 性能考量

- `numthreads(8, 8, 1)` 在大多数 GPU 上效率最佳，不要使用 `(1, 1, 1)`
- 512×512 的 RD 模拟在现代 GPU 上每帧约 0.2ms，1024×1024 约 1ms
- 避免在 Compute Shader 中使用随机写入（atomic 操作），CA 的读写分离天然避免了这个问题
- 移动端 Compute Shader 支持需要 OpenGL ES 3.1 或 Metal（iOS 8+），务必在 Player Settings 中检查

元胞自动机和反应扩散系统是"用极简规则生成无限复杂图案"的完美范例。在 Unity 的 Compute Shader 加持下，这些原本只存在于学术模拟中的系统，可以变成游戏中实时跳动的有机纹理。
