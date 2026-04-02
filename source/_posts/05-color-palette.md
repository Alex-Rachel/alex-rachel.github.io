# 第5篇｜调色板：色彩数学与视觉映射

## 摘要

**调色板（Color Palette）**技术是程序化图形中的色彩核心工具。本篇将系统讲解从 HSL/HSV 到 Oklab 的色彩空间转换，剖析 **余弦调色板（Cosine Palette）** 的数学原理，探讨色阶生成、色彩对比与和谐配色的理论与实践。学习本篇后，你将能够用几行代码生成任意风格的色彩系统，为程序化材质和后处理效果奠定色彩基础。

---

## 适用场景与问题定义

### 什么时候需要程序化调色

1. **程序化材质** - 草地、皮肤、木材等需要自然色彩变化
2. **后处理** - 色调映射、色彩分级
3. **数据可视化** - 热力图、伪彩色、高度着色
4. **风格化渲染** - 卡通着色、赛博朋克色调
5. **昼夜循环** - 天空色彩随时间平滑过渡

### 核心问题

如何用**数学函数**而非预设色表来**连续、可控、富有表现力**地生成色彩？

---

## 核心原理拆解

### 1. 色彩空间基础

#### RGB 色彩空间

最常用的色彩空间，用红、绿、蓝三原色加法混合：

```
        青色
         ↑
    (0,1,0) ────→ 黄色
         |       / |
    绿色 |     /   |  蓝色
         |   /      |
         | /        |
    (0,0,1) ────→ (1,1,1) 白色
         ↓
       洋红
```

**问题**：RGB 不是感知均匀的——相同数值距离在不同颜色区域对人眼感知差异很大。

#### HSL 色彩空间

用色相 (Hue)、饱和度 (Saturation)、亮度 (Lightness) 表示颜色：

```glsl
// RGB 转 HSL
vec3 rgb2hsl(vec3 rgb) {
    float maxC = max(rgb.r, max(rgb.g, rgb.b));
    float minC = min(rgb.r, min(rgb.g, rgb.b));
    float l = (maxC + minC) * 0.5;
    
    if (maxC == minC) {
        return vec3(0.0, 0.0, l);  // 无色相（灰度）
    }
    
    float d = maxC - minC;
    float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    
    float h;
    if (maxC == rgb.r) {
        h = (rgb.g - rgb.b) / d + (rgb.g < rgb.b ? 6.0 : 0.0);
    } else if (maxC == rgb.g) {
        h = (rgb.b - rgb.r) / d + 2.0;
    } else {
        h = (rgb.r - rgb.g) / d + 4.0;
    }
    h /= 6.0;
    
    return vec3(h, s, l);
}

// HSL 转 RGB
vec3 hsl2rgb(vec3 hsl) {
    float h = hsl.x;
    float s = hsl.y;
    float l = hsl.z;
    
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = l - c * 0.5;
    
    vec3 rgb;
    if (h < 1.0/6.0) {
        rgb = vec3(c, x, 0.0);
    } else if (h < 2.0/6.0) {
        rgb = vec3(x, c, 0.0);
    } else if (h < 3.0/6.0) {
        rgb = vec3(0.0, c, x);
    } else if (h < 4.0/6.0) {
        rgb = vec3(0.0, x, c);
    } else if (h < 5.0/6.0) {
        rgb = vec3(x, 0.0, c);
    } else {
        rgb = vec3(c, 0.0, x);
    }
    
    return rgb + m;
}
```

#### Oklab 色彩空间（现代感知均匀空间）

由 Björn Ottosson 提出的新色彩空间，在色相维度完全感知均匀：

