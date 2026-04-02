# 第4篇｜纹理采样：从像素到连续空间

## 摘要

**纹理采样（Texture Sampling）**是 GPU 渲染中将离散图像数据转换为连续视觉效果的数学基础。本篇将系统讲解从最近点采样到双线性插值、双三次插值的演进，深入剖析 **Mipmap** 的工作原理与带宽优化机制，探讨**各向异性采样**如何解决透视失真问题，并给出 GLSL 中的完整采样器实现。纹理采样连接了"数学定义的图形"与"视觉丰富度"，是制作高质量渲染效果的关键技术。

---

## 适用场景与问题定义

### 什么时候需要精细的纹理采样

1. **纹理放大/缩小时** - 避免模糊或锯齿
2. **远距离物体** - 需要 Mipmap 避免闪烁
3. **大角度倾斜表面** - 各向异性采样减少模糊
4. **程序化纹理** - 用数学函数生成纹理细节
5. **延迟着色** - GBuffer 中的纹理采样优化

### 核心问题

如何在离散像素网格上实现**连续、平滑、高质量**的图像采样？

---

## 核心原理拆解

### 1. 纹理坐标系统

#### UV 坐标

纹理坐标 $(u, v)$ 通常归一化到 $[0, 1]$ 范围：

```
v = 1
  +-----------------+
  | (0,1)    (1,1) |
  |                 |
  |                 |
  | (0,0)    (1,0) |
  +-----------------+
u = 0              u = 1
```

### 2. 采样过滤基础

#### 2.1 最近点采样 (Nearest Neighbor)

最简单的采样方式——选择距离最近的纹素：

```glsl
vec4 textureNearest(sampler2D tex, vec2 uv, vec2 texSize) {
    vec2 pixel = uv * texSize;        // 纹素坐标
    vec2 iPixel = floor(pixel + 0.5); // 四舍五入到最近纹素
    vec2 uvNearest = (iPixel) / texSize;
    return texture(tex, uvNearest);
}
```

**问题**：当纹理被放大时，能清晰看到块状像素。

#### 2.2 双线性插值 (Bilinear Interpolation)

在 2×2 纹素网格内进行线性插值：

```
    w01─────────w11
      │         │
      │    P    │
      │  (u,v) │
      │         │
    w00─────────w10
```

```glsl
vec4 textureBilinear(sampler2D tex, vec2 uv, vec2 texSize) {
    vec2 pixel = uv * texSize - 0.5;  // 纹素中心对齐
    vec2 iPixel = floor(pixel);
    vec2 fPixel = fract(pixel);
    
    // 四个角点的纹素坐标
    vec2 tl = (iPixel + vec2(0, 0)) / texSize;
    vec2 tr = (iPixel + vec2(1, 0)) / texSize;
    vec2 bl = (iPixel + vec2(0, 1)) / texSize;
    vec2 br = (iPixel + vec2(1, 1)) / texSize;
    
    // 读取四个角点的颜色
    vec4 c00 = texture(tex, tl);
    vec4 c10 = texture(tex, tr);
    vec4 c01 = texture(tex, bl);
    vec4 c11 = texture(tex, br);
    
    // X 方向插值
    vec4 c0 = mix(c00, c10, fPixel.x);
    vec4 c1 = mix(c01, c11, fPixel.x);
    
    // Y 方向插值
    return mix(c0, c1, fPixel.y);
}
```

**数学公式**：
$$f(u,v) = (1-u)(1-v)f_{00} + u(1-v)f_{10} + (1-u)vf_{01} + uvf_{11}$$

### 3. Mipmap 层级与细节级别

#### 为什么需要 Mipmap

当纹理被缩小（一个纹素覆盖多个像素）时，会产生**闪烁（aliasing）**和**摩尔纹（moire）**。Mipmap 通过预计算多个级别的模糊版本来解决这个问题。

#### Mipmap 链

