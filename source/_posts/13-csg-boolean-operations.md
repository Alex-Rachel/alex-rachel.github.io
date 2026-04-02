---
title: Unity Shader 系列（十三）：CSG 布尔运算：程序化切割与溶解特效
date: 2026-04-14 12:00:00
tags: [HLSL, URP, CSG, SDF布尔运算, 程序化特效]
---

CSG（Constructive Solid Geometry，构造实体几何）布尔运算在 Unity 游戏开发中有极高的实用价值：炸弹爆炸在地面炸出的坑洞、剑砍到敌人身上的溅血切割面、技能范围的辉光边界——这些效果如果用传统 Mesh 变形来实现，不仅复杂还开销巨大，而用 SDF 布尔运算配合 URP Renderer Feature，可以实现完全程序化、无网格变形的实时切割和溶解特效。

## SDF 布尔运算回顾

在 HLSL 中，对两个距离场 d1、d2 进行布尔运算只需一行数学：

```hlsl
float opUnion(float d1, float d2)        { return min(d1, d2); }
float opSubtraction(float d1, float d2)  { return max(d1, -d2); }    // d1 中挖掉 d2
float opIntersection(float d1, float d2) { return max(d1, d2); }

// 平滑并集（k 控制混合带宽，k=0 退化为硬布尔）
float smin(float a, float b, float k)
{
    float h = max(k - abs(a - b), 0.0);
    return min(a, b) - h * h * 0.25 / k;
}

// 平滑差集（挖洞时用这个，边缘自然圆滑）
float smax(float a, float b, float k)
{
    float h = max(k - abs(a - b), 0.0);
    return max(a, b) + h * h * 0.25 / k;
}
```

**平滑差集 `smax(d1, -d2, k)` 是制作爆炸坑、子弹孔的核心**：它在挖掉 d2 对应区域的同时，在边界处产生自然圆滑的过渡，而不是锐利的切割线。

## 完整示例：URP 程序化切割 Shader

这个 Shader 实现了用任意平面切割物体，切面自动显示不同颜色，可以通过脚本传入切割平面参数实现实时切割动画。

