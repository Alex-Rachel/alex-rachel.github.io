---
title: Unity Shader 系列（三十六）：音频可视化与音频驱动 Shader 技术
date: 2026-04-01 14:50:00
tags: [HLSL, URP, 音频可视化, 音频驱动Shader, 节拍同步]
categories:
  - Unity Shader 系列
  - 进阶技术
---

## 让声音驱动视觉

音乐游戏、节奏同步的场景特效、音频可视化界面——这类效果的核心是让 **Shader 感知到声音**。Unity 提供了 `AudioSource.GetSpectrumData` 和 `GetOutputData` 两个 API，可以每帧从音频流中提取频谱数据，再通过 Shader 的 `Texture1D` 或 uniform 数组将数据传入 GPU。

本篇覆盖完整的技术链路：音频数据提取 → 传入 Shader → 频谱可视化 → 节拍检测 → 场景灯光同步，每个环节都有完整可用的代码。

## 音频数据提取：GetSpectrumData 与 GetOutputData

### 两个 API 的区别

| API | 返回数据 | 用途 |
|-----|---------|------|
| `GetSpectrumData` | 频域数据（FFT 后的频率分量） | 频谱柱状图、EQ 可视化 |
| `GetOutputData` | 时域数据（原始波形采样值）| 波形显示、振幅检测 |

### 频谱数据采集脚本

```csharp
using UnityEngine;

public class AudioSpectrumProvider : MonoBehaviour
{
    [Header("音频源")]
    public AudioSource audioSource;

    [Header("频谱配置")]
    [Range(64, 8192)]
    public int spectrumSamples = 512;   // 必须是 2 的幂次
    public FFTWindow fftWindow = FFTWindow.BlackmanHarris; // 窗函数影响频谱精度

    [Header("输出配置")]
    public int spectrumBands = 64;      // 传给 Shader 的频段数量
    public float smoothingSpeed = 10f;  // 频谱平滑速度（峰值保持）

    // 频谱数据缓冲（float 数组）
    private float[] spectrumData;
    private float[] bandData;      // 降采样后的频段数据
    private float[] smoothedBands; // 平滑后的频段数据

    // 用于传给 Shader 的 Texture1D（一维纹理）
    private Texture2D spectrumTexture;

    // 静态属性，方便 Shader 脚本访问
    public static AudioSpectrumProvider Instance { get; private set; }
    public float[] SmoothedBands => smoothedBands;

    void Awake()
    {
        Instance = this;
    }

    void Start()
    {
        spectrumData   = new float[spectrumSamples];
        bandData       = new float[spectrumBands];
        smoothedBands  = new float[spectrumBands];

        // 创建 1×spectrumBands 的一维纹理（模拟 Texture1D）
        // Unity 不支持真正的 Texture1D，用 2D 纹理的第一行代替
        spectrumTexture = new Texture2D(spectrumBands, 1, TextureFormat.RFloat, false);
        spectrumTexture.filterMode = FilterMode.Bilinear;
        spectrumTexture.wrapMode   = TextureWrapMode.Clamp;
    }

    void Update()
    {
        if (audioSource == null || !audioSource.isPlaying) return;

        // 提取原始频谱数据（每帧调用，性能开销小）
        audioSource.GetSpectrumData(spectrumData, 0, fftWindow);

        // 将 spectrumSamples 个采样降采样到 spectrumBands 个频段
        // 使用对数分布（低频段更细，高频段更粗，符合人耳听觉特性）
        UpdateBands();

        // 平滑处理（峰值快速上升，缓慢下降）
        SmoothBands();

        // 更新 Texture（将数组写入 GPU 纹理）
        UpdateSpectrumTexture();
    }

    void UpdateBands()
    {
        // 对数频段分割：低频 20Hz 到高频 20kHz
        float logMin = Mathf.Log10(20f);
        float logMax = Mathf.Log10(20000f);
        float sampleRate = AudioSettings.outputSampleRate;

        for (int band = 0; band < spectrumBands; band++)
        {
            float freqMin = Mathf.Pow(10, Mathf.Lerp(logMin, logMax, (float)band / spectrumBands));
            float freqMax = Mathf.Pow(10, Mathf.Lerp(logMin, logMax, (float)(band + 1) / spectrumBands));

            int idxMin = Mathf.Clamp((int)(freqMin / sampleRate * spectrumSamples * 2), 0, spectrumSamples - 1);
            int idxMax = Mathf.Clamp((int)(freqMax / sampleRate * spectrumSamples * 2), 0, spectrumSamples - 1);

            float sum = 0f;
            int count = Mathf.Max(1, idxMax - idxMin);
            for (int i = idxMin; i < idxMax; i++)
                sum += spectrumData[i];

            bandData[band] = sum / count;
        }
    }

    void SmoothBands()
    {
        for (int i = 0; i < spectrumBands; i++)
        {
            if (bandData[i] > smoothedBands[i])
                // 快速跟随上升
                smoothedBands[i] = Mathf.Lerp(smoothedBands[i], bandData[i], smoothingSpeed * Time.deltaTime);
            else
                // 缓慢衰减（峰值保持效果）
                smoothedBands[i] = Mathf.Lerp(smoothedBands[i], bandData[i], smoothingSpeed * 0.3f * Time.deltaTime);
        }
    }

    void UpdateSpectrumTexture()
    {
        // 写入纹理像素（R 通道存储频谱强度）
        var pixels = new Color[spectrumBands];
        for (int i = 0; i < spectrumBands; i++)
        {
            // 对数幅度映射（dB 尺度更符合人耳感知）
            float db = Mathf.Log10(Mathf.Max(smoothedBands[i], 1e-6f)) * 20f;
            float normalized = Mathf.InverseLerp(-60f, 0f, db); // -60dB 到 0dB 映射到 [0,1]
            pixels[i] = new Color(normalized, 0, 0, 1f);
        }
        spectrumTexture.SetPixels(pixels);
        spectrumTexture.Apply(false); // false = 不重新生成 Mipmap（性能优化）

        // 全局传给所有 Shader
        Shader.SetGlobalTexture("_SpectrumTex", spectrumTexture);
        Shader.SetGlobalFloat("_AudioTime", Time.time);
    }

    // 获取特定频段的能量（用于节拍检测）
    public float GetBandEnergy(int startBand, int endBand)
    {
        float sum = 0;
        for (int i = startBand; i < Mathf.Min(endBand, spectrumBands); i++)
            sum += smoothedBands[i];
        return sum / Mathf.Max(1, endBand - startBand);
    }

    void OnDestroy()
    {
        if (spectrumTexture != null) Destroy(spectrumTexture);
    }
}
```

