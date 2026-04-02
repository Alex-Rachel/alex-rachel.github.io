---
title: Unity Shader 系列（三十四）：Compute Shader 物理模拟——布料与粒子群
date: 2026-04-01 14:30:00
tags: [HLSL, URP, Compute Shader, 布料模拟, GPU物理]
categories:
  - Unity Shader 系列
  - GPU 计算与模拟
---

## 为什么用 Compute Shader 做物理？

Unity 自带的 PhysX 是 CPU 物理引擎，适合刚体碰撞检测，但处理**万级以上粒子或布料节点**时性能急剧下降。**Compute Shader** 让物理计算搬到 GPU 上并行执行：

- 1024 个线程组 × 64 线程/组 = **65536 个粒子**同时并行更新
- 数据常驻 GPU，无需 CPU→GPU 数据传输（除非需要读回）
- 与渲染 Shader 共享 `GraphicsBuffer`，无需格式转换

本篇实现两个完整示例：**GPU 布料模拟**（弹簧质点系统）和 **N-body 粒子群**（引力模拟），均包含 Compute Shader + 渲染 Shader + C# 控制脚本。

## Compute Shader 工作流基础

### 创建 Compute Shader

Project 窗口右键 → Create → Shader → Compute Shader，得到 `.compute` 文件。

```hlsl
// ClothSimulation.compute 基础结构
#pragma kernel UpdateCloth   // 声明一个 kernel 函数

// 数据缓冲：RWStructuredBuffer 可读可写
RWStructuredBuffer<float4> _Positions;  // xyz=位置, w=质量倒数（0=固定点）
RWStructuredBuffer<float4> _Velocities; // xyz=速度, w=未使用

// 常量（通过 C# 的 SetFloat/SetVector 传入）
float _DeltaTime;
float3 _Gravity;
float _Damping;

// 线程组大小（必须与 C# 的 Dispatch 调用匹配）
[numthreads(64, 1, 1)]
void UpdateCloth(uint3 id : SV_DispatchThreadID)
{
    uint idx = id.x;
    // ... 物理计算 ...
}
```

### C# 调用流程

```csharp
// 基本 Dispatch 模式
ComputeShader cs;
int kernelIndex = cs.FindKernel("UpdateCloth");

// 绑定缓冲
cs.SetBuffer(kernelIndex, "_Positions",  positionBuffer);
cs.SetBuffer(kernelIndex, "_Velocities", velocityBuffer);

// 设置参数
cs.SetFloat("_DeltaTime", Time.deltaTime);
cs.SetVector("_Gravity",  new Vector3(0, -9.8f, 0));

// 执行（particleCount / 64 个线程组，每组 64 线程）
cs.Dispatch(kernelIndex, Mathf.CeilToInt(particleCount / 64.0f), 1, 1);
```

### ComputeBuffer vs GraphicsBuffer

| 类型 | 用途 | 推荐场景 |
|------|------|---------|
| `ComputeBuffer` | Compute Shader 数据 | 旧版 API，Unity 2020 以前 |
| `GraphicsBuffer` | 同时用于 Compute + 渲染 | Unity 2021+，推荐 |
| `RWTexture2D` | 图像输出（写纹理） | 流体模拟、高度图生成 |

Unity 2021+ 推荐统一使用 `GraphicsBuffer`，它既可以作为 Compute Shader 的 `RWStructuredBuffer`，也可以直接作为渲染 Shader 的顶点/索引缓冲（`Graphics.DrawMeshInstancedIndirect`）。

## 实战示例一：GPU 布料模拟

### 数据结构设计

布料是一个 M×N 的质点网格，相邻质点之间用弹簧连接：
- 结构弹簧（Structural）：连接上下左右邻居，防止拉伸
- 剪切弹簧（Shear）：连接对角线邻居，防止剪切形变
- 弯曲弹簧（Bend）：连接间隔 2 的邻居，防止折叠

```csharp
// 质点数据（与 Compute Shader 中的结构体对应）
struct ClothParticle
{
    public Vector3 position;  // 当前位置
    public float   invMass;   // 质量倒数（0 = 固定不动）
    public Vector3 velocity;  // 当前速度
    public float   padding;   // 对齐到 32 字节
}
```

### Compute Shader：弹簧质点布料