```
Level 0: 256×256  (原始分辨率)
Level 1: 128×128  (1/4 面积)
Level 2: 64×64    (1/16 面积)
Level 3: 32×32
...
Level N: 1×1      (最终平均值)
```

#### Mipmap 级别计算

```glsl
// 计算 Mipmap 级别
float getMipLevel(vec2 uv, vec2 texSize) {
    vec2 dx = dFdx(uv) * texSize;  // 屏幕空间 U 方向的变化量
    vec2 dy = dFdy(uv) * texSize;  // 屏幕空间 V 方向的变化量
    float maxDD = max(dot(dx, dx), dot(dy, dy));  // 最大导数平方
    return 0.5 * log2(maxDD);  // log2 因为每级缩小一半
}

// 在 texture() 调用中自动处理
vec4 tex = texture(tex, uv);  // GPU 自动选择合适的 Mip 级别
vec4 texLod = textureLod(tex, uv, mipLevel);  // 手动指定级别
```

#### 三线性插值 (Trilinear)

在两个相邻 Mip 级别之间插值，消除级别切换时的跳跃感：

```glsl
vec4 textureTrilinear(sampler2D tex, vec2 uv, vec2 texSize) {
    float mipLevel = getMipLevel(uv, texSize);
    float mipLow = floor(mipLevel);
    float mipHigh = ceil(mipLevel);
    float t = fract(mipLevel);  // 两级之间的插值因子
    
    vec4 colorLow = textureLod(tex, uv, mipLow);
    vec4 colorHigh = textureLod(tex, uv, mipHigh);
    
    return mix(colorLow, colorHigh, t);
}
```

### 4. 各向异性采样

#### 问题

当纹理平面与观察方向有大角度时（如地面上的远处物体），纹素在屏幕上的投影不再是正方形，传统 Mipmap 会过度模糊。

```
     远处山丘
         ╲
          ╲ ← 纹理在屏幕上被压缩成窄条
           ╲
___________╲___________
   地面纹理（实际纹理是正方形）
```

#### 各向异性滤波

各向异性采样沿屏幕空间的压缩方向采样多个纹素，然后平均：

```glsl
// 简化的各向异性采样
vec4 textureAniso(sampler2D tex, vec2 uv, vec2 texSize, int samples) {
    vec2 dx = dFdx(uv) * texSize;
    vec2 dy = dFdy(uv) * texSize;
    
    // 计算主方向和其长度
    vec2 majorAxis = length(dx) >= length(dy) ? dx : dy;
    vec2 minorAxis = length(dx) >= length(dy) ? dy : dx;
    float majorLength = length(majorAxis);
    float minorLength = length(minorAxis);
    
    // 限制采样次数
    float anisoRatio = clamp(majorLength / minorLength, 1.0, float(samples));
    int numSamples = int(ceil(anisoRatio));
    numSamples = clamp(numSamples, 1, samples);
    
    vec4 result = vec4(0.0);
    float totalWeight = 0.0;
    
    for (int i = 0; i < samples; i++) {
        if (i >= numSamples) break;
        
        float t = float(i) / float(numSamples - 1) - 0.5;
        vec2 sampleUV = uv + majorAxis * t;
        
        // 根据距离调整 Mip 级别
        float mipLevel = getMipLevel(sampleUV, texSize) + log2(anisoRatio);
        result += textureLod(tex, sampleUV, mipLevel);
        totalWeight += 1.0;
    }
    
    return result / totalWeight;
}
```

---

## 关键代码片段

### 完整采样器实现

