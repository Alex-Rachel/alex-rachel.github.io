---
title: Unity Shader 系列（三）：URP 矩阵变换体系 — 坐标空间与顶点动画
date: 2026-04-01 09:20:00
tags: [HLSL, URP, 矩阵变换, 坐标空间, 顶点动画]
---

## Unity 矩阵体系：为什么与 OpenGL 不同？

很多从 ShaderToy/WebGL 转来的开发者在写第一个 Unity Shader 时都会困惑：矩阵乘法怎么和教科书上不一样？这是因为 Unity 的矩阵体系有几个关键特点需要先理解：

1. **行主序（Row-Major）**：Unity HLSL 的矩阵是行主序，`UNITY_MATRIX_M[0]` 是第一行而不是第一列
2. **左手坐标系**：Unity 世界空间使用左手系，Z 轴朝前（而 OpenGL 是右手系，Z 轴朝后）
3. **NDC 深度范围**：Unity DX11/Metal 的 NDC Z 是 [0,1]，而 OpenGL 是 [-1,1]
4. **mul 乘法顺序**：`mul(UNITY_MATRIX_MVP, vertex)` 中向量作为列向量（右乘）

这些差异是历史遗留的，URP 通过 `Core.hlsl` 提供了一系列封装函数，**不建议直接操作矩阵**，而是调用 `TransformObjectToHClip` 等函数。

## 坐标空间变换链

Unity 渲染管线中，一个顶点从模型到屏幕经历以下变换：

```
Object Space (OS)   → 模型自身的局部坐标系
    ↓ UNITY_MATRIX_M（模型矩阵）
World Space (WS)    → 世界坐标系（Y 轴朝上，左手系）
    ↓ UNITY_MATRIX_V（视图矩阵）
View Space (VS)     → 相机坐标系（相机在原点，Z 轴朝后）
    ↓ UNITY_MATRIX_P（投影矩阵）
Clip Space (CS)     → 裁剪空间 [-w, w]
    ↓ 透视除法（GPU 自动）
NDC Space           → 归一化设备坐标 [-1,1] x [-1,1] x [0,1]（DX）
    ↓ 视口变换（GPU 自动）
Screen Space (SS)   → 像素坐标 [0, width] x [0, height]
```

URP 的 `Core.hlsl` 提供了对应的变换函数：

| 变换 | URP 函数 | 等价矩阵操作 |
|------|---------|------------|
| OS → CS（顶点着色器标准操作） | `TransformObjectToHClip(posOS)` | `mul(UNITY_MATRIX_MVP, float4(pos,1))` |
| OS → WS | `TransformObjectToWorld(posOS)` | `mul(UNITY_MATRIX_M, float4(pos,1)).xyz` |
| WS → CS | `TransformWorldToHClip(posWS)` | `mul(UNITY_MATRIX_VP, float4(pos,1))` |
| OS → WS（法线） | `TransformObjectToWorldNormal(normalOS)` | 使用法线矩阵（逆转置）|
| WS → VS | `TransformWorldToView(posWS)` | `mul(UNITY_MATRIX_V, float4(pos,1)).xyz` |

**为什么法线变换要用法线矩阵？**

当模型有非均匀缩放时（如 `Scale(2, 1, 1)`），直接用模型矩阵变换法线会导致法线不垂直于表面。正确的做法是使用模型矩阵的逆转置矩阵。URP 的 `TransformObjectToWorldNormal` 内部已经处理了这个问题。

## Unity 内置矩阵完整参考

```hlsl
// ===== Unity 矩阵完整列表（在 UnityShaderVariables.hlsl 中定义）=====

// 模型矩阵（Object → World）
UNITY_MATRIX_M   // 等价于 unity_ObjectToWorld

// 视图矩阵（World → View）  
UNITY_MATRIX_V   // 等价于 unity_MatrixV

// 投影矩阵（View → Clip）
UNITY_MATRIX_P   // 等价于 unity_MatrixP（注意：已处理平台差异）

// 组合矩阵（常用）
UNITY_MATRIX_VP  // View * Projection
UNITY_MATRIX_MV  // Model * View
UNITY_MATRIX_MVP // Model * View * Projection

// 逆矩阵（用于 deferred shading 等）
UNITY_MATRIX_I_M    // 模型矩阵的逆
UNITY_MATRIX_I_V    // 视图矩阵的逆
UNITY_MATRIX_I_VP   // VP 矩阵的逆

// 上一帧的矩阵（用于 TAA、运动模糊）
UNITY_PREV_MATRIX_M
UNITY_PREV_MATRIX_I_M
```