```hlsl
// ClothSimulation.compute
#pragma kernel ApplyForces    // Step 1: 外力 + 弹簧力
#pragma kernel IntegratePos   // Step 2: 位置积分
#pragma kernel SolveConstraints // Step 3（可选）: 约束松弛

struct Particle
{
    float3 position;
    float  invMass;   // 0 = 固定点（悬挂点）
    float3 velocity;
    float  padding;
};

RWStructuredBuffer<Particle> _Particles;

int   _ClothWidth;   // 布料列数
int   _ClothHeight;  // 布料行数
float _DeltaTime;
float _Damping;      // 速度阻尼（0.98 左右）
float3 _Gravity;
float _SpringK;      // 弹簧刚度
float _RestLength;   // 弹簧自然长度（等于格子间距）
float3 _Wind;        // 风力

// 获取粒子索引（从网格坐标）
int GetIndex(int x, int y)
{
    x = clamp(x, 0, _ClothWidth - 1);
    y = clamp(y, 0, _ClothHeight - 1);
    return y * _ClothWidth + x;
}

// 弹簧力计算
float3 SpringForce(float3 posA, float3 posB, float restLen)
{
    float3 delta = posB - posA;
    float  dist  = length(delta);
    if (dist < 0.0001) return float3(0, 0, 0);
    // 胡克定律：F = k * (|Δx| - L₀) * 方向
    return _SpringK * (dist - restLen) * normalize(delta);
}

[numthreads(8, 8, 1)]
void ApplyForces(uint3 id : SV_DispatchThreadID)
{
    int x = (int)id.x;
    int y = (int)id.y;
    if (x >= _ClothWidth || y >= _ClothHeight) return;

    int idx = GetIndex(x, y);
    Particle p = _Particles[idx];

    // 固定点不受力影响
    if (p.invMass <= 0.0) return;

    float3 force = _Gravity / p.invMass; // F = mg
    force += _Wind; // 风力

    // ===== 结构弹簧（4 邻居）=====
    float3 pos = p.position;
    if (x > 0)             force += SpringForce(pos, _Particles[GetIndex(x-1, y)].position, _RestLength);
    if (x < _ClothWidth-1) force += SpringForce(pos, _Particles[GetIndex(x+1, y)].position, _RestLength);
    if (y > 0)             force += SpringForce(pos, _Particles[GetIndex(x, y-1)].position, _RestLength);
    if (y < _ClothHeight-1)force += SpringForce(pos, _Particles[GetIndex(x, y+1)].position, _RestLength);

    // ===== 剪切弹簧（4 对角）=====
    float diagRest = _RestLength * 1.41421; // sqrt(2)
    if (x > 0 && y > 0)              force += SpringForce(pos, _Particles[GetIndex(x-1, y-1)].position, diagRest);
    if (x < _ClothWidth-1 && y > 0)  force += SpringForce(pos, _Particles[GetIndex(x+1, y-1)].position, diagRest);
    if (x > 0 && y < _ClothHeight-1) force += SpringForce(pos, _Particles[GetIndex(x-1, y+1)].position, diagRest);
    if (x < _ClothWidth-1 && y < _ClothHeight-1) force += SpringForce(pos, _Particles[GetIndex(x+1, y+1)].position, diagRest);

    // ===== 弯曲弹簧（间隔 2）=====
    float bendRest = _RestLength * 2.0;
    if (x > 1)             force += SpringForce(pos, _Particles[GetIndex(x-2, y)].position, bendRest) * 0.3;
    if (x < _ClothWidth-2) force += SpringForce(pos, _Particles[GetIndex(x+2, y)].position, bendRest) * 0.3;
    if (y > 1)             force += SpringForce(pos, _Particles[GetIndex(x, y-2)].position, bendRest) * 0.3;
    if (y < _ClothHeight-2)force += SpringForce(pos, _Particles[GetIndex(x, y+2)].position, bendRest) * 0.3;

    // 速度更新（半隐式欧拉）
    p.velocity += force * p.invMass * _DeltaTime;
    p.velocity *= _Damping; // 阻尼

    _Particles[idx] = p;
}

[numthreads(8, 8, 1)]
void IntegratePos(uint3 id : SV_DispatchThreadID)
{
    int x = (int)id.x;
    int y = (int)id.y;
    if (x >= _ClothWidth || y >= _ClothHeight) return;

    int idx = GetIndex(x, y);
    Particle p = _Particles[idx];

    if (p.invMass <= 0.0) return; // 固定点

    // 位置积分
    p.position += p.velocity * _DeltaTime;

    // 简单地面碰撞（y > -5）
    if (p.position.y < -5.0)
    {
        p.position.y = -5.0;
        p.velocity.y = max(0, p.velocity.y); // 阻止穿透
        p.velocity.xz *= 0.9; // 摩擦力
    }

    _Particles[idx] = p;
}
```