```glsl
// ============ 纹理采样工具库 ============

// 双线性插值采样
vec4 sampleBilinear(sampler2D tex, vec2 uv, vec2 texSize) {
    uv = clamp(uv, 0.0, 1.0);
    
    vec2 pixel = uv * texSize - 0.5;
    vec2 f = fract(pixel);
    vec2 i = floor(pixel);
    
    // 四角坐标
    vec2 tl = (i + vec2(0.5)) / texSize;
    vec2 tr = (i + vec2(1.5, 0.5)) / texSize;
    vec2 bl = (i + vec2(0.5, 1.5)) / texSize;
    vec2 br = (i + vec2(1.5, 1.5)) / texSize;
    
    // 读取颜色
    vec4 c00 = texture(tex, tl);
    vec4 c10 = texture(tex, tr);
    vec4 c01 = texture(tex, bl);
    vec4 c11 = texture(tex, br);
    
    // 双线性插值
    return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

// 双三次插值（使用 Catmull-Rom 样条）
vec4 sampleBicubic(sampler2D tex, vec2 uv, vec2 texSize) {
    uv = uv * texSize - 0.5;
    vec2 f = fract(uv);
    vec2 i = floor(uv);
    
    // Catmull-Rom 权重
    vec2 w0 = f * ( -0.5 + f * (1.0 - 0.5*f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5*f);
    vec2 w2 = f * ( 0.5 + f * (2.0 - 1.5*f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    
    // 采样点偏移
    vec2 g0 = w0.wx + w0.yz;
    vec2 g1 = w1.wx + w1.yz;
    vec2 g2 = w2.wx + w2.yz;
    vec2 g3 = w3.wx + w3.yz;
    
    // 四个双线性插值结果
    vec4 c00 = texture(tex, (i + g0 + 0.5) / texSize);
    vec4 c10 = texture(tex, (i + vec2(1,0) + g0 + 0.5) / texSize);
    vec4 c20 = texture(tex, (i + vec2(2,0) + g0 + 0.5) / texSize);
    vec4 c30 = texture(tex, (i + vec2(3,0) + g0 + 0.5) / texSize);
    
    vec4 c01 = texture(tex, (i + g1 + 0.5) / texSize);
    vec4 c11 = texture(tex, (i + vec2(1,0) + g1 + 0.5) / texSize);
    vec4 c21 = texture(tex, (i + vec2(2,0) + g1 + 0.5) / texSize);
    vec4 c31 = texture(tex, (i + vec2(3,0) + g1 + 0.5) / texSize);
    
    // ... 继续对其他行采样 ...
    
    // 简化版本：用双线性近似
    return sampleBilinear(tex, (i + 0.5 + (g1 + g2) * 0.5) / texSize, texSize);
}

// 程序化棋盘格纹理
vec4 proceduralCheckerboard(vec2 uv, float scale) {
    vec2 p = floor(uv * scale);
    float pattern = mod(p.x + p.y, 2.0);
    return mix(vec4(0.2), vec4(0.8), pattern);
}

// 程序化条纹纹理
vec4 proceduralStripes(vec2 uv, float scale, float thickness) {
    float stripe = smoothstep(0.0, thickness, fract(uv.x * scale));
    return mix(vec4(0.1, 0.1, 0.2, 1.0), vec4(0.9, 0.9, 0.8, 1.0), stripe);
}
```

---

## 性能优化要点

### 1. Mipmap 节省带宽

| Mip 级别 | 分辨率 | 每像素字节 | 带宽节省 |
|---------|-------|----------|---------|
| Level 0 | 2048×2048 | 4B | 1× |
| Level 1 | 1024×1024 | 4B | 4× |
| Level 2 | 512×512 | 4B | 16× |

**带宽计算**：Mipmap 总大小约为原图的 1.33 倍，但显著减少远距离像素的采样带宽。

### 2. 使用 `mediump`/`lowp` 精度

```glsl
// 颜色计算使用全精度
vec4 color = texture(highp sampler2D(tex), uv);  // 高精度

// 坐标计算可使用中等精度
mediump vec2 coord = uv * scale;  // 中等精度
```

### 3. 纹理缓存优化

GPU 使用 **cache line** 批量获取纹素，相邻像素访问相邻纹素时效率最高：