## 节拍检测：驱动场景效果

```csharp
using UnityEngine;

public class BeatDetector : MonoBehaviour
{
    [Header("节拍检测参数")]
    public AudioSpectrumProvider spectrumProvider;
    public int   bassStartBand   = 0;   // 低频（贝斯/底鼓）频段起始
    public int   bassEndBand     = 4;   // 低频频段结束
    [Range(1.1f, 3f)]
    public float beatThreshold   = 1.5f; // 能量超过平均值多少倍判定为节拍
    public float beatCooldown    = 0.2f; // 节拍检测最小间隔（秒），防止误触发

    // 历史能量（用于计算平均值）
    private float[] energyHistory;
    private int historySize = 43; // 约 1 秒的历史（60fps → 43 帧）
    private int historyIndex = 0;

    private float lastBeatTime = -999f;
    private float beatIntensity = 0f;   // 当前节拍强度 [0,1]，会快速衰减

    // 事件：节拍触发时通知订阅者
    public System.Action<float> OnBeat;

    // 全局访问
    public static BeatDetector Instance { get; private set; }
    public float BeatIntensity => beatIntensity;

    void Awake() { Instance = this; }

    void Start()
    {
        energyHistory = new float[historySize];
    }

    void Update()
    {
        if (spectrumProvider == null) return;

        // 计算当前低频能量
        float currentEnergy = spectrumProvider.GetBandEnergy(bassStartBand, bassEndBand);

        // 记录历史
        energyHistory[historyIndex] = currentEnergy;
        historyIndex = (historyIndex + 1) % historySize;

        // 计算历史平均
        float avgEnergy = 0;
        foreach (var e in energyHistory) avgEnergy += e;
        avgEnergy /= historySize;

        // 节拍判定：能量超过阈值 × 平均值，且冷却时间已过
        bool isBeat = currentEnergy > beatThreshold * avgEnergy
                   && Time.time - lastBeatTime > beatCooldown
                   && avgEnergy > 0.001f; // 防止静音时触发

        if (isBeat)
        {
            lastBeatTime  = Time.time;
            beatIntensity = 1.0f;
            // 触发节拍强度（越强的节拍，强度越高）
            float normalizedIntensity = Mathf.Clamp01(currentEnergy / (avgEnergy * beatThreshold));
            OnBeat?.Invoke(normalizedIntensity);
        }

        // 节拍强度快速衰减
        beatIntensity = Mathf.Max(0, beatIntensity - Time.deltaTime * 8f);

        // 传给 Shader
        Shader.SetGlobalFloat("_BeatIntensity", beatIntensity);
        Shader.SetGlobalFloat("_TimeSinceLastBeat", Time.time - lastBeatTime);
    }
}
```

