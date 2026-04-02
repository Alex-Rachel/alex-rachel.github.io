---
title: Unity Shader 系列（三十一）：多通道渲染与 RenderTexture Ping-Pong 技术
date: 2026-04-01 14:00:00
tags: [HLSL, URP, RenderTexture, 多通道渲染, Ping-Pong]
categories:
  - Unity Shader 系列
  - 后处理与相机
---

## 为什么需要多通道渲染？

单帧渲染可以绘制出精美的画面，但许多高级效果本质上需要**跨帧的"记忆"**——流体模拟需要上一帧的速度场，屏幕空间轨迹需要保存历史像素，TAA 需要累积历史帧。这些效果的核心技术在 Unity 中称为 **RenderTexture Ping-Pong**：将渲染结果写入纹理而非直接输出到屏幕，下一帧再读取这张纹理，实现跨帧数据传递。

本篇将从 Unity 的视角彻底讲清这套技术：`RenderTexture` 创建与管理、三种 Blit 方案的选择、完整 Ping-Pong 实现，以及两个可直接在项目中使用的示例。

## RenderTexture 基础

### 创建与配置

在 Unity 中创建 RenderTexture 有两种方式：Inspector 配置和 C# 代码创建。

**Inspector 配置**（适合静态分辨率、不频繁更改的 RT）：
1. Project 窗口右键 → Create → Render Texture
2. 设置 Size、Color Format（推荐 `RGBAFloat` 用于物理模拟，`RGBA32` 用于普通后处理）
3. 设置 Filter Mode 和 Wrap Mode

**C# 代码创建**（适合运行时动态分辨率）：

```csharp
// 创建 RenderTexture 的标准方式
RenderTexture CreateSimulationRT(int width, int height)
{
    var rt = new RenderTexture(width, height, 0, RenderTextureFormat.ARGBFloat);
    rt.filterMode = FilterMode.Bilinear;
    rt.wrapMode = TextureWrapMode.Clamp;
    rt.enableRandomWrite = false; // 如果需要 Compute Shader 写入则设为 true
    rt.Create();
    return rt;
}
```

### RenderTextureFormat 选择指南

| 格式 | 位深 | 用途 |
|------|------|------|
| `ARGB32` | 8bpc | 普通颜色，后处理 |
| `ARGBHalf` | 16bpc | HDR 颜色，Bloom |
| `ARGBFloat` | 32bpc | 物理模拟，精度要求高 |
| `RFloat` | 32bpc 单通道 | 高度图，深度数据 |
| `RGFloat` | 32bpc 双通道 | 2D 速度场 |

## 三种 Blit 方案对比

Unity 中有三种将处理结果写入 RenderTexture 的方式，适用场景不同：

### 方案一：Graphics.Blit()

最简单，适合**简单的全屏后处理**。

```csharp
// 简单用法：将 src 纹理用 mat 材质处理后输出到 dst
Graphics.Blit(sourceRT, destinationRT, processMaterial);

// Ping-Pong 示例
void Update()
{
    // 读 pingRT，写 pongRT
    Graphics.Blit(pingRT, pongRT, simulationMaterial);
    // 交换引用
    (pingRT, pongRT) = (pongRT, pingRT);
}
```

**缺点**：在 URP 管线中与渲染顺序不兼容，可能产生时序问题。

### 方案二：CommandBuffer.Blit()

适合**需要精确控制执行时机**的场景，可插入渲染管线特定阶段。