```glsl
// 好的访问模式（相邻像素访问相邻纹素）
for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
        vec4 c = texture(tex, uv + vec2(x, y) / texSize);  // 局部访问
    }
}

// 坏的访问模式（随机访问）
for (int i = 0; i < 16; i++) {
    vec2 randUV = randomUV();  // 完全随机，缓存效率低
    vec4 c = texture(tex, randUV);
}
```

### 4. 时间复杂度

| 采样类型 | 时间复杂度 |
|---------|----------|
| Nearest | O(1) |
| Bilinear | O(1) 4次读取 |
| Trilinear | O(1) 8次读取 |
| 各向异性 (N samples) | O(N) |

---

## 常见坑与调试方法

### 坑 1：纹理坐标超出 [0,1] 范围

**问题**：纹理重复显示或黑边

**原因**：UV 超出 [0,1] 范围，texture wrap 模式不对

**解决**：
```glsl
// 在采样时限制范围
vec2 safeUV = fract(uv);  // 重复纹理
// 或
vec2 safeUV = clamp(uv, 0.0, 1.0);  // 边缘截断
```

### 坑 2：Mipmap 级别计算错误导致闪烁

**问题**：物体边缘闪烁

**原因**：Mip 级别在相邻像素间变化过大

**解决**：使用 `textureGrad()` 显式传递梯度
```glsl
vec2 dx = dFdx(uv) * texSize;
vec2 dy = dFdy(uv) * texSize;
vec4 col = textureGrad(tex, uv, dx, dy);
```

### 坑 3：各向异性导致远处物体过暗

**问题**：远处纹理变暗

**原因**：各向异性采样对远处做了过度平均

**解决**：限制最大各向异性比率

### 坑 4：纹理内存占用过高

**问题**：显存不足

**原因**：纹理分辨率过高或 Mip 链不完整

**解决**：
- 使用纹理压缩（DXT/BC/ASTC）
- 生成完整的 Mip 链
- 考虑纹理图集（Atlas）减少绑定次数

---

## 与相近技术的对比

| 技术 | 质量 | 性能 | 内存 | 适用场景 |
|------|------|------|------|---------|
| Nearest | 最差 | 最高 | 最低 | 像素艺术、低性能 Debug |
| Bilinear | 中等 | 高 | 1× | 一般游戏 |
| Trilinear | 较好 | 中 | 1.33× | 多数游戏 |
| 各向异性 (16x) | 最好 | 较低 | 1.33× | 高品质渲染 |

**对比结论**：现代游戏至少使用 **Trilinear + Mipmap**，对品质要求高的使用 **各向异性 16x**。

---

## 实战案例：程序化砖墙纹理

### 需求

用程序化方式生成砖墙纹理，支持：
- 砖块排列和灰浆缝隙
- 随机砖块颜色变化
- 法线贴图（可选）
- 任意 UV 缩放

### 实现

