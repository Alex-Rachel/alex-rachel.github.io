# 第1篇｜SDF 2D：从形状到距离场

## 摘要

**SDF 2D**（Signed Distance Function 2D）是图形学中用数学函数定义二维形状的核心技术。它通过返回空间中任意点到形状边界的**有符号距离**来描述形状——正值表示点在形状外部，负值表示点在形状内部，零值表示恰好在边界上。这种描述方式使得形状的组合、变形、抗锯齿变得极为简洁。本篇将从距离场的数学定义出发，讲解圆形、矩形、多边形等基础 SDF 的实现，探讨平滑混合与边界渲染技巧，并给出 Unity HLSL 的适配版本。学完本篇后，你将能够用数学公式"画"出任意 2D 形状。

---

## 适用场景与问题定义

### 什么时候用 SDF 2D

SDF 2D 适用于以下场景：

1. **程序化 UI 图标** - 用代码生成几何图形，无需美术素材
2. **抗锯齿渲染** - SDF 的距离值可以精确计算边缘平滑
3. **形状布尔运算** - 多个 SDF 可以通过数学运算组合出复杂形状
4. **动画与变形** - 形状参数可以动态调整，产生缩放、扭曲效果
5. **GPU 粒子形状限制** - 用 SDF 定义粒子的空间约束

### 核心问题

如何用**一个标量值**描述一个二维形状的所有几何信息？

---

## 核心原理拆解

### 1. 有符号距离场的数学定义

对于平面上的任意点 $P = (x, y)$，SDF 函数 $f(P)$ 返回：

$$
f(P) = \begin{cases} 
< 0 & \text{如果 } P \text{ 在形状内部} \\
= 0 & \text{如果 } P \text{ 在形状边界上} \\
> 0 & \text{如果 } P \text{ 在形状外部}
\end{cases}
$$

这个定义确保了：
- 距离的**符号**告诉我们点在形状的哪一侧
- 距离的**绝对值**就是到边界的最短欧几里得距离

### 2. 基础图形的 SDF 公式

#### 圆形 (Circle)

圆心为 $C = (cx, cy)$，半径为 $r$ 的圆：

$$
f_{circle}(P) = |P - C| - r = \sqrt{(x - cx)^2 + (y - cy)^2} - r
$$

#### 矩形 (Rectangle)

左下角为 $(lx, ly)$，右上角为 $(hx, hy)$ 的轴对齐矩形：

$$
f_{rect}(P) = \max\left(|x - \frac{lx+hx}{2}| - \frac{hx-lx}{2}, |y - \frac{ly+hy}{2}| - \frac{hy-ly}{2}\right)
$$

更直观的写法——先平移到中心：

```glsl
// 计算点 P 到中心在 origin、尺寸为 b 的矩形的距离
float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;  // 到中心距离减去半尺寸
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
```

其中 `max(d, 0.0)` 取正部（点在外部时），`min(max(d.x, d.y), 0.0)` 取负部（点在内部时）。

#### 胶囊/线条 (Capsule/Line Segment)

连接两点 $a$ 和 $b$ 的线段，到线段的距离：

$$
f_{capsule}(P) = |P - a - \text{clamp}((P-a) \cdot \frac{b-a}{|b-a|}, 0, |b-a|)|
$$

### 3. 距离场的可视化

SDF 的距离值可以用条纹图案可视化：

```glsl
// 可视化 SDF 条纹
vec3 visualizeSDF(float d) {
    // 外部橙色，内部蓝色
    vec3 col = d > 0.0 ? vec3(0.9, 0.6, 0.3) : vec3(0.4, 0.7, 0.85);
    // 添加条纹表示距离变化
    col *= 0.8 + 0.2 * cos(150.0 * d);
    return col;
}
```

条纹的疏密程度直观反映了距离变化的"陡峭"程度——距离变化快的地方条纹密。

---

## Shader 实现思路

### 整体流程