## 完整示例：URP 顶点动画草地 Shader

这个 Shader 实现正弦波形驱动的草地飘动效果，支持风向、风速调节：

```hlsl
Shader "Custom/URP/GrassWave"
{
    Properties
    {
        _BaseColor    ("Base Color",      Color)  = (0.3, 0.7, 0.2, 1.0)
        _TipColor     ("Tip Color",       Color)  = (0.6, 0.9, 0.3, 1.0)
        _MainTex      ("Albedo Texture",  2D)     = "white" {}
        // 顶点动画参数
        _WindDirection("Wind Direction",  Vector) = (1.0, 0.0, 0.5, 0.0)
        _WindSpeed    ("Wind Speed",      Range(0.1, 5.0))  = 1.5
        _WindStrength ("Wind Strength",   Range(0.0, 0.5))  = 0.15
        _WindFrequency("Wind Frequency",  Range(0.5, 10.0)) = 3.0
        // 草叶顶部影响权重（通过 UV.y 控制，底部固定，顶部飘动）
        _BendFactor   ("Bend Factor",     Range(0.0, 1.0))  = 1.0
        // 双面渲染（草叶需要）
        [Toggle] _DoubleSided ("Double Sided", Float) = 1
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Geometry"
        }

        // 双面渲染（草叶正背两面都可见）
        Cull Off

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            // URP 光照关键字
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS_VERTEX _ADDITIONAL_LIGHTS
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _BaseColor;
                float4 _TipColor;
                float4 _WindDirection;    // xyz: 方向，w 未使用
                float  _WindSpeed;
                float  _WindStrength;
                float  _WindFrequency;
                float  _BendFactor;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionHCS  : SV_POSITION;
                float2 uv           : TEXCOORD0;
                float3 positionWS   : TEXCOORD1;    // 世界空间位置（用于光照）
                float3 normalWS     : TEXCOORD2;    // 世界空间法线
                float  heightFactor : TEXCOORD3;    // 草叶高度因子（来自 UV.y）
                float4 shadowCoord  : TEXCOORD4;    // 阴影坐标
                float  fogFactor    : TEXCOORD5;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // ======== 顶点动画：正弦波草地飘动 ========

            // 计算草叶在世界空间中的位移
            // posWS: 世界空间位置
            // heightFactor: UV.y（0=根部固定，1=顶端最大偏移）
            float3 computeWindOffset(float3 posWS, float heightFactor)
            {
                float3 windDir = normalize(_WindDirection.xyz);
                float time = _Time.y * _WindSpeed;

                // 主波：基于世界坐标 XZ 相位的正弦波
                float phase = dot(posWS.xz, windDir.xz) * _WindFrequency;
                float wave = sin(time + phase);

                // 次波：添加第二频率增加自然感（频率 ×2.7，振幅 ×0.3）
                float wave2 = sin(time * 2.7 + phase * 1.3) * 0.3;

                // 合并波形，乘以高度因子（底部不动）
                float totalWave = (wave + wave2) * _WindStrength * heightFactor;

                return windDir * totalWave;
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                // === 坐标变换链演示 ===

                // 1. 对象空间 → 世界空间
                float3 positionWS = TransformObjectToWorld(IN.positionOS.xyz);

                // 2. 顶点动画：在世界空间中添加风力偏移
                // UV.y 作为高度因子：底部(UV.y=0)固定，顶端(UV.y=1)最大偏移
                float heightFactor = IN.uv.y * _BendFactor;
                positionWS += computeWindOffset(positionWS, heightFactor);

                // 3. 世界空间 → 裁剪空间
                OUT.positionHCS = TransformWorldToHClip(positionWS);
                OUT.positionWS = positionWS;

                // 4. 法线变换（对象空间 → 世界空间）
                // 注意：法线需要用逆转置矩阵，URP 函数内部已处理
                OUT.normalWS = TransformObjectToWorldNormal(IN.normalOS);

                // 5. 双面法线修正（背面渲染时翻转法线）
                // 在 Fragment Shader 中用 VFACE 语义处理

                OUT.uv = TRANSFORM_TEX(IN.uv, _MainTex);
                OUT.heightFactor = heightFactor;

                // 6. 阴影坐标计算（用于采样 Shadow Map）
                VertexPositionInputs vertexInput = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.shadowCoord = GetShadowCoord(vertexInput);

                // 7. 雾效因子
                OUT.fogFactor = ComputeFogFactor(OUT.positionHCS.z);

                return OUT;
            }

            half4 frag(Varyings IN, bool isFrontFace : SV_IsFrontFace) : SV_Target
            {
                // 双面法线：背面渲染时翻转法线方向
                float3 normalWS = normalize(IN.normalWS);
                normalWS = isFrontFace ? normalWS : -normalWS;

                // 采样贴图
                half4 texColor = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);

                // 根据草叶高度混合底色和顶色
                half4 grassColor = lerp(_BaseColor, _TipColor, IN.heightFactor) * texColor;

                // ===== URP 光照计算 =====

                // 获取主光源（方向、颜色、阴影衰减）
                Light mainLight = GetMainLight(IN.shadowCoord);

                // Lambert 漫反射
                float NdotL = saturate(dot(normalWS, mainLight.direction));
                float3 diffuse = mainLight.color * NdotL * mainLight.distanceAttenuation * mainLight.shadowAttenuation;

                // 半球环境光（Half-Lambert，避免背光面纯黑）
                float halfLambert = 0.5 * dot(normalWS, mainLight.direction) + 0.5;
                float3 ambient = grassColor.rgb * halfLambert * 0.3;

                // 合并光照
                float3 finalColor = grassColor.rgb * (diffuse + ambient);

                // 应用雾效
                finalColor = MixFog(finalColor, IN.fogFactor);

                return half4(finalColor, grassColor.a);
            }
            ENDHLSL
        }

        // ShadowCaster Pass（让草地正确投射阴影）
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }

            ZWrite On
            ZTest LEqual
            ColorMask 0  // 阴影 Pass 只写深度，不需要颜色输出
            Cull Off

            HLSLPROGRAM
            #pragma vertex vertShadow
            #pragma fragment fragShadow
            #pragma multi_compile_instancing

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/SurfaceInput.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/Shaders/ShadowCasterPass.hlsl"
            // 注意：使用 URP 内置 ShadowCasterPass.hlsl 时，顶点着色器名字必须是 ShadowPassVertex

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _BaseColor;
                float4 _TipColor;
                float4 _WindDirection;
                float  _WindSpeed;
                float  _WindStrength;
                float  _WindFrequency;
                float  _BendFactor;
            CBUFFER_END

            struct ShadowAttributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct ShadowVaryings
            {
                float4 positionHCS : SV_POSITION;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            float3 computeWindOffset(float3 posWS, float heightFactor)
            {
                float3 windDir = normalize(_WindDirection.xyz);
                float time = _Time.y * _WindSpeed;
                float phase = dot(posWS.xz, windDir.xz) * _WindFrequency;
                float wave = sin(time + phase) + sin(time * 2.7 + phase * 1.3) * 0.3;
                return windDir * wave * _WindStrength * heightFactor;
            }

            ShadowVaryings vertShadow(ShadowAttributes IN)
            {
                ShadowVaryings OUT;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

                float3 posWS = TransformObjectToWorld(IN.positionOS.xyz);
                // 阴影 Pass 也需要顶点动画，否则阴影形状与草地不匹配
                posWS += computeWindOffset(posWS, IN.uv.y * _BendFactor);

                // URP 阴影偏移（防止 shadow acne）
                float3 normalWS = TransformObjectToWorldNormal(IN.normalOS);
                float4 posHCS = TransformWorldToHClip(ApplyShadowBias(posWS, normalWS, _LightDirection));
                // DX 平台裁剪 Z 到 [0,1]
                #if UNITY_REVERSED_Z
                    posHCS.z = min(posHCS.z, posHCS.w * UNITY_NEAR_CLIP_VALUE);
                #else
                    posHCS.z = max(posHCS.z, posHCS.w * UNITY_NEAR_CLIP_VALUE);
                #endif

                OUT.positionHCS = posHCS;
                return OUT;
            }

            half4 fragShadow(ShadowVaryings IN) : SV_Target
            {
                return 0; // 阴影 Pass 片元着色器只需返回 0
            }
            ENDHLSL
        }
    }
}
```