### C# 控制脚本

```csharp
using UnityEngine;
using UnityEngine.Rendering;

public class GPUClothSimulation : MonoBehaviour
{
    [Header("布料参数")]
    public ComputeShader clothCS;
    public int   clothWidth   = 32;
    public int   clothHeight  = 32;
    public float restLength   = 0.1f;
    public float springK      = 500f;
    public float damping      = 0.98f;
    [Header("物理参数")]
    public Vector3 gravity    = new Vector3(0, -9.8f, 0);
    public Vector3 wind       = new Vector3(0.5f, 0, 0.3f);
    [Header("渲染")]
    public Material clothMaterial; // 用于渲染布料的 URP 材质

    private GraphicsBuffer particleBuffer;
    private GraphicsBuffer indexBuffer;
    private int applyForcesKernel;
    private int integratePosKernel;
    private int particleCount;

    struct ClothParticle
    {
        public Vector3 position;
        public float   invMass;
        public Vector3 velocity;
        public float   padding;
    }

    void Start()
    {
        particleCount = clothWidth * clothHeight;

        // 初始化粒子数据
        var particles = new ClothParticle[particleCount];
        for (int y = 0; y < clothHeight; y++)
        {
            for (int x = 0; x < clothWidth; x++)
            {
                int idx = y * clothWidth + x;
                particles[idx].position = new Vector3(
                    (x - clothWidth * 0.5f) * restLength,
                    0,
                    (y - clothHeight * 0.5f) * restLength
                );
                particles[idx].velocity = Vector3.zero;
                // 顶行固定（invMass = 0）
                particles[idx].invMass = (y == clothHeight - 1) ? 0f : 1f;
            }
        }

        // 创建 GPU 缓冲（GraphicsBuffer 可同时用于 Compute + 渲染）
        particleBuffer = new GraphicsBuffer(
            GraphicsBuffer.Target.Structured,
            particleCount,
            System.Runtime.InteropServices.Marshal.SizeOf<ClothParticle>()
        );
        particleBuffer.SetData(particles);

        // 生成三角形索引（用于渲染布料网格）
        var indices = GenerateClothIndices();
        indexBuffer = new GraphicsBuffer(
            GraphicsBuffer.Target.Index,
            indices.Length,
            sizeof(int)
        );
        indexBuffer.SetData(indices);

        // 获取 kernel 索引
        applyForcesKernel   = clothCS.FindKernel("ApplyForces");
        integratePosKernel  = clothCS.FindKernel("IntegratePos");
    }

    int[] GenerateClothIndices()
    {
        // 每个四边形由 2 个三角形组成
        int quadCount = (clothWidth - 1) * (clothHeight - 1);
        var indices = new int[quadCount * 6];
        int i = 0;
        for (int y = 0; y < clothHeight - 1; y++)
        {
            for (int x = 0; x < clothWidth - 1; x++)
            {
                int tl = y * clothWidth + x;
                int tr = tl + 1;
                int bl = tl + clothWidth;
                int br = bl + 1;
                // 三角形 1
                indices[i++] = tl; indices[i++] = bl; indices[i++] = tr;
                // 三角形 2
                indices[i++] = tr; indices[i++] = bl; indices[i++] = br;
            }
        }
        return indices;
    }

    void Update()
    {
        // 子步骤（提高稳定性：将 deltaTime 分成多个小步）
        int substeps = 4;
        float dt = Time.deltaTime / substeps;

        for (int s = 0; s < substeps; s++)
        {
            // 传递参数
            clothCS.SetBuffer(applyForcesKernel,  "_Particles", particleBuffer);
            clothCS.SetBuffer(integratePosKernel, "_Particles", particleBuffer);
            clothCS.SetInt("_ClothWidth",   clothWidth);
            clothCS.SetInt("_ClothHeight",  clothHeight);
            clothCS.SetFloat("_DeltaTime",  dt);
            clothCS.SetFloat("_Damping",    damping);
            clothCS.SetFloat("_SpringK",    springK);
            clothCS.SetFloat("_RestLength", restLength);
            clothCS.SetVector("_Gravity",   gravity);
            clothCS.SetVector("_Wind",      wind);

            // ApplyForces：8×8 线程组
            int groupX = Mathf.CeilToInt(clothWidth  / 8.0f);
            int groupY = Mathf.CeilToInt(clothHeight / 8.0f);
            clothCS.Dispatch(applyForcesKernel,  groupX, groupY, 1);
            clothCS.Dispatch(integratePosKernel, groupX, groupY, 1);
        }

        // 将粒子缓冲传给渲染材质
        clothMaterial.SetBuffer("_ParticleBuffer", particleBuffer);
        clothMaterial.SetInt("_ClothWidth", clothWidth);
    }

    void OnRenderObject()
    {
        if (clothMaterial == null || indexBuffer == null) return;
        // 使用 Graphics.DrawProceduralNow 渲染布料网格
        clothMaterial.SetPass(0);
        Graphics.DrawProceduralNow(MeshTopology.Triangles, indexBuffer, indexBuffer.count);
    }

    void OnDestroy()
    {
        particleBuffer?.Dispose();
        indexBuffer?.Dispose();
    }
}
```