```glsl
// RGB 转 Oklab（简化版）
vec3 rgb2oklab(vec3 rgb) {
    // 线性化 RGB
    rgb = pow(rgb, vec3(2.2));
    
    // RGB 转 LMS
    mat3 M1 = mat3(
        0.4122214708, 0.5363325363, 0.0514459929,
        0.2119034982, 0.6806995451, 0.1073969566,
        0.0883024619, 0.2817188376, 0.6299787005
    );
    vec3 lms = M1 * rgb;
    
    // 对数变换
    lms = pow(lms, vec3(1.0/3.0));
    
    // LMS 转 Oklab
    mat3 M2 = mat3(
        0.2104542553, 0.7936177850, -0.0040720468,
        1.9779984951, -2.4285922050, 0.4505937099,
        0.0259040371, 0.7827717662, -0.8086757660
    );
    
    return M2 * lms;
}

vec3 oklab2rgb(vec3 oklab) {
    // Oklab 转 LMS
    mat3 M1_inv = mat3(
        4.0767416621, -3.3077115913, 0.2309699292,
        -1.2684380046, 2.6097574011, -0.3413193965,
        -0.0041960863, -0.7034186147, 1.7076147010
    );
    vec3 lms = M1_inv * oklab;
    
    // 逆对数变换
    lms = lms * lms * lms;
    
    // LMS 转 RGB
    mat3 M2_inv = mat3(
        4.0730451039, -1.7902116620, -0.0225604683,
        -1.0320121725, 2.2997178286, -0.1022032486,
        0.0014272391, -0.5086955709, 1.2044633473
    );
    vec3 rgb = M2_inv * lms;
    
    // 伽马校正
    rgb = pow(rgb, vec3(1.0/2.2));
    
    return clamp(rgb, 0.0, 1.0);
}
```

### 2. 余弦调色板 (Cosine Palette)

#### 数学原理

Inigo Quilez 提出的经典调色板生成算法，用余弦函数驱动色彩变化：

$$f(t) = a + b \cdot \cos(2\pi(c \cdot t + d))$$

```glsl
// 余弦调色板
// t: [0,1] 调色板位置
// a: 基础亮度偏移
// b: 振幅（对比度）
// c: 频率（颜色变化速度）
// d: 相位（颜色偏移）
vec3 cosinePalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(6.28318 * (c * t + d));
}

// 预设调色板
vec3 paletteRainbow(float t) {
    return cosinePalette(t, 
        vec3(0.5),           // 基础亮度
        vec3(0.5),           // 振幅
        vec3(1.0),           // 频率
        vec3(0.0, 0.33, 0.67)  // 相位错开 120 度
    );
}

vec3 paletteWarm(float t) {
    return cosinePalette(t,
        vec3(0.5, 0.4, 0.3),
        vec3(0.5, 0.4, 0.3),
        vec3(1.0, 1.0, 0.8),
        vec3(0.0, 0.15, 0.3)
    );
}

vec3 paletteCool(float t) {
    return cosinePalette(t,
        vec3(0.3, 0.4, 0.5),
        vec3(0.4, 0.4, 0.4),
        vec3(1.0, 1.0, 0.7),
        vec3(0.5, 0.6, 0.8)
    );
}

vec3 paletteEarth(float t) {
    return cosinePalette(t,
        vec3(0.3, 0.25, 0.2),
        vec3(0.7, 0.6, 0.5),
        vec3(1.0, 1.0, 0.5),
        vec3(0.0, 0.1, 0.2)
    );
}
```

### 3. 色阶生成 (Color Ramp)

从单色生成多层级色彩：

```glsl
// 高度着色（高度图转色彩）
vec3 heightToColor(float h, vec3 deep, vec3 shallow, vec3 sand, vec3 grass, vec3 rock, vec3 snow) {
    if (h < 0.3) return mix(deep, shallow, h / 0.3);
    if (h < 0.4) return mix(shallow, sand, (h - 0.3) / 0.1);
    if (h < 0.6) return mix(sand, grass, (h - 0.4) / 0.2);
    if (h < 0.8) return mix(grass, rock, (h - 0.6) / 0.2);
    return mix(rock, snow, (h - 0.8) / 0.2);
}

// 温度着色（热力图）
vec3 thermalColor(float t) {  // t in [0, 1]
    t = clamp(t, 0.0, 1.0);
    return vec3(
        t < 0.5 ? t * 2.0 : 1.0,  // R: 0 -> 1 -> 1
        t < 0.25 ? 0.0 : (t < 0.75 ? (t - 0.25) * 2.0 : 1.0),  // G: 0 -> 1 -> 1
        t > 0.5 ? (1.0 - t) * 2.0 : 1.0  // B: 1 -> 0
    );
}

// 赛博朋克调色
vec3 cyberpunkColor(float t) {
    vec3 pink = vec3(0.9, 0.3, 0.8);
    vec3 cyan = vec3(0.1, 0.9, 1.0);
    vec3 yellow = vec3(1.0, 0.9, 0.2);
    
    t = fract(t);
    if (t < 0.33) return mix(pink, cyan, t / 0.33);
    if (t < 0.66) return mix(cyan, yellow, (t - 0.33) / 0.33);
    return mix(yellow, pink, (t - 0.66) / 0.34);
}
```