## 实战示例一：频谱柱状图可视化 Shader

```hlsl
Shader "Custom/URP/SpectrumVisualizer"
{
    Properties
    {
        _SpectrumTex    ("Spectrum Texture",    2D)     = "black" {}
        _BarColor       ("Bar Color",           Color)  = (0.2, 0.8, 1.0, 1.0)
        _PeakColor      ("Peak Color",          Color)  = (1.0, 0.3, 0.1, 1.0)
        _BackgroundColor("Background Color",    Color)  = (0.05, 0.05, 0.1, 1.0)
        _BarCount       ("Bar Count",           Float)  = 64
        _GlowStrength   ("Glow Strength",       Range(0, 3)) = 1.0
        _PeakThreshold  ("Peak Threshold",      Range(0.6, 1)) = 0.85
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

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings   { float4 positionHCS : SV_POSITION; float2 uv : TEXCOORD0; };

            TEXTURE2D(_SpectrumTex); SAMPLER(sampler_SpectrumTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _BarColor;
                float4 _PeakColor;
                float4 _BackgroundColor;
                float  _BarCount;
                float  _GlowStrength;
                float  _PeakThreshold;
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
                float2 uv = IN.uv;

                // 确定当前像素属于哪个频段
                float barIndex   = floor(uv.x * _BarCount);
                float barLocalX  = frac(uv.x * _BarCount); // [0,1] 在单个条内

                // 采样该频段的频谱强度
                float bandU    = (barIndex + 0.5) / _BarCount;
                float spectrum = SAMPLE_TEXTURE2D(_SpectrumTex, sampler_SpectrumTex, float2(bandU, 0.5)).r;

                // 条的宽度（中间 80% 是颜色，两侧 10% 是间隙）
                float barGap    = 0.1;
                float inBar     = step(barGap, barLocalX) * step(barLocalX, 1.0 - barGap);

                // 柱状图高度判断：当前 Y 是否在频谱强度以下
                float belowBar  = step(uv.y, spectrum);
                float inBarArea = inBar * belowBar;

                // 峰值高亮：接近当前高度顶部的部分用 PeakColor
                float nearPeak  = smoothstep(spectrum - 0.05, spectrum, uv.y)
                                * smoothstep(spectrum + 0.01, spectrum, uv.y)
                                * inBar
                                * step(_PeakThreshold, spectrum);

                // 颜色计算
                // 高度渐变：底部偏蓝，顶部偏红
                float heightRatio = uv.y / max(spectrum, 0.001);
                half3 barColor = lerp(_BarColor.rgb, _PeakColor.rgb, heightRatio * heightRatio);

                // 发光效果（条的侧边发光）
                float glowDist  = abs(barLocalX - 0.5) * 2.0; // 0=中心, 1=边缘
                float glow      = exp(-glowDist * 5.0) * spectrum * _GlowStrength;

                // 合成
                half3 finalColor = _BackgroundColor.rgb;
                finalColor = lerp(finalColor, barColor, inBarArea);
                finalColor = lerp(finalColor, _PeakColor.rgb, nearPeak);
                finalColor += barColor * glow * inBar; // 叠加发光

                // 动态脉冲：随 _BeatIntensity 全局闪烁
                float beatIntensity = _GlobalBeatIntensity; // 由 C# 设置
                finalColor += barColor * beatIntensity * 0.3 * inBarArea;

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

## 实战示例二：节拍同步场景灯光 Shader

将节拍信号驱动材质的自发光强度，实现音乐响应的环境光效。

```hlsl
Shader "Custom/URP/BeatSyncEmissive"
{
    Properties
    {
        _MainTex        ("Albedo",              2D)    = "white" {}
        _BaseColor      ("Base Color",          Color) = (0.1, 0.1, 0.2, 1.0)
        _EmissiveColor  ("Emissive Color",      Color) = (0.3, 0.6, 1.0, 1.0)
        _BaseEmissive   ("Base Emissive",       Range(0, 1)) = 0.1
        _BeatBoost      ("Beat Boost",          Range(0, 5)) = 2.0
        _PulseSpeed     ("Pulse Decay Speed",   Range(1, 20)) = 8.0
        _ColorShift     ("Color Shift on Beat", Range(0, 1)) = 0.5
        _BeatEmissiveColor("Beat Flash Color",  Color) = (1.0, 0.4, 0.1, 1.0)
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
            #pragma multi_compile _ _SHADOWS_SOFT
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

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _BaseColor;
                float4 _EmissiveColor;
                float4 _BeatEmissiveColor;
                float  _BaseEmissive;
                float  _BeatBoost;
                float  _PulseSpeed;
                float  _ColorShift;
            CBUFFER_END

            // 由 C# BeatDetector 全局设置（不在 CBUFFER 中，避免 SRP Batcher 冲突）
            float _BeatIntensity;        // 全局 Shader 变量
            float _TimeSinceLastBeat;

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                VertexPositionInputs posInputs = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.positionHCS = posInputs.positionCS;
                OUT.positionWS  = posInputs.positionWS;
                OUT.normalWS    = TransformObjectToWorldNormal(IN.normalOS);
                OUT.uv = TRANSFORM_TEX(IN.uv, _MainTex);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                half4 albedo = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv) * _BaseColor;

                // ===== 节拍驱动自发光 =====
                // _BeatIntensity 从 C# BeatDetector 每帧传入
                float beat = _BeatIntensity;

                // 基础自发光 + 节拍时的爆发
                float emissiveMult = _BaseEmissive + beat * _BeatBoost;

                // 节拍颜色混合（节拍时颜色偏暖）
                half3 emissiveColor = lerp(_EmissiveColor.rgb, _BeatEmissiveColor.rgb, beat * _ColorShift);
                half3 emissive = emissiveColor * emissiveMult;

                // ===== 频谱 UV 扫描效果（可选）=====
                // 让材质表面随频谱高亮扫描
                float spectrumSweep = _TimeSinceLastBeat < 0.5 ?
                    smoothstep(0.5, 0.0, _TimeSinceLastBeat - IN.positionWS.x * 0.1) : 0.0;
                emissive += emissiveColor * spectrumSweep * 0.5;

                // ===== URP 标准光照 =====
                InputData inputData = (InputData)0;
                inputData.positionWS = IN.positionWS;
                inputData.normalWS   = normalize(IN.normalWS);
                inputData.viewDirectionWS = GetWorldSpaceNormalizeViewDir(IN.positionWS);
                inputData.shadowCoord = TransformWorldToShadowCoord(IN.positionWS);

                SurfaceData surfaceData = (SurfaceData)0;
                surfaceData.albedo    = albedo.rgb;
                surfaceData.emission  = emissive;
                surfaceData.smoothness = 0.6;
                surfaceData.alpha     = 1.0;

                return UniversalFragmentPBR(inputData, surfaceData);
            }
            ENDHLSL
        }
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
    }
}
```

### 节拍材质控制器 C# 脚本

```csharp
using UnityEngine;