```csharp
using UnityEngine;
using UnityEngine.Rendering;

public class CommandBufferPingPong : MonoBehaviour
{
    public Material simulationMaterial;
    private RenderTexture[] rts = new RenderTexture[2];
    private CommandBuffer cmd;
    private int currentIndex = 0;
    private Camera cam;

    void Start()
    {
        cam = GetComponent<Camera>();
        for (int i = 0; i < 2; i++)
        {
            rts[i] = new RenderTexture(Screen.width, Screen.height, 0, RenderTextureFormat.ARGBFloat);
            rts[i].Create();
        }

        cmd = new CommandBuffer { name = "PingPong Simulation" };
        // 在相机渲染完成后执行
        cam.AddCommandBuffer(CameraEvent.AfterEverything, cmd);
    }

    void Update()
    {
        int read = currentIndex;
        int write = 1 - currentIndex;

        cmd.Clear();
        // 设置上一帧纹理为 Shader 输入
        cmd.SetGlobalTexture("_PrevFrameTex", rts[read]);
        // Blit：读 rts[read]，写 rts[write]
        cmd.Blit(rts[read], rts[write], simulationMaterial);
        // 将结果传给后续 Pass
        cmd.SetGlobalTexture("_SimulationResult", rts[write]);

        currentIndex = write;
    }

    void OnDestroy()
    {
        cam.RemoveCommandBuffer(CameraEvent.AfterEverything, cmd);
        cmd.Release();
        foreach (var rt in rts) rt.Release();
    }
}
```

### 方案三：URP Renderer Feature（推荐方案）

这是 URP 中的**标准做法**，通过自定义 `ScriptableRendererFeature` 注入渲染 Pass，与管线生命周期完全集成，支持 `RTHandle` 系统。

```csharp
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

// 1. 定义渲染 Pass
public class PingPongSimulationPass : ScriptableRenderPass
{
    private Material simulationMaterial;
    private RTHandle[] rtHandles = new RTHandle[2];
    private int currentIndex = 0;
    private static readonly int PrevFrameTexID = Shader.PropertyToID("_PrevFrameTex");

    public PingPongSimulationPass(Material mat)
    {
        simulationMaterial = mat;
        renderPassEvent = RenderPassEvent.AfterRenderingPostProcessing;
    }

    public void Setup(int width, int height)
    {
        // RTHandle 是 URP 推荐的 RT 管理系统，自动处理分辨率缩放
        for (int i = 0; i < 2; i++)
        {
            RTHandles.Release(rtHandles[i]);
            rtHandles[i] = RTHandles.Alloc(
                width, height,
                colorFormat: UnityEngine.Experimental.Rendering.GraphicsFormat.R32G32B32A32_SFloat,
                filterMode: FilterMode.Bilinear,
                wrapMode: TextureWrapMode.Clamp,
                name: $"SimulationBuffer_{i}"
            );
        }
    }

    public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
    {
        int read = currentIndex;
        int write = 1 - currentIndex;

        CommandBuffer cmd = CommandBufferPool.Get("PingPong");

        // 将上一帧缓冲传入 Shader
        cmd.SetGlobalTexture(PrevFrameTexID, rtHandles[read]);
        // 执行模拟 Blit
        Blitter.BlitCameraTexture(cmd, rtHandles[read], rtHandles[write], simulationMaterial, 0);
        // 结果传给显示 Pass
        cmd.SetGlobalTexture("_SimulationResult", rtHandles[write]);

        context.ExecuteCommandBuffer(cmd);
        CommandBufferPool.Release(cmd);

        currentIndex = write;
    }

    public void Cleanup()
    {
        for (int i = 0; i < 2; i++)
            RTHandles.Release(rtHandles[i]);
    }
}

// 2. 定义 Renderer Feature
public class PingPongRendererFeature : ScriptableRendererFeature
{
    [System.Serializable]
    public class Settings
    {
        public Material simulationMaterial;
        public int bufferWidth = 512;
        public int bufferHeight = 512;
    }

    public Settings settings = new Settings();
    private PingPongSimulationPass simulationPass;

    public override void Create()
    {
        simulationPass = new PingPongSimulationPass(settings.simulationMaterial);
        simulationPass.Setup(settings.bufferWidth, settings.bufferHeight);
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        renderer.EnqueuePass(simulationPass);
    }

    protected override void Dispose(bool disposing)
    {
        simulationPass?.Cleanup();
    }
}
```