---

## 关键代码片段

### 完整调色板库

```glsl
// ============ 调色板库 ============

// IQ 余弦调色板（最经典）
vec3 iqPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(6.28318 * (c * t + d));
}

// Material Design 色板
vec3 materialPalette(float t, vec3 primary) {
    // Material Design 色彩系统
    vec3 accent = 1.0 - primary;
    return mix(primary, accent, t);
}

// 渐变调色板（任意数量站点）
struct ColorStop {
    float pos;   // 位置 [0, 1]
    vec3 color;  // 颜色
};

vec3 gradientPalette(float t, ColorStop stops[5]) {
    // 寻找左右站点
    int leftIdx = 0;
    int rightIdx = stops.length() - 1;
    
    for (int i = 0; i < stops.length(); i++) {
        if (stops[i].pos <= t) leftIdx = i;
        if (stops[i].pos >= t && rightIdx == stops.length() - 1) rightIdx = i;
    }
    
    // 边界情况
    if (t <= stops[0].pos) return stops[0].color;
    if (t >= stops[rightIdx].pos) return stops[rightIdx].color;
    
    // 插值
    ColorStop left = stops[leftIdx];
    ColorStop right = stops[rightIdx];
    float localT = (t - left.pos) / (right.pos - left.pos);
    
    // 可使用 smoothstep 进行平滑
    localT = smoothstep(0.0, 1.0, localT);
    
    return mix(left.color, right.color, localT);
}

// 噪声驱动调色板偏移
vec3 noiseDrivenPalette(vec2 uv, float time) {
    // 获取基础噪声值
    float n = perlinNoise(uv * 3.0 + time * 0.1);
    n = n * 0.5 + 0.5;  // [0, 1]
    
    // 用噪声偏移调色板位置
    vec3 col = cosinePalette(n,
        vec3(0.5, 0.45, 0.4),
        vec3(0.5, 0.5, 0.5),
        vec3(1.0, 1.0, 0.8),
        vec3(0.0, 0.1, 0.2)
    );
    
    return col;
}

// HSV 辅助函数
vec3 hsv2rgb(vec3 hsv) {
    float h = hsv.x * 6.0;
    float s = hsv.y;
    float v = hsv.z;
    
    float c = v * s;
    float x = c * (1.0 - abs(mod(h, 2.0) - 1.0));
    float m = v - c;
    
    vec3 rgb;
    if (h < 1.0) rgb = vec3(c, x, 0.0);
    else if (h < 2.0) rgb = vec3(x, c, 0.0);
    else if (h < 3.0) rgb = vec3(0.0, c, x);
    else if (h < 4.0) rgb = vec3(0.0, x, c);
    else if (h < 5.0) rgb = vec3(x, 0.0, c);
    else rgb = vec3(c, 0.0, x);
    
    return rgb + m;
}

vec3 rgb2hsv(vec3 rgb) {
    float maxC = max(rgb.r, max(rgb.g, rgb.b));
    float minC = min(rgb.r, min(rgb.g, rgb.b));
    float d = maxC - minC;
    
    float h = 0.0;
    if (d > 0.0) {
        if (maxC == rgb.r) h = mod((rgb.g - rgb.b) / d, 6.0);
        else if (maxC == rgb.g) h = (rgb.b - rgb.r) / d + 2.0;
        else h = (rgb.r - rgb.g) / d + 4.0;
    }
    h /= 6.0;
    
    float s = maxC == 0.0 ? 0.0 : d / maxC;
    float v = maxC;
    
    return vec3(h, s, v);
}

// 基于色相的调色板
vec3 huePalette(float t, float hueStart, float hueEnd) {
    float h = mix(hueStart, hueEnd, t);
    return hsv2rgb(vec3(fract(h), 0.8, 0.9));
}
```