## 坐标变换实用速查

日常 Shader 开发中最常用的变换模式：

```hlsl
// ===== 顶点着色器中的典型操作 =====

// 标准：OS → HCS（99% 的情况）
OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);

// 需要世界空间位置（光照、雾效）
VertexPositionInputs inputs = GetVertexPositionInputs(IN.positionOS.xyz);
OUT.positionWS = inputs.positionWS;
OUT.positionHCS = inputs.positionCS;

// 法线 + 切线（用于法线贴图）
VertexNormalInputs normalInputs = GetVertexNormalInputs(IN.normalOS, IN.tangentOS);
OUT.normalWS   = normalInputs.normalWS;
OUT.tangentWS  = normalInputs.tangentWS;
OUT.bitangentWS = normalInputs.bitangentWS;

// ===== 片元着色器中的典型操作 =====

// NDC 坐标（屏幕效果需要）
float2 screenUV = IN.positionHCS.xy / _ScreenParams.xy;

// 世界空间位置重建（从深度图）
float depth = SampleSceneDepth(screenUV);
float3 posWS = ComputeWorldSpacePosition(screenUV, depth, UNITY_MATRIX_I_VP);
```

## ShaderGraph 坐标空间节点

ShaderGraph 提供了对应的变换节点：
- `Transform` 节点：在任意空间之间变换位置和向量（下拉选择 Object/World/View/Tangent/Screen）
- `Position` 节点：获取当前顶点/片元在指定空间的位置
- `Normal Vector` 节点：获取法线（指定空间）
- `Vertex Color` 节点：读取顶点颜色（可用于植被弯曲量遮罩）