## 实战示例一：Game of Life（细胞自动机）

这是 Ping-Pong 最经典的演示：每帧根据周围邻居数量判断细胞生死。

### C# 控制脚本

```csharp
using UnityEngine;

public class GameOfLife : MonoBehaviour
{
    [Header("模拟配置")]
    public int gridWidth = 512;
    public int gridHeight = 512;
    public Material golMaterial;       // Game of Life 模拟 Shader
    public Material displayMaterial;   // 显示结果 Shader

    private RenderTexture[] buffers = new RenderTexture[2];
    private int currentBuffer = 0;
    private bool initialized = false;

    void Start()
    {
        // 创建两个浮点 RT 用于 Ping-Pong
        for (int i = 0; i < 2; i++)
        {
            buffers[i] = new RenderTexture(gridWidth, gridHeight, 0, RenderTextureFormat.RFloat);
            buffers[i].filterMode = FilterMode.Point; // 细胞自动机需要点采样
            buffers[i].wrapMode = TextureWrapMode.Repeat;
            buffers[i].Create();
        }

        // 初始化：随机生成初始状态
        Texture2D initTex = new Texture2D(gridWidth, gridHeight, TextureFormat.RFloat, false);
        Color[] pixels = new Color[gridWidth * gridHeight];
        for (int i = 0; i < pixels.Length; i++)
            pixels[i] = new Color(Random.value > 0.7f ? 1f : 0f, 0, 0, 1f);
        initTex.SetPixels(pixels);
        initTex.Apply();
        Graphics.Blit(initTex, buffers[0]);
        Destroy(initTex);

        initialized = true;
    }

    void Update()
    {
        if (!initialized) return;

        int read = currentBuffer;
        int write = 1 - currentBuffer;

        // 执行一步 GoL 模拟
        golMaterial.SetTexture("_PrevState", buffers[read]);
        golMaterial.SetVector("_TexelSize", new Vector4(1f / gridWidth, 1f / gridHeight, gridWidth, gridHeight));
        Graphics.Blit(buffers[read], buffers[write], golMaterial);

        // 把结果传给显示材质
        displayMaterial.SetTexture("_MainTex", buffers[write]);

        currentBuffer = write;
    }

    void OnDestroy()
    {
        foreach (var rt in buffers)
            if (rt != null) rt.Release();
    }
}
```

### Game of Life URP Shader

```hlsl
Shader "Custom/URP/GameOfLife"
{
    Properties
    {
        _PrevState ("Previous State", 2D) = "black" {}
        _AliveColor ("Alive Color", Color) = (0.2, 0.9, 0.4, 1)
        _DeadColor  ("Dead Color",  Color) = (0.05, 0.05, 0.1, 1)
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        Cull Off ZWrite Off ZTest Always

        Pass
        {
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
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

            TEXTURE2D(_PrevState);
            SAMPLER(sampler_PrevState);

            CBUFFER_START(UnityPerMaterial)
                float4 _PrevState_ST;
                float4 _TexelSize;   // x=1/w, y=1/h, z=w, w=h
                float4 _AliveColor;
                float4 _DeadColor;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = IN.uv;
                return OUT;
            }

            // 采样邻居状态（周期性边界）
            float SampleCell(float2 uv, float2 offset)
            {
                float2 sampleUV = frac(uv + offset * _TexelSize.xy);
                return SAMPLE_TEXTURE2D(_PrevState, sampler_PrevState, sampleUV).r > 0.5 ? 1.0 : 0.0;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.uv;
                float current = SampleCell(uv, float2(0, 0));

                // 统计 8 邻居存活数
                float neighbors = 0;
                neighbors += SampleCell(uv, float2(-1, -1));
                neighbors += SampleCell(uv, float2( 0, -1));
                neighbors += SampleCell(uv, float2( 1, -1));
                neighbors += SampleCell(uv, float2(-1,  0));
                neighbors += SampleCell(uv, float2( 1,  0));
                neighbors += SampleCell(uv, float2(-1,  1));
                neighbors += SampleCell(uv, float2( 0,  1));
                neighbors += SampleCell(uv, float2( 1,  1));

                // Conway's Game of Life 规则
                // 存活：邻居 2 或 3 → 继续存活
                // 死亡：邻居 3 → 复活
                float alive = 0.0;
                if (current > 0.5)
                    alive = (neighbors == 2.0 || neighbors == 3.0) ? 1.0 : 0.0;
                else
                    alive = (neighbors == 3.0) ? 1.0 : 0.0;

                // 输出视觉颜色（R 通道存活状态用于下一帧读取）
                half4 col = lerp(_DeadColor, _AliveColor, alive);
                col.r = alive; // 保证 R 通道精确存储状态
                return col;
            }
            ENDHLSL
        }
    }
}
```

