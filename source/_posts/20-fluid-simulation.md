---
title: Unity Shader 系列（二十）：Unity GPU 流体模拟实战：Compute Shader 与双缓冲
date: 2026-04-21 12:00:00
tags: [HLSL, URP, Compute Shader, 流体模拟, GPU物理]
---

GPU 流体模拟是 Unity 开发中技术深度最高的方向之一，也是游戏中实现交互式水面、墨水扩散、烟雾流动的核心技术。与 ShaderToy 的帧缓冲反馈不同，Unity 中的 GPU 流体模拟使用 **Compute Shader** + **RenderTexture Ping-Pong**：一个 Compute Shader 读取上一帧的流体状态，计算新状态写入另一张 RenderTexture，然后通过 URP Renderer Feature 将结果可视化。本文提供完整的可交互 2D 流体模拟实现，包括 Compute Shader、C# 控制脚本和 URP 可视化 Shader。

## Unity Compute Shader 基础

Compute Shader 是在 GPU 上并行运行的通用计算程序，不依附于渲染流程。在 Unity 中：

- 文件扩展名：`.compute`
- 着色器类型：不是渲染着色器，是 GPGPU（通用 GPU 计算）
- 主要数据类型：`RWTexture2D`（可读写纹理）、`RWStructuredBuffer`（可读写结构体缓冲）
- 调用方式：`computeShader.Dispatch(kernelIndex, threadGroupsX, threadGroupsY, threadGroupsZ)`

```hlsl
// Compute Shader 基本结构
#pragma kernel CSMain  // 声明一个 Compute Kernel（入口函数）

// 可读写纹理（类似 RWTexture2D 的格式必须与 C# 侧的 RenderTextureFormat 匹配）
RWTexture2D<float4> _Result;   // 写入缓冲
Texture2D<float4>   _Source;   // 只读源缓冲

uint2 _Resolution;  // 纹理分辨率

// 每个线程组 8×8 个线程（可根据 GPU 特性调整，通常 8×8 或 16×16）
[numthreads(8, 8, 1)]
void CSMain(uint3 id : SV_DispatchThreadID)
{
    // id.xy：当前线程的全局坐标（像素坐标）
    if (id.x >= _Resolution.x || id.y >= _Resolution.y) return;

    float4 current = _Source[id.xy];
    // ...处理 current...
    _Result[id.xy] = current;
}
```

## 双缓冲（Ping-Pong）架构

流体模拟需要同时读取上一帧状态和写入新状态，这在同一张纹理上无法实现（读写冲突）。**Ping-Pong 双缓冲**使用两张交替的 RenderTexture 解决这个问题：

```csharp
// C# 中创建双缓冲 RenderTexture
private RenderTexture[] _pingPongBuffer = new RenderTexture[2];
private int _currentBuffer = 0;

void CreateBuffers(int width, int height)
{
    for (int i = 0; i < 2; i++)
    {
        _pingPongBuffer[i] = new RenderTexture(width, height, 0,
            RenderTextureFormat.ARGBFloat,  // 32位浮点（存储速度和密度）
            RenderTextureReadWrite.Linear
        );
        _pingPongBuffer[i].enableRandomWrite = true;  // 允许 Compute Shader 写入
        _pingPongBuffer[i].filterMode = FilterMode.Bilinear;
        _pingPongBuffer[i].wrapMode   = TextureWrapMode.Clamp;
        _pingPongBuffer[i].Create();
    }
}

void SimulateStep()
{
    int read  = _currentBuffer;
    int write = 1 - _currentBuffer;

    // 读取 read 缓冲，写入 write 缓冲
    _computeShader.SetTexture(kernelID, "_Source", _pingPongBuffer[read]);
    _computeShader.SetTexture(kernelID, "_Result", _pingPongBuffer[write]);
    _computeShader.Dispatch(kernelID, ...);

    // 交换缓冲
    _currentBuffer = write;
}
```

## 完整流体模拟 Compute Shader

这是核心的流体计算 Shader，实现 2D 欧拉流体模拟（Navier-Stokes 方程的简化实现）：