```hlsl
Shader "Custom/URP/SliceEffect"
{
    Properties
    {
        _MainTex ("主纹理", 2D) = "white" {}
        _BaseColor ("基础颜色", Color) = (1, 1, 1, 1)

        // 切割平面：xyz = 法线方向，w = 平面偏移
        // 平面方程：dot(worldPos, _SlicePlane.xyz) + _SlicePlane.w < 0 的区域被切除
        _SlicePlane ("切割平面 (xyz=法线, w=偏移)", Vector) = (0, 1, 0, -1)

        // 切面颜色和宽度
        _SliceColor ("切面颜色", Color) = (1, 0.3, 0.1, 1)
        _SliceWidth ("切面宽度", Range(0.001, 0.1)) = 0.02
        _SmoothBlend ("平滑过渡宽度", Range(0, 0.1)) = 0.01

        // 溶解效果（配合噪波纹理）
        _NoiseTex ("溶解噪波", 2D) = "white" {}
        _DissolveAmount ("溶解程度", Range(0, 1)) = 0.0
        _DissolveEdgeWidth ("溶解边缘宽度", Range(0, 0.1)) = 0.02
        _DissolveEdgeColor ("溶解边缘颜色", Color) = (1, 0.5, 0, 1)
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
        }

        // Pass 1：正面渲染
        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            // 只渲染正面（切割后可以看到背面的切面颜色）
            Cull Back

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _SHADOWS_SOFT

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);
            TEXTURE2D(_NoiseTex);
            SAMPLER(sampler_NoiseTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _BaseColor;
                float4 _SlicePlane;
                float4 _SliceColor;
                float  _SliceWidth;
                float  _SmoothBlend;
                float4 _NoiseTex_ST;
                float  _DissolveAmount;
                float  _DissolveEdgeWidth;
                float4 _DissolveEdgeColor;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionHCS : SV_POSITION;
                float3 worldPos    : TEXCOORD0;
                float3 worldNormal : TEXCOORD1;
                float2 uv          : TEXCOORD2;
                float4 shadowCoord : TEXCOORD3;
            };

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.worldPos    = TransformObjectToWorld(input.positionOS.xyz);
                output.worldNormal = TransformObjectToWorldNormal(input.normalOS);
                output.uv          = TRANSFORM_TEX(input.uv, _MainTex);

                // 计算阴影坐标（需要 _MAIN_LIGHT_SHADOWS 宏）
                VertexPositionInputs vertexInput = GetVertexPositionInputs(input.positionOS.xyz);
                output.shadowCoord = GetShadowCoord(vertexInput);
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                float3 worldPos = input.worldPos;

                // ---- 1. 切割平面剔除 ----
                // 计算当前点到切割平面的有符号距离
                float sliceDist = dot(worldPos, _SlicePlane.xyz) + _SlicePlane.w;

                // 超出切割范围（平面正侧）：直接剔除片段
                if (sliceDist > _SliceWidth) discard;

                // ---- 2. 溶解效果 ----
                float2 noiseUV = TRANSFORM_TEX(input.uv, _NoiseTex);
                float noiseVal = SAMPLE_TEXTURE2D(_NoiseTex, sampler_NoiseTex, noiseUV).r;

                // 噪波值 < 溶解程度时剔除
                if (noiseVal < _DissolveAmount) discard;

                // ---- 3. 切面颜色区域（靠近切割平面的区域显示切面颜色）----
                bool isSliceFace = (sliceDist > -_SliceWidth && sliceDist <= _SliceWidth);

                // 溶解边缘发光
                bool isDissolveEdge = (noiseVal < _DissolveAmount + _DissolveEdgeWidth);

                // ---- 4. 标准 URP 漫反射光照 ----
                Light mainLight = GetMainLight(input.shadowCoord);
                float3 normal   = normalize(input.worldNormal);
                float  NdotL    = saturate(dot(normal, mainLight.direction));
                float3 diffuse  = mainLight.color * NdotL * mainLight.shadowAttenuation;

                // 基础颜色
                float3 albedo = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.uv).rgb;
                albedo *= _BaseColor.rgb;

                // 切面区域覆盖颜色
                if (isSliceFace)
                {
                    // 切面内部亮色显示（使用切面颜色）
                    float faceFactor = smoothstep(_SliceWidth, 0.0, abs(sliceDist));
                    albedo = lerp(albedo, _SliceColor.rgb, faceFactor);
                }

                // 溶解边缘发光叠加
                if (isDissolveEdge)
                {
                    float edgeFactor = 1.0 - (noiseVal - _DissolveAmount) / _DissolveEdgeWidth;
                    albedo = lerp(albedo, _DissolveEdgeColor.rgb * 3.0, edgeFactor);
                }

                float3 ambient    = SampleSH(normal) * 0.5;
                float3 finalColor = albedo * (ambient + diffuse);

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }

        // Pass 2：背面（切面）渲染
        Pass
        {
            Name "SliceFaceBack"
            Tags { "LightMode" = "UniversalForwardOnly" }

            Cull Front  // 只渲染背面，用于显示切面内部

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment fragBack
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _SlicePlane;
                float  _SliceWidth;
                float4 _SliceColor;
                float  _DissolveAmount;
            CBUFFER_END

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float3 worldPos : TEXCOORD0; };

            TEXTURE2D(_NoiseTex); SAMPLER(sampler_NoiseTex);
            float4 _NoiseTex_ST;

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionHCS = TransformObjectToHClip(input.positionOS.xyz);
                output.worldPos    = TransformObjectToWorld(input.positionOS.xyz);
                return output;
            }

            half4 fragBack(Varyings input) : SV_Target
            {
                // 背面也需要切割和溶解剔除（保持一致）
                float sliceDist = dot(input.worldPos, _SlicePlane.xyz) + _SlicePlane.w;
                if (sliceDist > 0.0) discard;

                // 切面颜色（带轻微漫射感）
                return _SliceColor;
            }
            ENDHLSL
        }

        // Shadow Caster Pass（支持投射阴影）
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }
            ColorMask 0
            Cull Back

            HLSLPROGRAM
            #pragma vertex shadowVert
            #pragma fragment shadowFrag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _SlicePlane;
                float  _SliceWidth;
                float  _DissolveAmount;
            CBUFFER_END

            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float3 worldPos : TEXCOORD0; };

            TEXTURE2D(_NoiseTex); SAMPLER(sampler_NoiseTex);
            float4 _NoiseTex_ST;

            Varyings shadowVert(Attributes input)
            {
                Varyings output;
                output.worldPos = TransformObjectToWorld(input.positionOS.xyz);
                // 使用 URP 的阴影偏移（防止 shadow acne）
                float3 lightDir = _MainLightPosition.xyz;
                output.positionHCS = TransformWorldToHClip(
                    ApplyShadowBias(output.worldPos, 
                    TransformObjectToWorldNormal(input.normalOS), lightDir)
                );
                return output;
            }

            half4 shadowFrag(Varyings input) : SV_Target
            {
                float sliceDist = dot(input.worldPos, _SlicePlane.xyz) + _SlicePlane.w;
                if (sliceDist > _SliceWidth) discard;
                return 0;
            }
            ENDHLSL
        }
    }
}
```

