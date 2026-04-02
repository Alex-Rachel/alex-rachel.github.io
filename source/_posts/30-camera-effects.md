---
title: Unity Shader 系列（三十）：URP 相机特效实战
date: 2026-05-01 12:00:00
tags: [HLSL, URP, 景深, 运动模糊, 相机特效]
---

相机特效是游戏叙事和视觉表达的重要工具。URP 提供了景深、运动模糊、镜头畸变等内置效果，但其参数控制和自定义扩展需要深入理解。本文涵盖内置后处理配置、深度缓冲读取、自定义径向模糊和鱼眼镜头 Shader 的完整实现。

## 在 Shader 中读取深度缓冲

相机特效的核心是深度信息。URP 提供了标准化的深度缓冲读取接口：

```hlsl
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

// SampleSceneDepth：采样场景深度（返回原始深度值，[0,1]，非线性）
float rawDepth = SampleSceneDepth(screenUV);

// LinearEyeDepth：将非线性深度转换为线性眼空间深度（单位：世界单位）
float linearDepth = LinearEyeDepth(rawDepth, _ZBufferParams);

// Linear01Depth：将非线性深度转换为 [0,1] 线性深度
float linear01 = Linear01Depth(rawDepth, _ZBufferParams);

// 在 Fragment Shader 中重建世界坐标（需要知道深度对应的世界位置）
float3 ReconstructWorldPos(float2 screenUV, float depth)
{
    // 将屏幕 UV 转换到 NDC 坐标
    float4 ndcPos = float4(screenUV * 2.0 - 1.0, depth, 1.0);
    // 用逆视投影矩阵还原世界坐标
    float4 worldPos = mul(UNITY_MATRIX_I_VP, ndcPos);
    return worldPos.xyz / worldPos.w;
}
```

**踩坑**：`_ZBufferParams` 的格式与平台有关（OpenGL/DirectX/Metal 的深度范围不同），必须使用 URP 提供的 `LinearEyeDepth` 函数而非手动计算，否则在不同平台上会得到错误结果。

## URP 景深（Depth of Field）：Gaussian vs Bokeh

**Gaussian 模式**：双通道可分离高斯模糊，开销低，适合移动端。
**Bokeh 模式**：模拟真实镜头的多边形光圈形状散景，开销高（GPU 上用圆盘采样实现），适合过场动画。

**Volume 配置**：
```
Volume → Depth of Field
Mode：Gaussian（移动端）/ Bokeh（PC/主机）

Gaussian 参数：
  Focus Distance：焦距（聚焦点距相机的距离，单位：世界单位）
  Near Blur：近场模糊强度/范围
  Far Blur：远场模糊强度/范围

Bokeh 参数：
  Focal Length：焦距（毫米，越大景深越浅）
  Aperture：光圈大小（f 值，越小散景越强）
  Focus Distance：焦距
  Blade Count/Curvature/Rotation：光圈叶片形状（控制散景形状）
```

**C# 动态控制景深**（过场动画常用）：

```csharp
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public class DOFAnimator : MonoBehaviour
{
    [SerializeField] private Volume _volume;
    [SerializeField] private Transform _focusTarget;
    [SerializeField] private float _focusSpeed = 5.0f;

    private DepthOfField _dof;
    private Camera _mainCam;

    void Start()
    {
        _mainCam = Camera.main;
        _volume.profile.TryGet(out _dof);
    }

    void Update()
    {
        if (_dof == null || _focusTarget == null) return;

        // 自动对焦：计算到目标的距离并平滑过渡
        float targetDist = Vector3.Distance(_mainCam.transform.position, _focusTarget.position);
        float currentDist = _dof.focusDistance.value;
        _dof.focusDistance.value = Mathf.Lerp(currentDist, targetDist, Time.deltaTime * _focusSpeed);
    }

    // 剧情演出：将焦点从 A 移到 B
    public System.Collections.IEnumerator AnimateFocus(float fromDist, float toDist, float duration)
    {
        float elapsed = 0f;
        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;
            float t = Mathf.SmoothStep(0f, 1f, elapsed / duration);
            _dof.focusDistance.value = Mathf.Lerp(fromDist, toDist, t);
            yield return null;
        }
        _dof.focusDistance.value = toDist;
    }
}
```

## URP 运动模糊配置

**Camera Motion Blur**（整体摄像机运动）：
```
Volume → Motion Blur
Mode：Camera Motion（相机移动产生的模糊）
Intensity：0.1~0.3（过高会严重影响画面清晰度）
Clamp：防止单次模糊偏移过大
```

**Object Motion Blur**：URP 2021.2+ 开始支持基于运动向量的每物体运动模糊，需要在 URP Asset 中开启 `Motion Vectors`。

## 自定义径向模糊：爆炸冲击波效果

径向模糊从画面中心（或任意点）向外发散采样，产生爆炸冲击感：