```hlsl
// FluidSimulation.compute

#pragma kernel InitFluid      // 初始化
#pragma kernel AdvectVelocity  // 速度平流
#pragma kernel DiffuseVelocity // 速度扩散
#pragma kernel PressureSolve   // 压力求解
#pragma kernel ProjectVelocity // 速度投影（确保不可压缩）
#pragma kernel AdvectDye       // 染料（可视化用）平流
#pragma kernel AddForce        // 外力注入

// ---- 数据布局 ----
// velocity: .xy = 速度 (vx, vy), .z = 压力, .w = 染料浓度

RWTexture2D<float4> _Result;
Texture2D<float4>   _Source;
Texture2D<float4>   _PressureField;  // 独立的压力缓冲（Jacobi 迭代用）

uint2   _Resolution;
float   _DeltaTime;
float   _Viscosity;       // 运动黏度
float   _DyeDiffusion;   // 染料扩散系数
float   _VorticityStr;   // 涡旋限制强度

// 外力参数（由 C# 每帧传入）
float2  _ForcePos;        // 外力作用位置（像素坐标）
float2  _ForceDir;        // 外力方向和强度
float   _ForceRadius;     // 外力影响半径
float2  _DyeSource;       // 染料注入位置
float   _DyeAmount;       // 染料注入量

SamplerState sampler_linear_clamp;  // 双线性采样，钳制边界

// 安全的纹理采样（带边界检测）
float4 SampleField(Texture2D<float4> field, float2 pos)
{
    float2 uv = (pos + 0.5) / float2(_Resolution);
    return field.SampleLevel(sampler_linear_clamp, uv, 0);
}

// 从像素坐标获取场值（整数寻址）
float4 GetField(Texture2D<float4> field, int2 pos)
{
    // 边界处理：速度为零（无滑边界条件）
    int2 clamped = clamp(pos, int2(0, 0), int2(_Resolution) - 1);
    return field[clamped];
}

// ---- 初始化 ----
[numthreads(8, 8, 1)]
void InitFluid(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= _Resolution)) return;
    // 初始状态：极小噪声（打破对称性）
    float noise = frac(sin(dot(float2(id.xy), float2(12.9898, 78.233))) * 43758.5);
    _Result[id.xy] = float4(0, 0, 1.0, 0) + float4(noise, noise, 0, 0) * 0.0001;
}

// ---- 半拉格朗日平流（速度）----
// 逆向追踪：从当前位置沿负速度方向采样上一帧的值
// 无条件稳定，即使 dt 较大也不会发散
[numthreads(8, 8, 1)]
void AdvectVelocity(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= _Resolution)) return;

    float2 pos = float2(id.xy);
    float4 curr = _Source[id.xy];

    // 逆向追踪位置（从当前位置沿速度方向回溯）
    float2 prevPos = pos - _DeltaTime * curr.xy;

    // 在上游位置插值采样
    float4 advected = SampleField(_Source, prevPos);
    _Result[id.xy] = float4(advected.xy, curr.z, curr.w);  // 更新速度，保留压力
}

// ---- 黏性扩散（显式差分，速度扩散）----
[numthreads(8, 8, 1)]
void DiffuseVelocity(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= _Resolution)) return;

    int2  p = int2(id.xy);
    float4 c = _Source[p];
    float4 n = GetField(_Source, p + int2(0, 1));
    float4 s = GetField(_Source, p - int2(0, 1));
    float4 e = GetField(_Source, p + int2(1, 0));
    float4 w = GetField(_Source, p - int2(1, 0));

    // Laplacian（中心差分）
    float4 laplacian = n + s + e + w - 4.0 * c;

    // 显式黏性扩散
    float2 newVel = c.xy + _DeltaTime * _Viscosity * laplacian.xy;

    _Result[p] = float4(newVel, c.z, c.w);
}

// ---- 压力 Jacobi 迭代（一次迭代，需要多次 Dispatch 调用收敛）----
[numthreads(8, 8, 1)]
void PressureSolve(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= _Resolution)) return;

    int2  p   = int2(id.xy);
    float4 c  = _Source[p];
    float4 n  = GetField(_Source, p + int2(0, 1));
    float4 s  = GetField(_Source, p - int2(0, 1));
    float4 e  = GetField(_Source, p + int2(1, 0));
    float4 w  = GetField(_Source, p - int2(1, 0));

    // 速度散度（不可压缩约束）
    float divV = 0.5 * ((e.x - w.x) + (n.y - s.y));

    // Jacobi 迭代：p_new = (p_n + p_s + p_e + p_w - divV) / 4
    float newPressure = (n.z + s.z + e.z + w.z - divV) * 0.25;

    _Result[p] = float4(c.xy, newPressure, c.w);
}

// ---- 速度投影（减去压力梯度，确保 div(v)=0）----
[numthreads(8, 8, 1)]
void ProjectVelocity(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= _Resolution)) return;

    int2  p = int2(id.xy);
    float4 c = _Source[p];
    float4 n = GetField(_Source, p + int2(0, 1));
    float4 s = GetField(_Source, p - int2(0, 1));
    float4 e = GetField(_Source, p + int2(1, 0));
    float4 w = GetField(_Source, p - int2(1, 0));

    // 压力梯度
    float gradPx = 0.5 * (e.z - w.z);
    float gradPy = 0.5 * (n.z - s.z);

    // 从速度中减去压力梯度
    float2 projectedVel = c.xy - float2(gradPx, gradPy);

    // 涡旋限制（Vorticity Confinement）
    // 旋度场：curl = dVy/dx - dVx/dy
    float curlC = 0.5 * ((e.y - w.y) - (n.x - s.x));
    float curlN = 0.5 * ((GetField(_Source, p + int2(1,1)).y - GetField(_Source, p + int2(-1,1)).y)
                         - (GetField(_Source, p + int2(0,2)).x - c.x));
    float curlS = 0.5 * ((GetField(_Source, p + int2(1,-1)).y - GetField(_Source, p + int2(-1,-1)).y)
                         - (c.x - GetField(_Source, p + int2(0,-2)).x));
    float curlE = 0.5 * ((GetField(_Source, p + int2(2,0)).y - c.y)
                         - (GetField(_Source, p + int2(1,1)).x - GetField(_Source, p + int2(1,-1)).x));
    float curlW = 0.5 * ((c.y - GetField(_Source, p + int2(-2,0)).y)
                         - (GetField(_Source, p + int2(-1,1)).x - GetField(_Source, p + int2(-1,-1)).x));

    // 涡旋力方向（梯度指向旋度最大的方向）
    float2 eta = normalize(float2(abs(curlE) - abs(curlW), abs(curlN) - abs(curlS)) + 1e-5);
    projectedVel += _DeltaTime * _VorticityStr * float2(eta.y, -eta.x) * curlC;

    // 无滑边界（边缘速度为零）
    if (p.x == 0 || p.y == 0 || p.x == (int)_Resolution.x - 1 || p.y == (int)_Resolution.y - 1)
        projectedVel = float2(0, 0);

    _Result[p] = float4(projectedVel, c.z, c.w);
}

// ---- 染料平流（可视化用）----
[numthreads(8, 8, 1)]
void AdvectDye(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= _Resolution)) return;

    float2 pos  = float2(id.xy);
    float4 curr = _Source[id.xy];
    float2 prevPos = pos - _DeltaTime * curr.xy;
    float  advDye  = SampleField(_Source, prevPos).w;

    // 染料扩散衰减
    advDye *= exp(-_DeltaTime * _DyeDiffusion);

    // 染料注入（自动发射源）
    float2 diff = pos - _DyeSource;
    float  inject = exp(-dot(diff, diff) / (_ForceRadius * _ForceRadius)) * _DyeAmount;
    advDye += inject;

    _Result[id.xy] = float4(curr.xy, curr.z, saturate(advDye));
}

// ---- 外力注入（鼠标交互或自动发射）----
[numthreads(8, 8, 1)]
void AddForce(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= _Resolution)) return;

    float4 curr = _Source[id.xy];
    float2 pos  = float2(id.xy);

    // 高斯衰减的力场
    float2 diff     = pos - _ForcePos;
    float  influence = exp(-dot(diff, diff) / (_ForceRadius * _ForceRadius));

    float2 newVel = curr.xy + influence * _ForceDir * _DeltaTime;

    _Result[id.xy] = float4(newVel, curr.z, curr.w);
}
```