```
输入：屏幕像素坐标 fragCoord
  ↓
坐标变换：fragCoord → 归一化 UV（中心为原点）
  ↓
计算各图形的 SDF 值
  ↓
形状布尔运算（取最小/最大/平滑混合）
  ↓
根据 SDF 值计算颜色
  ↓
输出：fragColor
```

### 顶点着色器 (Vertex Shader)

2D SDF 通常只需要全屏四边形，不需要复杂的顶点变换：

```glsl
// 顶点着色器 - 全屏四边形
#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
    v_uv = a_position * 0.5 + 0.5;  // [-1,1] → [0,1]
    gl_Position = vec4(a_position, 0.0, 1.0);
}
```

### 片元着色器 (Fragment Shader)

```glsl
// 片元着色器 - SDF 2D 圆形
#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;

// 圆形 SDF
float sdCircle(vec2 p, float r) {
    return length(p) - r;
}

void main() {
    // 坐标转换：中心为原点，Y轴向上
    vec2 uv = (2.0 * gl_FragCoord.xy - u_resolution) / u_resolution.y;
    
    // 计算圆形 SDF（半径 0.3）
    float d = sdCircle(uv, 0.3);
    
    // 简单着色：内部白色，外部黑色
    vec3 col = d < 0.0 ? vec3(1.0) : vec3(0.0);
    
    // 抗锯齿边缘
    col *= smoothstep(0.01, 0.0, abs(d));
    
    fragColor = vec4(col, 1.0);
}
```

---

## 关键代码片段

### 扩展图形库

```glsl
// ============ SDF 2D 图形库 ============

// 圆形
float sdCircle(vec2 p, float r) {
    return length(p) - r;
}

// 圆环（甜甜圈）
float sdRing(vec2 p, float r1, float r2) {
    return abs(sdCircle(p, (r1+r2)*0.5)) - (r2-r1)*0.5;
}

// 轴对齐矩形
float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// 旋转矩形
float sdRotatedBox(vec2 p, vec2 b, float angle) {
    mat2 rot = mat2(cos(angle), -sin(angle),
                    sin(angle),  cos(angle));
    vec2 q = rot * p;
    return sdBox(q, b);
}

// 等边三角形
float sdEquilateralTriangle(vec2 p, float size) {
    const float k = sqrt(3.0);
    p.x = abs(p.x) - size;
    p.y = p.y + size / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * size, 0.0);
    return -length(p) * sign(p.y);
}

// 六边形
float sdHexagon(vec2 p, float r) {
    const vec3 k = vec3(-0.866, 0.5, 0.577);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}

// ============ 布尔运算 ============

// 并集（取最小距离）
float opUnion(float d1, float d2) {
    return min(d1, d2);
}

// 差集（d1 - d2）
float opSubtraction(float d1, float d2) {
    return max(d1, -d2);
}

// 交集（取最大距离）
float opIntersection(float d1, float d2) {
    return max(d1, d2);
}

// 平滑并集（k 控制平滑程度）
float opSmoothUnion(float d1, float d2, float k) {
    float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) - k * h * (1.0 - h);
}

// 平滑差集
float opSmoothSubtraction(float d1, float d2, float k) {
    float h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0);
    return mix(d2, -d1, h) + k * h * (1.0 - h);
}
```

### Unity HLSL 适配版本

```hlsl
// Unity HLSL 适配
float sdCircle_float(float2 p, float r, out float d) {
    d = length(p) - r;
    return d;
}

float sdBox_float(float2 p, float2 b, out float d) {
    float2 q = abs(p) - b;
    d = length(max(q, 0)) + min(max(q.x, q.y), 0);
    return d;
}

float opSmoothUnion_float(float d1, float d2, float k) {
    float h = saturate(0.5 + 0.5 * (d2 - d1) / k);
    return lerp(d2, d1, h) - k * h * (1 - h);
}
```

---

## 性能优化要点

### 1. 避免在 SDF 内部使用分支