```hlsl
Shader "Hidden/URP/RadialBlur"
{
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }
        ZWrite Off Cull Off ZTest Always

        Pass
        {
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            TEXTURE2D_X(_BlitTexture); SAMPLER(sampler_BlitTexture);

            CBUFFER_START(UnityPerMaterial)
                float2 _BlurCenter;     // 模糊中心（屏幕 UV，通常为 0.5, 0.5）
                float _BlurStrength;    // 模糊强度（0~0.05）
                int _BlurSamples;       // 采样数（8~16）
                float _BlurFalloff;     // 边缘衰减（越大中心越清晰）
            CBUFFER_END

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.texcoord;

                // 从当前 UV 到模糊中心的方向向量
                float2 dir = _BlurCenter - uv;
                float distFromCenter = length(dir);

                // 边缘衰减：离中心越远，模糊越强
                float blurAmount = _BlurStrength * pow(distFromCenter, _BlurFalloff);

                // 沿径向方向累积采样
                half3 color = 0.0;
                float totalWeight = 0.0;

                for (int i = 0; i < _BlurSamples; i++)
                {
                    float t = (float)i / (float)(_BlurSamples - 1);
                    // 从当前位置到中心方向采样（越靠近当前位置权重越大）
                    float2 sampleUV = uv + dir * (t - 0.5) * blurAmount;
                    float weight = 1.0 - abs(t - 0.5) * 1.5; // 中心权重最大
                    weight = max(weight, 0.0);

                    color += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_BlitTexture, sampleUV).rgb * weight;
                    totalWeight += weight;
                }
                color /= max(totalWeight, 0.001);

                return half4(color, 1.0);
            }
            ENDHLSL
        }
    }
}
```

**C# 爆炸冲击波触发器**：

```csharp
// ShockwaveController.cs
public class ShockwaveController : MonoBehaviour
{
    [SerializeField] private Material _radialBlurMaterial;
    [SerializeField] private float _blurDuration = 0.5f;
    [SerializeField] private float _maxBlurStrength = 0.03f;

    private static readonly int BlurStrengthID = Shader.PropertyToID("_BlurStrength");
    private static readonly int BlurCenterID = Shader.PropertyToID("_BlurCenter");

    // 在爆炸点触发冲击波模糊
    public void TriggerShockwave(Vector3 worldPos)
    {
        // 将世界坐标转换为屏幕 UV
        Vector3 screenPos = Camera.main.WorldToViewportPoint(worldPos);
        _radialBlurMaterial.SetVector(BlurCenterID, new Vector4(screenPos.x, screenPos.y, 0, 0));

        StartCoroutine(AnimateBlur());
    }

    System.Collections.IEnumerator AnimateBlur()
    {
        float elapsed = 0f;
        while (elapsed < _blurDuration)
        {
            elapsed += Time.deltaTime;
            float t = elapsed / _blurDuration;
            // 先快速增强，再缓慢消退（爆炸冲击感）
            float strength = _maxBlurStrength * (1.0f - t) * Mathf.Sin(t * Mathf.PI);
            _radialBlurMaterial.SetFloat(BlurStrengthID, strength);
            yield return null;
        }
        _radialBlurMaterial.SetFloat(BlurStrengthID, 0f);
    }
}
```

## 鱼眼/广角镜头 Shader（UV 畸变 + 色差）

```hlsl
Shader "Hidden/URP/FisheyeLens"
{
    Properties
    {
        _DistortionStrength ("畸变强度（负=桶形, 正=枕形）", Float) = -0.3
        _DistortionScale ("畸变缩放（防止黑边）", Float) = 0.9
        _AberrationStrength ("色差强度", Float) = 0.005
        _VignetteStrength ("暗角强度", Range(0, 1)) = 0.3
    }

    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }
        ZWrite Off Cull Off ZTest Always

        Pass
        {
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            TEXTURE2D_X(_BlitTexture); SAMPLER(sampler_BlitTexture);

            CBUFFER_START(UnityPerMaterial)
                float _DistortionStrength;
                float _DistortionScale;
                float _AberrationStrength;
                float _VignetteStrength;
            CBUFFER_END

            // Brown-Conrady 径向畸变模型
            float2 ApplyLensDistortion(float2 uv, float k1, float k2)
            {
                float2 centered = uv - 0.5;
                // 修正宽高比（保证圆形畸变）
                centered.x *= _ScreenParams.x / _ScreenParams.y;

                float r2 = dot(centered, centered);
                // 二阶 + 四阶畸变（Brown-Conrady 模型）
                float distortion = 1.0 + k1 * r2 + k2 * r2 * r2;

                centered *= distortion * _DistortionScale;
                centered.x /= (_ScreenParams.x / _ScreenParams.y); // 还原宽高比
                return centered + 0.5;
            }

            // 使用 Step Zoom 近似鱼眼（更强的广角效果）
            float2 FisheyeUV(float2 uv, float strength)
            {
                float2 centered = uv * 2.0 - 1.0;
                centered.x *= _ScreenParams.x / _ScreenParams.y;
                float dist = length(centered);
                // 等距投影（Equidistant Fisheye）
                float newDist = atan(dist * strength) / strength;
                float2 result = centered * (newDist / max(dist, 0.0001));
                result.x /= _ScreenParams.x / _ScreenParams.y;
                return result * 0.5 + 0.5;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                float2 uv = IN.texcoord;

                // 应用镜头畸变
                float2 distortedUV = ApplyLensDistortion(uv, _DistortionStrength, _DistortionStrength * 0.3);

                // 黑边处理（UV 超出 [0,1] 范围时显示黑色）
                bool isOutside = any(distortedUV < 0.0) || any(distortedUV > 1.0);
                if (isOutside) return half4(0, 0, 0, 1);

                // 色差：基于到中心的距离，RGB 三通道有不同畸变量
                float2 center = uv - 0.5;
                float2 aberrDir = center * _AberrationStrength;

                float r = SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_BlitTexture,
                    distortedUV + aberrDir * 1.5).r;
                float g = SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_BlitTexture,
                    distortedUV).g;
                float b = SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_BlitTexture,
                    distortedUV - aberrDir).b;

                half3 color = half3(r, g, b);

                // 暗角
                float dist = length(uv - 0.5);
                float vignette = 1.0 - smoothstep(0.4, 0.7, dist) * _VignetteStrength;
                color *= vignette;

                return half4(color, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 相机抖动（Camera Shake）与 Motion Blur 配合

相机抖动配合 Motion Blur 可以产生强烈的打击感：

```csharp
// CameraShake.cs
using UnityEngine;