### 布料渲染 Shader

```hlsl
Shader "Custom/URP/ClothRenderer"
{
    Properties
    {
        _ClothTex   ("Cloth Texture", 2D) = "white" {}
        _Color      ("Color", Color) = (0.8, 0.7, 0.6, 1)
        _Roughness  ("Roughness", Range(0, 1)) = 0.8
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        Cull Off // 双面渲染

        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #pragma target   4.5 // Compute Shader 需要至少 Shader Model 4.5
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            // 与 C# 结构体对应
            struct Particle
            {
                float3 position;
                float  invMass;
                float3 velocity;
                float  padding;
            };

            StructuredBuffer<Particle> _ParticleBuffer; // 只读（非 RW）
            int _ClothWidth;

            TEXTURE2D(_ClothTex); SAMPLER(sampler_ClothTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _Color;
                float  _Roughness;
            CBUFFER_END

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 positionWS  : TEXCOORD0;
                float3 normalWS    : TEXCOORD1;
                float2 uv          : TEXCOORD2;
            };

            Varyings vert(uint vertexID : SV_VertexID)
            {
                Varyings OUT;
                Particle p = _ParticleBuffer[vertexID];

                // 计算法线（通过相邻粒子的叉积）
                int x = vertexID % _ClothWidth;
                int y = vertexID / _ClothWidth;
                float3 right = _ParticleBuffer[clamp(y * _ClothWidth + x + 1, 0, _ClothWidth * 100)].position;
                float3 up    = _ParticleBuffer[clamp((y + 1) * _ClothWidth + x, 0, _ClothWidth * 100)].position;
                float3 normal = normalize(cross(right - p.position, up - p.position));

                OUT.positionHCS = TransformWorldToHClip(p.position);
                OUT.positionWS  = p.position;
                OUT.normalWS    = normal;
                // UV 基于网格坐标生成
                OUT.uv = float2(x / (float)(_ClothWidth - 1), y / (float)(_ClothWidth - 1));
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                half4 albedo = SAMPLE_TEXTURE2D(_ClothTex, sampler_ClothTex, IN.uv) * _Color;

                InputData inputData = (InputData)0;
                inputData.positionWS = IN.positionWS;
                inputData.normalWS   = normalize(IN.normalWS);
                inputData.viewDirectionWS = GetWorldSpaceNormalizeViewDir(IN.positionWS);
                inputData.shadowCoord = TransformWorldToShadowCoord(IN.positionWS);

                SurfaceData surfaceData = (SurfaceData)0;
                surfaceData.albedo     = albedo.rgb;
                surfaceData.smoothness = 1.0 - _Roughness;
                surfaceData.alpha      = 1.0;

                return UniversalFragmentPBR(inputData, surfaceData);
            }
            ENDHLSL
        }
    }
}
```

## 实战示例二：N-body 引力粒子群

适合制作星系、粒子群、魔法能量汇聚等效果。