## C# 流体模拟控制器

```csharp
using UnityEngine;
using UnityEngine.Rendering;
using System.Collections.Generic;

[RequireComponent(typeof(Renderer))]
public class FluidSimulator : MonoBehaviour
{
    [Header("模拟参数")]
    [SerializeField] private int resolution = 512;
    [SerializeField] private float viscosity = 0.5f;
    [SerializeField] private float dyeDiffusion = 0.1f;
    [SerializeField] private float vorticityStrength = 0.035f;
    [SerializeField] private int pressureIterations = 20;  // Jacobi 迭代次数
    [SerializeField] private float timeStep = 0.15f;

    [Header("Compute Shader")]
    [SerializeField] private ComputeShader fluidCompute;

    [Header("可视化")]
    [SerializeField] private Material visualizeMaterial;

    [Header("交互")]
    [SerializeField] private float forceRadius = 30f;
    [SerializeField] private float forceStrength = 3.0f;
    [SerializeField] private float dyeInjectAmount = 2.0f;

    // 双缓冲
    private RenderTexture[] _pingPong = new RenderTexture[2];
    private int _current = 0;

    // Kernel 索引
    private int _kernelInit;
    private int _kernelAdvectVel;
    private int _kernelDiffuseVel;
    private int _kernelPressure;
    private int _kernelProject;
    private int _kernelAdvectDye;
    private int _kernelAddForce;

    // 线程组数量
    private int _threadGroupsX, _threadGroupsY;

    // 自动发射源（无鼠标交互时也有流动）
    private float _autoSourceTimer = 0;
    private Vector2 _autoSourcePos;
    private Vector2 _autoSourceVel;

    // Property IDs
    private static readonly int SourceID       = Shader.PropertyToID("_Source");
    private static readonly int ResultID       = Shader.PropertyToID("_Result");
    private static readonly int ResolutionID   = Shader.PropertyToID("_Resolution");
    private static readonly int DeltaTimeID    = Shader.PropertyToID("_DeltaTime");
    private static readonly int ViscosityID    = Shader.PropertyToID("_Viscosity");
    private static readonly int DyeDiffID      = Shader.PropertyToID("_DyeDiffusion");
    private static readonly int VortStrID      = Shader.PropertyToID("_VorticityStr");
    private static readonly int ForcePosID     = Shader.PropertyToID("_ForcePos");
    private static readonly int ForceDirID     = Shader.PropertyToID("_ForceDir");
    private static readonly int ForceRadID     = Shader.PropertyToID("_ForceRadius");
    private static readonly int DyeSourceID    = Shader.PropertyToID("_DyeSource");
    private static readonly int DyeAmountID    = Shader.PropertyToID("_DyeAmount");
    private static readonly int FluidTexID     = Shader.PropertyToID("_FluidTex");

    void Start()
    {
        // 获取 Kernel 索引
        _kernelInit      = fluidCompute.FindKernel("InitFluid");
        _kernelAdvectVel = fluidCompute.FindKernel("AdvectVelocity");
        _kernelDiffuseVel = fluidCompute.FindKernel("DiffuseVelocity");
        _kernelPressure  = fluidCompute.FindKernel("PressureSolve");
        _kernelProject   = fluidCompute.FindKernel("ProjectVelocity");
        _kernelAdvectDye = fluidCompute.FindKernel("AdvectDye");
        _kernelAddForce  = fluidCompute.FindKernel("AddForce");

        // 线程组数量（每个线程组 8×8 个线程）
        _threadGroupsX = Mathf.CeilToInt(resolution / 8.0f);
        _threadGroupsY = Mathf.CeilToInt(resolution / 8.0f);

        // 创建 RenderTexture
        for (int i = 0; i < 2; i++)
        {
            _pingPong[i] = new RenderTexture(resolution, resolution, 0,
                RenderTextureFormat.ARGBFloat);
            _pingPong[i].enableRandomWrite = true;
            _pingPong[i].filterMode = FilterMode.Bilinear;
            _pingPong[i].Create();
        }

        // 初始化
        SetCommonUniforms();
        fluidCompute.SetTexture(_kernelInit, ResultID, _pingPong[_current]);
        fluidCompute.Dispatch(_kernelInit, _threadGroupsX, _threadGroupsY, 1);

        // 设置可视化材质
        if (visualizeMaterial != null)
            visualizeMaterial.SetTexture(FluidTexID, _pingPong[_current]);
    }

    void SetCommonUniforms()
    {
        fluidCompute.SetInts(ResolutionID, resolution, resolution);
        fluidCompute.SetFloat(DeltaTimeID, timeStep);
        fluidCompute.SetFloat(ViscosityID, viscosity);
        fluidCompute.SetFloat(DyeDiffID, dyeDiffusion);
        fluidCompute.SetFloat(VortStrID, vorticityStrength);
    }

    void FixedUpdate()
    {
        SetCommonUniforms();
        UpdateAutoSource();

        // ---- 外力注入 ----
        AddForceStep();

        // ---- 速度平流 ----
        Swap();
        Dispatch(_kernelAdvectVel);

        // ---- 速度扩散 ----
        Swap();
        Dispatch(_kernelDiffuseVel);

        // ---- 压力求解（Jacobi 迭代多次）----
        for (int i = 0; i < pressureIterations; i++)
        {
            Swap();
            Dispatch(_kernelPressure);
        }

        // ---- 速度投影 ----
        Swap();
        Dispatch(_kernelProject);

        // ---- 染料平流 ----
        Swap();
        fluidCompute.SetFloats(DyeSourceID, _autoSourcePos.x, _autoSourcePos.y);
        fluidCompute.SetFloat(DyeAmountID, dyeInjectAmount * Time.fixedDeltaTime);
        Dispatch(_kernelAdvectDye);

        // 更新可视化材质
        if (visualizeMaterial != null)
            visualizeMaterial.SetTexture(FluidTexID, _pingPong[_current]);
    }

    void AddForceStep()
    {
        Vector2 forcePos = _autoSourcePos;
        Vector2 forceDir = _autoSourceVel * forceStrength;

        // 鼠标/触摸交互（如果有）
        if (Input.GetMouseButton(0))
        {
            Ray ray = Camera.main.ScreenPointToRay(Input.mousePosition);
            Plane plane = new Plane(transform.forward, transform.position);
            if (plane.Raycast(ray, out float enter))
            {
                Vector3 hitLocal = transform.InverseTransformPoint(ray.GetPoint(enter));
                // 将本地坐标映射到纹理坐标
                forcePos = new Vector2(
                    (hitLocal.x + 0.5f) * resolution,
                    (hitLocal.y + 0.5f) * resolution
                );
                forceDir = Vector2.zero; // 鼠标按下时只注入染料，不施加速度
            }
        }

        fluidCompute.SetTexture(_kernelAddForce, SourceID, _pingPong[_current]);
        fluidCompute.SetTexture(_kernelAddForce, ResultID, _pingPong[1 - _current]);
        fluidCompute.SetFloats(ForcePosID, forcePos.x, forcePos.y);
        fluidCompute.SetFloats(ForceDirID, forceDir.x, forceDir.y);
        fluidCompute.SetFloat(ForceRadID, forceRadius);
        fluidCompute.Dispatch(_kernelAddForce, _threadGroupsX, _threadGroupsY, 1);
        _current = 1 - _current;
    }

    void UpdateAutoSource()
    {
        // 在屏幕上随机游走的自动力源（无鼠标时也有流动）
        _autoSourceTimer += Time.fixedDeltaTime;
        float t = _autoSourceTimer;
        _autoSourcePos = new Vector2(
            resolution * (0.5f + 0.3f * Mathf.Sin(t * 0.7f)),
            resolution * (0.5f + 0.3f * Mathf.Cos(t * 0.9f))
        );
        _autoSourceVel = new Vector2(Mathf.Cos(t), Mathf.Sin(t * 1.3f));
    }

    void Swap()
    {
        int read  = _current;
        int write = 1 - _current;
        _current  = write; // 切换当前缓冲
        // 调用 Dispatch 时再设置 Source 和 Result
    }

    void Dispatch(int kernel)
    {
        int read  = 1 - _current; // Swap 后，当前写缓冲是 _current，读缓冲是另一个
        fluidCompute.SetTexture(kernel, SourceID, _pingPong[read]);
        fluidCompute.SetTexture(kernel, ResultID, _pingPong[_current]);
        fluidCompute.Dispatch(kernel, _threadGroupsX, _threadGroupsY, 1);
    }

    void OnDestroy()
    {
        foreach (var rt in _pingPong)
            if (rt != null) rt.Release();
    }
}
```