## 实战示例二：屏幕空间轨迹拖尾效果

将当前帧叠加到上一帧，并每帧淡出，产生运动轨迹。

```hlsl
Shader "Custom/URP/ScreenTrail"
{
    Properties
    {
        _MainTex    ("Current Frame",   2D) = "black" {}
        _PrevFrame  ("Previous Frame",  2D) = "black" {}
        _FadeSpeed  ("Fade Speed",      Range(0.01, 0.5)) = 0.05
        _BlendMode  ("Blend Strength",  Range(0, 1)) = 0.92
        _GlowColor  ("Glow Tint",       Color) = (1, 0.6, 0.2, 1)
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        Cull Off ZWrite Off ZTest Always

        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float2 uv : TEXCOORD0; };

            TEXTURE2D(_MainTex);   SAMPLER(sampler_MainTex);
            TEXTURE2D(_PrevFrame); SAMPLER(sampler_PrevFrame);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float  _FadeSpeed;
                float  _BlendMode;
                float4 _GlowColor;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = IN.uv;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // 当前帧内容
                half4 current = SAMPLE_TEXTURE2D(_MainTex,   sampler_MainTex,   IN.uv);
                // 上一帧已累积的轨迹
                half4 prev    = SAMPLE_TEXTURE2D(_PrevFrame, sampler_PrevFrame, IN.uv);

                // 上一帧轨迹淡出（_BlendMode 越大，拖尾越长）
                half4 trail = prev * _BlendMode;

                // 当前帧内容叠加进轨迹（取亮度较高的部分）
                half4 result = max(current * _GlowColor, trail);

                // 防止无限累积（能量保守）
                result = saturate(result);
                return result;
            }
            ENDHLSL
        }
    }
}
```

对应的 C# 管理脚本：

```csharp
using UnityEngine;

[RequireComponent(typeof(Camera))]
public class ScreenTrailEffect : MonoBehaviour
{
    public Material trailMaterial;
    [Range(0.8f, 0.99f)] public float blendStrength = 0.92f;

    private RenderTexture accumBuffer;
    private RenderTexture tempBuffer;

    void OnRenderImage(RenderTexture src, RenderTexture dest)
    {
        // 延迟初始化，适配分辨率变化
        if (accumBuffer == null || accumBuffer.width != src.width)
        {
            if (accumBuffer != null) accumBuffer.Release();
            if (tempBuffer  != null) tempBuffer.Release();
            accumBuffer = new RenderTexture(src.width, src.height, 0, src.format);
            tempBuffer  = new RenderTexture(src.width, src.height, 0, src.format);
            accumBuffer.Create();
            tempBuffer.Create();
        }

        trailMaterial.SetTexture("_PrevFrame", accumBuffer);
        trailMaterial.SetFloat("_BlendMode", blendStrength);

        // 将当前帧 + 历史轨迹合成到 tempBuffer
        Graphics.Blit(src, tempBuffer, trailMaterial);
        // 更新历史缓冲
        Graphics.Blit(tempBuffer, accumBuffer);
        // 输出到屏幕
        Graphics.Blit(tempBuffer, dest);
    }

    void OnDestroy()
    {
        if (accumBuffer != null) accumBuffer.Release();
        if (tempBuffer  != null) tempBuffer.Release();
    }
}
```