---

## 性能优化要点

### 1. 避免在片元着色器中做色彩空间转换

```glsl
// 低效：每像素计算色彩空间转换
for (int i = 0; i < paletteSize; i++) {
    vec3 hsv = rgb2hsv(palette[i]);  // 昂贵！
    palette[i] = hsv2rgb(vec3(hsv.x, hsv.y * 1.2, hsv.z));
}

// 高效：预计算或使用数学等效
vec3 fastAdjust(vec3 c) {
    // 在 RGB 空间近似调整饱和度
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    return mix(vec3(l), c, 1.2);  // 近似增加饱和度
}
```

### 2. 使用查找表 (LUT) 替代实时计算

```glsl
// 对于复杂的调色板，预计算为纹理
uniform sampler2D u_paletteLUT;  // 256x1 的调色板纹理

vec3 fastLookup(float t) {
    return texture(u_paletteLUT, vec2(t, 0.5)).rgb;
}
```

### 3. 利用 SIMD 并行

GPU 的 SIMD 架构使向量化的色彩运算非常高效：

```glsl
// 高效：向量运算
vec3 result = a + b * cos(6.28 * (c * t + d));  // 一次运算处理三个通道

// 低效：逐通道
float r = a.r + b.r * cos(6.28 * (c.r * t + d.r));
float g = a.g + b.g * cos(6.28 * (c.g * t + d.g));
float b = a.b + b.b * cos(6.28 * (c.b * t + d.b));  // 三次运算
```

---

## 常见坑与调试方法

### 坑 1：色彩超出 [0,1] 范围

**问题**：颜色出现负值或过曝

**原因**：余弦函数输出可能超出预期范围

**解决**：
```glsl
vec3 col = cosinePalette(t, a, b, c, d);
col = clamp(col, 0.0, 1.0);  // 安全限制
```

### 坑 2：调色板在边界处不连续

**问题**：颜色在 t=0 和 t=1 处跳跃

**原因**：首尾颜色差异过大

**解决**：确保首尾颜色接近，或使用 wrap 模式
```glsl
// 让调色板循环
vec3 cyclicPalette(float t) {
    return palette(fract(t));  // fract 自动循环
}
```

### 坑 3：饱和度/亮度数值不稳定

**问题**：小量色彩变化导致大视觉效果差异

**原因**：HSV 在低亮度时饱和度对噪声极度敏感

**解决**：使用 Oklab 或在 RGB 做小调整

### 坑 4：gamma 校正被忽略

**问题**：调色板在显示器上显示过暗

**原因**：显示器使用 sRGB gamma，着色器计算使用线性

**解决**：
```glsl
vec3 linearToSRGB(vec3 linear) {
    return pow(linear, vec3(1.0/2.2));
}
```

---

## 与相近技术的对比

| 技术 | 灵活性 | 性能 | 色彩品质 | 适用场景 |
|------|--------|------|---------|---------|
| 硬编码色表 | 差 | 最高 | 取决于美术 | 固定风格 |
| 余弦调色板 | 高 | 高 | 中等 | 程序化场景 |
| LUT 查找 | 中 | 高 | 最好 | 电影级调色 |
| HSL 插值 | 高 | 中 | 中等 | 简单渐变 |
| Oklab 插值 | 最高 | 中低 | 最好 | 感知均匀调色 |

**对比结论**：大多数程序化场景用 **余弦调色板 + clamp** 足够；对色彩精度要求高时用 **Oklab**。

---

## 实战案例：程序化日落天空

### 需求

实现一个程序化日落天空，具备：
- 渐变的日落色彩（天顶深蓝 → 地平线橙红）
- 太阳光晕
- 大气散射效果模拟

### 实现