## URP 可视化 Shader

将流体数据渲染为彩色染料效果：

```hlsl
Shader "Custom/URP/FluidVisualize"
{
    Properties
    {
        _FluidTex ("流体数据纹理", 2D) = "black" {}
        _VelocityColorA ("速度颜色A", Color) = (0.8, 0.2, 0.5, 1)
        _VelocityColorB ("速度颜色B", Color) = (0.2, 0.6, 1.0, 1)
        _DyeColor ("染料颜色", Color) = (1, 0.5, 0.1, 1)
        _Background ("背景颜色", Color) = (0.02, 0.02, 0.04, 1)
        _VelScale ("速度可视化缩放", Range(0.1, 5)) = 1.0
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }

        Pass
        {
            Name "FluidVis"
            Tags { "LightMode"="UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_FluidTex); SAMPLER(sampler_FluidTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _FluidTex_ST;
                float4 _VelocityColorA;
                float4 _VelocityColorB;
                float4 _DyeColor;
                float4 _Background;
                float  _VelScale;
            CBUFFER_END

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float2 uv : TEXCOORD0; };

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv          = TRANSFORM_TEX(input.uv, _FluidTex);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float4 fluid = SAMPLE_TEXTURE2D(_FluidTex, sampler_FluidTex, input.uv);

                // 速度方向映射为色相
                float  velAngle = atan2(fluid.y, fluid.x);  // -π 到 π
                float3 velColor = 0.5 + 0.5 * cos(velAngle + float3(0, 2.094, 4.189));  // RGB 色轮
                velColor        = lerp(_VelocityColorA.rgb, _VelocityColorB.rgb,
                                      velAngle / (2.0 * 3.14159) + 0.5);

                // 速度大小
                float velMag = length(fluid.xy) * _VelScale;

                // 染料浓度
                float ink = smoothstep(0.0, 2.0, fluid.w);

                // 混合：背景 -> 速度颜色（由染料显示）
                float3 finalColor = lerp(_Background.rgb, velColor, ink);

                // 压力高光
                finalColor += float3(0.05, 0.05, 0.05) * saturate(fluid.z - 1.0);

                // 背景不能全黑（否则用户以为程序出错）
                finalColor = max(finalColor, _Background.rgb);

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## AsyncGPUReadback：CPU-GPU 数据同步

流体模拟有时需要在 CPU 端读取流体数据（例如：检测流体是否到达某个位置，触发游戏事件）。使用 `AsyncGPUReadback` 避免阻塞 GPU：

```csharp
using UnityEngine.Rendering;