## 通过 C# 脚本动态控制切割

```csharp
using UnityEngine;

// 挂载到拥有 SliceEffect Material 的 GameObject 上
[RequireComponent(typeof(Renderer))]
public class SliceController : MonoBehaviour
{
    [Header("切割参数")]
    [SerializeField] private Vector3 sliceNormal = Vector3.up;
    [SerializeField] private float sliceOffset = 0.0f;

    [Header("溶解动画")]
    [SerializeField] private bool animateDissolve = false;
    [SerializeField] private float dissolveSpeed = 0.5f;
    [SerializeField] private float dissolveDelay = 0.0f;

    private Material _material;
    private float _dissolveTimer = 0.0f;
    private bool _dissolveStarted = false;

    // 在 Inspector 中实时可见
    private static readonly int SlicePlaneID      = Shader.PropertyToID("_SlicePlane");
    private static readonly int DissolveAmountID  = Shader.PropertyToID("_DissolveAmount");

    void Start()
    {
        // 使用 MaterialPropertyBlock 可避免 Material 实例化（性能更好）
        _material = GetComponent<Renderer>().material;
        UpdateSlicePlane();
    }

    void Update()
    {
        if (animateDissolve)
        {
            _dissolveTimer += Time.deltaTime;
            if (_dissolveTimer >= dissolveDelay)
            {
                float t = (_dissolveTimer - dissolveDelay) * dissolveSpeed;
                float dissolve = Mathf.Clamp01(t);
                _material.SetFloat(DissolveAmountID, dissolve);

                if (dissolve >= 1.0f)
                    gameObject.SetActive(false); // 完全溶解后隐藏
            }
        }
    }

    // 根据爆炸位置动态更新切割平面
    public void SetSliceByExplosion(Vector3 explosionCenter, float radius)
    {
        Vector3 toObject = (transform.position - explosionCenter).normalized;
        sliceNormal = toObject;
        sliceOffset = Vector3.Dot(explosionCenter + toObject * radius, toObject);
        UpdateSlicePlane();
        
        // 触发溶解动画
        animateDissolve = true;
    }

    void UpdateSlicePlane()
    {
        Vector3 n = sliceNormal.normalized;
        _material.SetVector(SlicePlaneID, new Vector4(n.x, n.y, n.z, sliceOffset));
    }

    // 在 Scene 视图中绘制切割平面辅助线
    void OnDrawGizmos()
    {
        Gizmos.color = Color.red;
        Vector3 center = transform.position - sliceNormal.normalized * sliceOffset;
        Gizmos.DrawWireCube(center, new Vector3(2, 0.02f, 2));
        Gizmos.DrawRay(center, sliceNormal.normalized);
    }
}
```