```glsl
// 日落调色板
vec3 sunsetSky(float elevation) {
    // elevation: 0 = 地平线, 1 = 天顶
    // 余弦调色板生成平滑过渡
    vec3 zenith = vec3(0.05, 0.1, 0.3);      // 天顶：深蓝
    vec3 mid = vec3(0.4, 0.3, 0.2);         // 中间：暖橙
    vec3 horizon = vec3(0.9, 0.4, 0.1);     // 地平线：橙红
    vec3 glow = vec3(1.0, 0.8, 0.3);        // 光晕：金黄
    
    // 非线性插值，更真实
    float t = pow(elevation, 0.5);
    
    vec3 col;
    if (t < 0.3) {
        col = mix(glow, horizon, t / 0.3);
    } else if (t < 0.6) {
        col = mix(horizon, mid, (t - 0.3) / 0.3);
    } else {
        col = mix(mid, zenith, (t - 0.6) / 0.4);
    }
    
    return col;
}

// 太阳渲染
float sunDisc(vec2 uv, vec2 sunPos, float radius) {
    float d = length(uv - sunPos);
    return smoothstep(radius, radius * 0.8, d);
}

float sunGlow(vec2 uv, vec2 sunPos, float intensity) {
    float d = length(uv - sunPos);
    return intensity / (d * d + 0.01);  // 简单光晕
}

// 完整天空着色器
void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - u_resolution) / u_resolution.y;
    
    // 计算高度（uv.y 在这里是方向的角度）
    float elevation = max(uv.y * 0.5 + 0.5, 0.0);
    
    // 天空颜色
    vec3 skyColor = sunsetSky(elevation);
    
    // 太阳位置（稍微低于地平线）
    vec2 sunPos = vec2(0.5, 0.05);
    
    // 太阳光晕
    float glow = sunGlow(uv, sunPos, 0.02);
    skyColor += vec3(1.0, 0.6, 0.2) * glow;
    
    // 太阳圆盘
    float disc = sunDisc(uv, sunPos, 0.03);
    skyColor = mix(skyColor, vec3(1.0, 0.95, 0.8), disc);
    
    // Gamma 校正
    skyColor = pow(skyColor, vec3(1.0/2.2));
    
    fragColor = vec4(skyColor, 1.0);
}
```

---

## 小结

本篇介绍了调色板的核心概念：

1. **色彩空间** - RGB、HSL/HSV、Oklab 及其转换
2. **余弦调色板** - Inigo Quilez 的经典算法
3. **色阶生成** - 从单色到多色的程序化方法
4. **噪声调色** - 动态变化的色彩系统
5. **Gamma 校正** - 线性与 sRGB 的转换

调色板是程序化材质和后处理的色彩基础。

---

## 延伸阅读与下一篇衔接

**延伸阅读**：
- Inigo Quilez - ["Better Gradient Meshes"](https://iquilezles.org/articles/palettes/)：余弦调色板原文
- Björn Ottosson - ["A perceptual color space for image processing"](https://bottosson.github.io/posts/oklab/)：Oklab 色彩空间

**前置知识**：
- 基本三角函数
- RGB 色彩基础

**下一篇衔接**：
第 6 篇「SDF 3D：隐式曲面的数学语言」将把 SDF 从 2D 扩展到 3D，讲解 3D 基本体素 SDF 的公式推导，这是理解 Ray Marching 和复杂 3D 场景的基础。

---

## 知识点清单（Checklist）

- [ ] 理解 RGB 和 HSL/HSV 色彩空间的区别及转换方法
- [ ] 掌握余弦调色板的数学公式 $a + b \cdot \cos(2\pi(c \cdot t + d))$
- [ ] 能够实现基本的 RGB ↔ HSL 转换函数
- [ ] 理解 Oklab 色彩空间相对于 RGB 的优势（感知均匀）
- [ ] 掌握色阶生成（gradient）的实现方法
- [ ] 理解 Material Design、赛博朋克等常见调色风格的生成方式
- [ ] 知道 Gamma 校正的重要性及线性 ↔ sRGB 转换
- [ ] 能够实现一个完整的程序化天空着色器
- [ ] 理解调色板在 t=0 和 t=1 边界处不连续的问题及解决方法
- [ ] 掌握余弦调色板参数的物理含义（a=偏移, b=振幅, c=频率, d=相位）