```hlsl
// GravitySimulation.compute
#pragma kernel UpdateGravity

struct Particle
{
    float3 position;
    float  mass;
    float3 velocity;
    float  padding;
};

RWStructuredBuffer<Particle> _Particles;
int   _ParticleCount;
float _DeltaTime;
float _G;           // 引力常数（游戏中通常调小，如 0.01）
float _Softening;   // 软化参数（防止近距离引力无穷大）
float3 _AttractorPos; // 中心吸引体位置

[numthreads(64, 1, 1)]
void UpdateGravity(uint3 id : SV_DispatchThreadID)
{
    uint i = id.x;
    if (i >= (uint)_ParticleCount) return;

    Particle pi = _Particles[i];
    float3 force = float3(0, 0, 0);

    // 中心吸引力（玩家飞船/星球）
    float3 toCenter = _AttractorPos - pi.position;
    float distSq = dot(toCenter, toCenter) + _Softening * _Softening;
    force += _G * 100.0 * normalize(toCenter) / distSq;

    // N-body 相互引力（O(N²)，N < 512 时可接受）
    // 注意：此循环在 GPU 上并行运行，每个线程计算自己受到的合力
    for (int j = 0; j < _ParticleCount; j++)
    {
        if (j == (int)i) continue;
        Particle pj = _Particles[j];
        float3 delta = pj.position - pi.position;
        float distSq2 = dot(delta, delta) + _Softening * _Softening;
        // F = G * mi * mj / r² * 方向
        force += _G * pj.mass * normalize(delta) / distSq2;
    }

    // 速度韦莱（Verlet）积分
    pi.velocity += force / pi.mass * _DeltaTime;
    pi.velocity *= 0.999; // 轻微阻尼防止能量发散
    pi.position += pi.velocity * _DeltaTime;

    _Particles[i] = pi;
}
```

## Burst ECS vs GPU Compute 的边界

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| < 1000 粒子，需要精确碰撞 | Burst + ECS | CPU 逻辑控制更灵活 |
| 1000~100000 粒子，视觉效果为主 | Compute Shader | GPU 并行效率高 |
| > 100000 粒子 | Compute + Indirect Rendering | 完全 GPU 化 |
| 布料（需要与角色骨骼互动） | 混合：CPU 骨骼 + GPU 布料 | 数据同步在关键帧 |
| 流体模拟 | Compute + RWTexture2D | 纹理读写更适合流场 |

## Graphics.DrawMeshInstancedIndirect 渲染大量粒子

对于超大量粒子（>100k），使用 Indirect Rendering 完全避免 CPU 逐粒子 DrawCall：

```csharp
// 准备 Indirect 参数缓冲
uint[] indirectArgs = new uint[] {
    (uint)particleMesh.GetIndexCount(0),  // 每个实例的索引数
    (uint)particleCount,                   // 实例数量
    (uint)particleMesh.GetIndexStart(0),   // 起始索引
    (uint)particleMesh.GetBaseVertex(0),   // 基础顶点
    0                                      // 起始实例
};
argsBuffer = new ComputeBuffer(1, 5 * sizeof(uint), ComputeBufferType.IndirectArguments);
argsBuffer.SetData(indirectArgs);

// 每帧渲染（零 CPU Draw Call 开销）
void Update()
{
    particleMaterial.SetBuffer("_ParticleBuffer", particleBuffer);
    Graphics.DrawMeshInstancedIndirect(
        particleMesh, 0, particleMaterial,
        new Bounds(Vector3.zero, Vector3.one * 1000),
        argsBuffer
    );
}
```

## 性能考量

- **线程组大小**：布料用 `[numthreads(8,8,1)]`（适合 2D 网格），粒子用 `[numthreads(64,1,1)]`（适合 1D 数组）。线程数应是 32 或 64 的倍数以对齐 Warp/Wavefront
- **Bank Conflict**：避免多个线程同时访问同一内存 Bank。使用 `SV_GroupIndex` 而非全局 ID 做共享内存寻址时要注意偏移
- **子步骤**：布料等刚性弹簧系统每帧需要 4-8 个子步骤以保证稳定，时间步长 `dt = Time.deltaTime / substeps`
- **Mobile 限制**：`ComputeShader` 需要 OpenGL ES 3.1+ 或 Vulkan/Metal，iOS 需要 Metal（A7 芯片以上支持）。发布移动端前务必通过 `SystemInfo.supportsComputeShaders` 检查

Compute Shader 是 Unity 游戏特效中最强大也最复杂的工具，掌握它之后，你可以在 GPU 上运行完整的物理世界，而 CPU 只需在每帧发出一个 Dispatch 命令。