```glsl
// 低效写法 - 分支
float sdBoxInefficient(vec2 p, vec2 b) {
    vec2 q = abs(p) - b;
    if (q.x > 0.0 && q.y > 0.0) {
        return sqrt(q.x * q.x + q.y * q.y);  // 分支！
    }
    return max(q.x, q.y);
}

// 高效写法 - 矢量化操作，无分支
float sdBoxEfficient(vec2 p, vec2 b) {
    vec2 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
```

### 2. 使用 `length²` 避免平方根

当只需要比较距离而不需要精确值时，用 `dot(v,v)` 代替 `length(v)`：

```glsl
// 比较两个距离的相对大小
float d1 = length(p1);        // 需要平方根
float d2_squared = dot(p2, p2);  // 不要平方根
// 比较 d1 和 sqrt(d2_squared) 相当于比较 d1² 和 d2_squared
```

### 3. 减少重复计算

```glsl
// 低效：每次调用都计算 sin/cos
float sdRotatedShape(vec2 p, float angle) {
    mat2 rot = mat2(cos(angle), -sin(angle),
                    sin(angle),  cos(angle));  // 每次重建矩阵
    return sdBox(rot * p, vec2(0.5));
}

// 高效：预计算旋转矩阵
mat2 precomputedRot;
void init() {
    precomputedRot = mat2(cos(angle), -sin(angle),
                           sin(angle),  cos(angle));
}
float sdRotatedShapeFast(vec2 p) {
    return sdBox(precomputedRot * p, vec2(0.5));
}
```

### 4. 时间复杂度

| 操作 | 复杂度 |
|------|--------|
| 基本 SDF 计算 | O(1) |
| N 个形状并集 | O(N) |
| 平滑混合 | O(1) 额外开销 |
| 距离场查询（多次 SDF） | O(N) |

---

## 常见坑与调试方法

### 坑 1：坐标系统不匹配

**问题**：形状位置偏移或比例不对

**原因**：不同工具的 UV 坐标系不同

**调试方法**：
```glsl
// 在形状中心绘制十字准星
float d = sdCircle(uv, 0.3);
float crosshair = min(abs(uv.x), abs(uv.y));  // 到 X 和 Y 轴的距离
float viz = smoothstep(0.01, 0.0, crosshair);
col = mix(col, vec3(1,0,0), viz);  // 红色十字
```

### 坑 2：SDF 外部距离计算错误

**问题**：形状内部正确，但外部显示异常

**原因**：使用了错误的"负距离"处理逻辑

**调试方法**：用条纹可视化距离场
```glsl
// 如果条纹应该对称但不对称，说明 SDF 公式有问题
col = 0.5 + 0.5 * sin(100.0 * d);  // 观察条纹是否均匀
```

### 坑 3：平滑参数 k 过大导致变形

**问题**：平滑混合后形状边界出现非物理的凸起或凹陷

**原因**：k 值超过了较小形状的尺寸

**经验法则**：`k` 应该小于被混合的较小形状的尺寸

### 坑 4：性能在移动端暴增

**问题**：桌面端流畅但移动端卡顿

**原因**：GPU 的分支预取机制在移动端效率较低

**解决方案**：尽量使用 `step()`, `smoothstep()`, `min()`, `max()` 等无分支函数

---

## 与相近技术的对比

| 技术 | 原理 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| **SDF 2D** | 数学距离函数 | 无限分辨率、抗锯齿、布尔运算 | 需要数学基础 | 程序化图形、UI |
| **Texture 采样** | 纹理像素查询 | 任意复杂形状、照片级纹理 | 需要美术资源、内存占用 | 已有设计稿 |
| **贝塞尔曲线** | 参数化曲线 | 精确控制曲线形态 | 难以做布尔运算 | 字体、图标轮廓 |
| **像素着色** | 逐像素判断 | 最灵活 | 无法抗锯齿、无法缩放 | 低精度特效 |

**对比结论**：SDF 2D 是程序化生成 2D 形状的最佳选择，兼具数学精确性和计算效率。

---

## 实战案例：程序化圆角按钮

### 需求

用 SDF 实现一个圆角按钮，支持：
- 可调圆角半径
- 悬停时边框发光
- 点击时内凹效果