## 在游戏中的实际应用场景

**1. 炸弹爆炸坑洞（SDF smooth subtraction）**
用球形 SDF 代表爆炸范围，在场景的 SDF 地形（或全屏 Renderer Feature）中使用 `smax(terrain, -explosion, k)` 实时挖出带圆滑边缘的坑洞，配合溅射粒子效果非常真实。

**2. 角色被攻击溶解效果**
当角色受到特定技能（如火焰、酸液）攻击时，触发溶解动画：`_DissolveAmount` 从 0 动画到 1，同时边缘发光颜色根据技能类型变化（火=橙红，冰=蓝白，酸=绿色）。

**3. 技能范围可视化**
将 CSG 差集用于显示技能的"命中区域"：在全屏 SDF 渲染中，用球形 SDF 的外壳（`abs(sdf) - thickness`）显示技能范围边界，配合脉冲动画提示玩家躲避。

## ShaderGraph 对应实现思路

切割效果在 ShaderGraph 中的实现路径：
- **Plane Clip**：使用 `Position` 节点（World Space）与 `Dot Product` 计算到平面的距离
- 将距离值输入 `Branch`（或 `Comparison` + `Clip`）节点控制剔除
- **溶解**：`Sample Texture 2D` 采样噪波，减去 `_DissolveAmount` 后输入 `Clip` 节点
- **边缘发光**：将溶解噪波减去阈值的结果用 `Step` 和 `Multiply` 叠加发光颜色

**注意**：ShaderGraph 的 `Clip` 节点在移动端可能被优化为 `discard`，性能表现与手写 HLSL 相近，但无法控制双面渲染（需要改 Material 的 Render Face 设置）。

## 性能考量

| 技术要点 | 说明 |
|---------|------|
| `discard` 的性能代价 | 移动端 tile-based GPU 上 `discard` 会阻止 early-z，降低填充率效率。大面积使用时考虑替代方案 |
| 双 Pass 开销 | 切割 Shader 需要两个 Pass，draw call 数量翻倍。可以用 `SV_IsFrontFace` 语义在单 Pass 中区分前后面 |
| 纹理采样数量 | 溶解噪波纹理在每帧每个片段都采样，确保纹理分辨率合理（256×256 足够），开启 Mipmap |
| 移动端 | 关闭阴影接收（移除 `_MAIN_LIGHT_SHADOWS`）可节省约 30% 的 fragment shader 开销 |

## 常见踩坑

**坑1：双面渲染的法线方向**
背面 Pass 中，URP 不会自动翻转法线。如果你在背面 Pass 中使用法线计算光照，需要手动乘以 -1 或使用 `SV_IsFrontFace` 语义判断正背面。

**坑2：ShadowCaster Pass 必须同步剔除逻辑**
如果主 Pass 用 `discard` 剔除了某些片段，但 ShadowCaster Pass 没有相同的剔除逻辑，被切割的部分仍然会投射阴影，产生"幽灵阴影"。

**坑3：溶解边缘发光在 HDR 中的处理**
`_DissolveEdgeColor.rgb * 3.0` 这样的乘法在 HDR 管线中才能产生实际的辉光效果（配合 Bloom 后处理）。在 SDR 管线中数值会被截断到 1，看不出发光感。确保项目开启了 HDR 和 Bloom。

**坑4：MaterialPropertyBlock vs Material.Set***
在大量相同 Shader 的对象上使用 `MaterialPropertyBlock` 而不是 `material.SetFloat`，可以避免 Material 实例化，保持 GPU Instancing 合批。上面的 `SliceController` 示例为了简单使用了 `material`，生产中应改用 `MaterialPropertyBlock`。