// 将 BeatDetector 事件连接到具体材质/灯光效果
public class BeatMaterialController : MonoBehaviour
{
    [Header("目标")]
    public Renderer[] targetRenderers;   // 应用节拍效果的物体
    public Light[]    targetLights;      // 场景灯光

    [Header("灯光参数")]
    public float baseLightIntensity  = 1.0f;
    public float beatLightBoost      = 3.0f;
    public Gradient beatColorGradient; // 节拍颜色序列

    private BeatDetector beatDetector;
    private float beatCounter = 0;

    void Start()
    {
        beatDetector = BeatDetector.Instance;
        if (beatDetector != null)
            beatDetector.OnBeat += HandleBeat;
    }

    void HandleBeat(float intensity)
    {
        beatCounter++;
        // 每次节拍：灯光颜色按渐变序列推进
        Color beatColor = beatColorGradient.Evaluate(Mathf.PingPong(beatCounter * 0.1f, 1.0f));

        // 瞬间提升灯光亮度（后续在 Update 中衰减）
        foreach (var light in targetLights)
        {
            light.intensity = baseLightIntensity + beatLightBoost * intensity;
            light.color = Color.Lerp(light.color, beatColor, 0.7f);
        }
    }

    void Update()
    {
        if (beatDetector == null) return;

        // 灯光强度跟随 BeatIntensity 衰减
        float targetIntensity = baseLightIntensity + beatDetector.BeatIntensity * beatLightBoost;
        foreach (var light in targetLights)
            light.intensity = Mathf.Lerp(light.intensity, targetIntensity, Time.deltaTime * 15f);
    }