// 异步读取流体数据（不阻塞 GPU）
void ReadFluidData()
{
    AsyncGPUReadback.Request(_pingPong[_current], 0, TextureFormat.RGBAFloat,
        (AsyncGPUReadbackRequest request) =>
        {
            if (request.hasError)
            {
                Debug.LogError("AsyncGPUReadback 失败");
                return;
            }

            // 在回调中处理数据（在主线程中调用）
            var data = request.GetData<Color>();

            // 示例：检测某位置的染料浓度
            int checkX = resolution / 2, checkY = resolution / 4;
            float inkAtPoint = data[checkY * resolution + checkX].a;

            if (inkAtPoint > 0.5f)
            {
                Debug.Log("检测到流体到达目标位置！");
                // 触发游戏事件...
            }
        }
    );
}
```

## 性能考量

| 分辨率 | GPU 内存 | 每帧时间（RTX 3060） | 适用场景 |
|--------|---------|---------------------|---------|
| 128×128 | ~0.3MB | ~0.1ms | 移动端 |
| 256×256 | ~1MB | ~0.3ms | 移动端高端/PC |
| 512×512 | ~4MB | ~1ms | PC 标准 |
| 1024×1024 | ~16MB | ~4ms | PC 高质量 |

**移动端注意**：
- 使用 `RenderTextureFormat.RGHalf`（16位双通道）代替 `ARGBFloat`，节省 75% 内存和带宽
- 将 pressureIterations 减少到 5-10
- 使用 64×64 或 128×128 分辨率

## 常见踩坑

**坑1：RenderTexture.enableRandomWrite 必须在 Create() 之前设置**
如果先调用 `rt.Create()` 再设置 `rt.enableRandomWrite = true`，RenderTexture 不会启用随机写入，Compute Shader 的 `RWTexture2D` 无法正常工作，报错 "Texture is not set"。

**坑2：Compute Shader 的线程组大小与分辨率**
`[numthreads(8, 8, 1)]` 意味着每个线程组处理 8×8=64 个像素。Dispatch 的参数 `(threadGroupsX, threadGroupsY, 1)` 中，`threadGroupsX = ceil(width / 8)`。如果分辨率不是 8 的整数倍，需要在 Compute Shader 开头检查 `if (any(id.xy >= _Resolution)) return`，防止越界写入。

**坑3：ARGBFloat vs ARGBHalf 的兼容性**
在 iOS（Metal）上，Compute Shader 的 `RWTexture2D<float4>` 对应 `ARGBFloat`，而 `ARGBHalf` 格式的 RenderTexture 在某些设备上不支持随机写入。如果需要跨平台，使用 `ARGBFloat` 更安全，或通过 `SystemInfo.SupportsRenderTextureFormat` 在运行时检测。

**坑4：Jacobi 迭代次数与稳定性**
压力求解的 Jacobi 迭代次数（pressureIterations）越多，流体不可压缩性越好，但性能越差。20 次迭代通常是质量/性能的合理平衡点。如果流体出现爆炸性发散（速度值变为 NaN），先检查 `clamp` 是否正确限制了速度范围。