public class CameraShake : MonoBehaviour
{
    [SerializeField] private float _shakeDuration = 0.3f;
    [SerializeField] private float _shakeIntensity = 0.1f;
    [SerializeField] private float _shakeFrequency = 20f;

    private Vector3 _originalPos;
    private float _shakeTimer = 0f;
    private bool _isShaking = false;

    // 配合 Motion Blur Volume
    private UnityEngine.Rendering.Volume _postProcessVolume;
    private UnityEngine.Rendering.Universal.MotionBlur _motionBlur;

    void Start()
    {
        _originalPos = transform.localPosition;
        _postProcessVolume = FindObjectOfType<UnityEngine.Rendering.Volume>();
        if (_postProcessVolume != null)
            _postProcessVolume.profile.TryGet(out _motionBlur);
    }

    public void TriggerShake(float intensity = 1.0f)
    {
        _shakeTimer = _shakeDuration;
        _isShaking = true;
        // 抖动时增强 Motion Blur（增加冲击感）
        if (_motionBlur != null)
            StartCoroutine(EnhanceMotionBlur(intensity));
    }

    void Update()
    {
        if (!_isShaking) return;

        _shakeTimer -= Time.deltaTime;
        float decay = _shakeTimer / _shakeDuration; // 线性衰减

        // 使用 Perlin Noise 产生有机感的抖动（比随机更自然）
        float offsetX = (Mathf.PerlinNoise(Time.time * _shakeFrequency, 0) - 0.5f)
                       * _shakeIntensity * decay;
        float offsetY = (Mathf.PerlinNoise(0, Time.time * _shakeFrequency) - 0.5f)
                       * _shakeIntensity * decay;

        transform.localPosition = _originalPos + new Vector3(offsetX, offsetY, 0);

        if (_shakeTimer <= 0f)
        {
            _isShaking = false;
            transform.localPosition = _originalPos;
        }
    }

    System.Collections.IEnumerator EnhanceMotionBlur(float intensity)
    {
        if (_motionBlur == null) yield break;

        float originalIntensity = _motionBlur.intensity.value;
        _motionBlur.intensity.value = Mathf.Min(originalIntensity + intensity * 0.5f, 1.0f);

        yield return new WaitForSeconds(_shakeDuration * 0.5f);

        float elapsed = 0f;
        float duration = _shakeDuration * 0.5f;
        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;
            _motionBlur.intensity.value = Mathf.Lerp(
                originalIntensity + intensity * 0.5f,
                originalIntensity,
                elapsed / duration
            );
            yield return null;
        }
        _motionBlur.intensity.value = originalIntensity;
    }
}
```

## 性能建议

**各效果开销参考（1080p，移动高端 GPU）**：

| 效果 | 开销 | 采样数建议 |
|------|------|-----------|
| Gaussian DOF | 低（约 0.5ms） | URP 自动处理 |
| Bokeh DOF | 高（约 3~5ms） | 仅 PC/主机 |
| Camera Motion Blur | 中（约 1ms） | 4~8 次 |
| 径向模糊 | 低-中 | 8~12 次 |
| 鱼眼 + 色差 | 低（约 0.3ms） | 4~6 次 |
| 暗角 | 极低 | 无需采样 |

**移动端优化**：
- Bokeh DOF 完全禁用，改用 Gaussian 或直接关闭
- Motion Blur 强度降至 0.1 以下，或完全关闭
- 多个效果合并到单个 Pass（减少全屏 Blit 次数）
- 在不需要特效的场景（UI、菜单）临时关闭 Post Processing

**踩坑提醒**：URP 的景深效果在 MSAA 开启时会有兼容性问题（深度缓冲精度下降），建议景深和 MSAA 不要同时使用，转而使用 TAA。

相机特效是最容易"无脑堆效果"的领域，但真正好的相机表现需要克制——适度的景深引导视线，短促的运动模糊增加打击感，轻微的色差增加镜头质感，这才是专业游戏相机特效的设计哲学。