    void OnDestroy()
    {
        if (beatDetector != null)
            beatDetector.OnBeat -= HandleBeat;
    }
}
```

## 圆形频谱可视化 Shader

将频谱显示为圆形（常见于音乐播放器 UI）：

```hlsl
// 在 fragment shader 中，基于极坐标采样频谱
half4 frag(Varyings IN) : SV_Target
{
    float2 uv = IN.uv - 0.5; // 以中心为原点
    float r = length(uv);
    float angle = atan2(uv.y, uv.x) / (2.0 * 3.14159) + 0.5; // [0,1]

    // 采样对应角度的频谱强度
    float spectrum = SAMPLE_TEXTURE2D(_SpectrumTex, sampler_SpectrumTex, float2(angle, 0.5)).r;

    // 圆形基准半径
    float innerRadius = 0.3;
    float barHeight   = spectrum * 0.2; // 频谱柱高

    // 是否在频谱柱内
    float inBar = step(innerRadius, r) * step(r, innerRadius + barHeight);

    // 颜色：根据频谱强度从蓝到红渐变
    half3 color = lerp(half3(0.1, 0.3, 1.0), half3(1.0, 0.2, 0.1), spectrum);

    // 内圆（填充）
    float inInner = step(r, innerRadius);
    half3 finalColor = lerp(half3(0.05, 0.05, 0.1), color * 0.3, inInner);
    finalColor = lerp(finalColor, color, inBar);

    // 圆形遮罩（只显示圆形区域）
    float alpha = step(r, innerRadius + 0.21);

    return half4(finalColor, alpha);
}
```

## 性能考量

- **`GetSpectrumData` 调用频率**：每帧调用一次即可，Unity 内部使用 FFT 处理，1024 采样约 0.1ms CPU 开销
- **Texture1D 的代替方案**：Unity 不支持真正的 1D 纹理，用 `Texture2D(N, 1)` 代替。N 不超过 256 时开销可忽略
- **`Shader.SetGlobalTexture` vs `material.SetTexture`**：频谱数据是全局共享的，用 `SetGlobal` 一次调用覆盖所有使用该 Shader 的材质，避免逐材质设置
- **节拍检测精度**：43 帧历史窗口在 60fps 下约覆盖 0.7 秒，适合 BPM 60~180 的音乐。BPM 更高的音乐（>180）需要缩短历史窗口
- **AudioListener vs AudioSource**：`GetSpectrumData` 只能从 `AudioSource` 调用，不能从 `AudioListener` 调用。如果需要监听场景中所有声音的混音输出，使用 `AudioListener.GetOutputData`

音频与视觉的同步是游戏中最有冲击力的效果之一，几行 C# 代码 + 一个响应式 Shader，就能让整个场景跟着音乐"呼吸"——技术实现远比看起来简单。