顶点动画在 ShaderGraph 中通过 **Vertex Stage** 实现：在 `Vertex` 上下文中修改 `Position` 输出。

## 性能考量

**顶点动画的性能影响：**
- 顶点着色器运算比片元着色器廉价（顶点数 << 片元数）
- `sin()` 在 GPU 上是硬件指令，开销约等于一次乘法
- 草地通常使用 GPU Instancing（`#pragma multi_compile_instancing`），每批次调用一次 Constant Buffer 更新

**移动端注意：**
- ShadowCaster Pass 中的顶点动画必须与 ForwardLit Pass 完全一致，否则阴影和草地错位
- 如果草地用 GPU Instancing，每个实例的世界坐标相位不同，会产生自然的随机飘动感

## 常见踩坑

1. **Unity 左手坐标系**：写顶点动画时 Z 轴朝前（正 Z = 朝屏幕外/玩家前方）。如果做的物体飘动方向不对，检查 `_WindDirection` 的 Z 分量符号

2. **`TransformObjectToWorldNormal` 在非均匀缩放时**：必须用这个函数而不是手动 `mul(UNITY_MATRIX_M, float4(normal,0)).xyz`，后者在 Scale 不均匀时会产生错误的法线

3. **ShadowCaster Pass 里也要做顶点动画**：这是最常见的遗漏！顶点动画让草地移动，如果 ShadowCaster Pass 不做同样的动画，阴影不会随草地移动

4. **`UNITY_MATRIX_MVP` 与 `TransformObjectToHClip` 的精度差异**：在大世界坐标（坐标值超过 10000）时，直接用 MVP 矩阵可能产生浮点精度问题。URP 内部的 `TransformObjectToHClip` 已使用相对坐标优化

5. **不要在 Shader 中使用 `unity_ObjectToWorld[3].xyz` 获取对象位置**：在开启了 GPU Instancing 时，这个值是 PerInstance 的，但直接访问矩阵行/列在某些平台可能有 bug，用 `GetObjectToWorldMatrix()` 更安全

下一篇文章将深入 URP 的纹理采样系统，讲解 TEXTURE2D、SAMPLER 宏的正确使用，以及如何写一个支持双层流动 UV 的水面 Shader。