## RTHandle 系统详解

URP 2021+ 推荐使用 `RTHandle` 代替裸 `RenderTexture`，主要优势：

1. **自动分辨率缩放**：配合 URP 的动态分辨率（DRS）自动调整大小
2. **统一的生命周期管理**：通过 `RTHandles` 分配器统一管理，避免内存泄漏
3. **与 `Blitter` API 集成**：`Blitter.BlitCameraTexture` 正确处理平台差异（Metal Y 轴翻转等）

```csharp
// RTHandle 标准使用模式
private RTHandle m_SimBuffer0;
private RTHandle m_SimBuffer1;

public override void OnCameraSetup(CommandBuffer cmd, ref RenderingData renderingData)
{
    var desc = renderingData.cameraData.cameraTargetDescriptor;
    desc.colorFormat = RenderTextureFormat.ARGBFloat;
    desc.depthBufferBits = 0;

    // RenderingUtils.ReAllocateIfNeeded 只在尺寸变化时重新分配，避免每帧 GC
    RenderingUtils.ReAllocateIfNeeded(ref m_SimBuffer0, desc, FilterMode.Bilinear, name: "SimBuffer0");
    RenderingUtils.ReAllocateIfNeeded(ref m_SimBuffer1, desc, FilterMode.Bilinear, name: "SimBuffer1");
}
```

## 游戏实际应用场景

| 效果 | Ping-Pong 数据 | 用途 |
|------|---------------|------|
| 流体/烟雾模拟 | 速度场 + 密度场 | 环境特效 |
| 布料模拟 | 顶点位置 + 速度 | 角色服装 |
| 屏幕空间轨迹 | 累积颜色帧 | 子弹时间、粒子拖尾 |
| TAA 抗锯齿 | 历史颜色帧 | 画质提升 |
| 动态阴影图 | 阴影累积贴图 | 软阴影优化 |
| 反应扩散 | 化学浓度 AB | 有机纹理生成 |

## 性能考量

- **格式选择**：物理模拟用 `ARGBFloat`，纯显示用 `ARGBAHalf`，节省 50% 显存带宽
- **分辨率降采样**：模拟缓冲可以用屏幕分辨率的 1/2 或 1/4，显示时双线性放大，效果差异极小
- **Mobile 注意**：`ARGBFloat` 在部分 Mali GPU 上不支持作为 RT，需要降级为 `ARGBHalf`
- **避免每帧 `new RenderTexture`**：使用 `RenderingUtils.ReAllocateIfNeeded` 或缓存 RT 对象
- **RTHandle vs 裸 RenderTexture**：RTHandle 在 URP 中是标准，裸 RenderTexture 在管线内部使用可能产生时序问题

## ShaderGraph 实现思路

ShaderGraph 本身不支持 Ping-Pong（需要 C# 脚本管理 RT），但可以用于构建显示 Shader：

1. 在 C# 中管理 Ping-Pong RT，将结果通过 `Material.SetTexture` 传入
2. ShaderGraph 中添加 `Texture2D` 属性节点接收模拟结果
3. 连接到 `Sample Texture 2D` → 颜色/发光输出

模拟逻辑本身（需要读取上一帧）必须用 HLSL Shader 手写，ShaderGraph 无法表达自反馈逻辑。

多通道 Ping-Pong 是 Unity 中实现持久化 GPU 状态的核心工具，掌握它意味着你可以在 GPU 上运行完整的物理世界并无缝集成到 URP 渲染管线中。