```glsl
// 砖墙纹理生成器
struct BrickConfig {
    float brickWidth;      // 砖块宽度（UV 空间）
    float brickHeight;     // 砖块高度
    float mortarWidth;     // 灰浆宽度
    vec3 brickColor1;      // 砖块颜色 1
    vec3 brickColor2;      // 砖块颜色 2
    float colorVariation;  // 颜色变化强度
};

vec3 brickPattern(vec2 uv, BrickConfig cfg) {
    // 砖块间距
    float bw = cfg.brickWidth;
    float bh = cfg.brickHeight;
    float mw = cfg.mortarWidth;
    
    // 计算当前砖块坐标（奇数行错开半块）
    float row = floor(uv.y / bh);
    float offset = mod(row, 2.0) * 0.5 * bw;
    vec2 brickUV = vec2(uv.x + offset, uv.y);
    
    // 砖块内部坐标
    vec2 brick = fract(brickUV / vec2(bw, bh));
    
    // 灰浆区域检测
    float mx = step(mw / bw, brick.x) * step(brick.x, 1.0 - mw / bw);
    float my = step(mw / bh, brick.y) * step(brick.y, 1.0 - mw / bh);
    float isBrick = mx * my;
    
    // 砖块随机 ID（基于砖块索引）
    vec2 brickID = floor(brickUV / vec2(bw, bh));
    float brickHash = fract(sin(dot(brickID, vec2(127.1, 311.7))) * 43758.5453);
    
    // 砖块颜色插值
    vec3 brickColor = mix(cfg.brickColor1, cfg.brickColor2, brickHash);
    brickColor *= (0.8 + 0.2 * fract(sin(brickHash * 12.9898) * 43758.5453));  // 微变化
    
    // 灰浆颜色
    vec3 mortarColor = vec3(0.7);  // 浅灰色
    
    return mix(mortarColor, brickColor, isBrick);
}

// 砖墙法线贴图（简化版）
vec3 brickNormal(vec2 uv, BrickConfig cfg) {
    float eps = 0.001;
    vec3 n;
    n.x = brickPattern(uv + vec2(eps, 0), cfg).r - brickPattern(uv - vec2(eps, 0), cfg).r;
    n.y = brickPattern(uv + vec2(0, eps), cfg).r - brickPattern(uv - vec2(0, eps), cfg).r;
    n.z = 1.0;
    return normalize(n);
}

// 使用示例
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.y;  // 方形裁剪
    
    BrickConfig cfg;
    cfg.brickWidth = 0.25;
    cfg.brickHeight = 0.125;
    cfg.mortarWidth = 0.01;
    cfg.brickColor1 = vec3(0.6, 0.25, 0.2);
    cfg.brickColor2 = vec3(0.7, 0.35, 0.25);
    cfg.colorVariation = 0.2;
    
    vec3 col = brickPattern(uv * 2.0, cfg);  // 缩放 2x
    
    fragColor = vec4(col, 1.0);
}
```

---

## 小结

本篇介绍了纹理采样的核心概念：

1. **纹理坐标** - UV 系统及坐标范围
2. **双线性插值** - 2×2 纹素加权平均
3. **Mipmap** - 多级别预滤波，解决远距离闪烁
4. **三线性插值** - Mip 级别间平滑过渡
5. **各向异性采样** - 解决大角度表面模糊
6. **程序化纹理** - 用数学函数生成纹理细节

纹理采样是连接"数学图形"和"视觉细节"的桥梁。

---

## 延伸阅读与下一篇衔接

**延伸阅读**：
- Pharr & Humphreys - ["Physically Based Rendering"](https://pbr-book.org/)：纹理采样数学
- GPU Gems - ["Texture Transfer"](https://developer.nvidia.com/gpugems/gpugems/part-i-light/chapter-8-simulating-surface-detail)：高级纹理技术

**前置知识**：
- 向量代数基础
- 双线性插值概念

**下一篇衔接**：
第 5 篇「调色板：色彩数学与视觉映射」将介绍如何用数学方法生成和操作颜色——从 HSL/HSV 色彩空间到余弦调色板，从色阶生成到色彩对比。这些技术在程序化材质和后处理中极为重要。

---

## 知识点清单（Checklist）

- [ ] 理解 UV 坐标系统中 $(0,0)$ 和 $(1,1)$ 的位置
- [ ] 能够写出双线性插值的数学公式和代码实现
- [ ] 理解 Mipmap 的工作原理及带宽节省机制
- [ ] 掌握 Mip 级别的手动计算（使用 `dFdx`/`dFdy`）
- [ ] 理解三线性插值相对于双线性的优势
- [ ] 掌握各向异性采样解决的问题（远景大角度表面模糊）
- [ ] 了解 `textureLod`、`textureGrad` 与 `texture` 的区别和使用场景
- [ ] 能够实现一个程序化纹理（砖墙、大理石等）
- [ ] 理解纹理 Wrap 模式（Repeat/Clamp）对 UV 的影响
- [ ] 掌握纹理精度（highp/mediump/lowp）的选择原则