### 实现

```glsl
// 圆角按钮 SDF
vec4 sdRoundedButton(vec2 p, vec2 size, float radius, float borderWidth) {
    // 1. 计算主体矩形 SDF（留出边框空间）
    vec2 innerSize = size - vec2(borderWidth);
    float d = sdBox(p, innerSize - vec2(radius)) - radius;
    
    // 2. 边框宽度
    float border = smoothstep(radius, radius - 0.01, d);
    
    return vec4(d, border, 0.0, 0.0);  // d 用于后续计算
}

// 在片元着色器中使用
void main() {
    vec2 uv = /* 归一化坐标 */;
    
    // 按钮尺寸和圆角
    vec2 buttonSize = vec2(0.6, 0.2);
    float radius = 0.05;
    float borderWidth = 0.01;
    
    // 鼠标悬停效果
    float hover = smoothstep(0.0, 0.1, length(uv - u_mouse));
    float glow = exp(-10.0 * hover);
    
    // 点击效果
    float press = u_mouseDown ? -0.005 : 0.0;
    
    // 计算 SDF
    vec4 result = sdRoundedButton(uv + press, buttonSize, radius, borderWidth);
    float d = result.x + press;
    float border = result.y;
    
    // 着色
    vec3 col = mix(vec3(0.2), vec3(0.8), border * (1.0 + glow));
    
    // 抗锯齿边缘
    col *= smoothstep(0.01, 0.0, abs(d));
    
    fragColor = vec4(col, 1.0);
}
```

### 效果分析

- ✅ 任意分辨率下都清晰（数学精确）
- ✅ 圆角和边框可动态调整
- ✅ 悬停和点击效果用 SDF 值直接计算，无额外纹理
- ✅ 总渲染成本：O(1)

---

## 小结

本篇介绍了 SDF 2D 的核心概念：

1. **有符号距离场** - 用一个标量值描述二维形状
2. **基础图形 SDF** - 圆形、矩形、三角形、六边形等
3. **布尔运算** - Union、Subtraction、Intersection 及其平滑版本
4. **性能优化** - 避免分支、预计算、用 `dot` 代替 `length`
5. **调试技巧** - 可视化距离场、绘制准星

SDF 2D 是后续学习 SDF 3D、Ray Marching 的数学基础，值得熟练掌握。

---

## 延伸阅读与下一篇衔接

**延伸阅读**：
- Inigo Quilez - ["Distance Functions"](https://iquilezles.org/articles/distfunctions2d/)：SDF 之父的 2D SDF 教程
- ShaderToy - ["2D SDF Primitives"](https://www.shadertoy.com/view/3ltSW2)：实际运行示例

**前置知识**：
- 基本的向量运算（点积、叉积概念）
- 三角函数基础

**下一篇衔接**：
第 2 篇「程序化噪声：图形学的瑞士军刀」将介绍在 SDF 中同样重要的**程序化噪声**，包括 Value Noise、Perlin Noise、Simplex Noise 和 FBM（分形布朗运动）。噪声是驱动 SDF 变形、创建有机形态的核心工具。

---

## 知识点清单（Checklist）

- [ ] 理解有符号距离场的数学定义（正值/负值/零值的含义）
- [ ] 能够推导圆形 SDF 公式：$f(P) = |P - C| - r$
- [ ] 理解矩形 SDF 的 `max(d, 0) + min(max(d.x, d.y), 0)` 模式
- [ ] 掌握四种布尔运算：Union、Subtraction、Intersection、Smooth Union
- [ ] 理解平滑参数 k 的作用和取值经验
- [ ] 能够用条纹可视化方法调试 SDF
- [ ] 了解 SDF 与 Texture 采样的优缺点对比
- [ ] 掌握至少 3 种基础图形的 SDF 实现代码
- [ ] 理解 SDF 性能优化的核心原则（避免分支、预计算）
- [ ] 能够实现一个完整的 SDF 2D 案例（按钮、图标等）
