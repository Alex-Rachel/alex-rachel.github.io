# 第6篇｜SDF 3D：隐式曲面的数学语言

## 摘要

**SDF 3D（Signed Distance Function 3D）**是 3D 图形学中用数学函数定义三维形状的核心范式。与 2D SDF 用标量距离描述曲线边界不同，3D SDF 用标量距离描述曲面边界——曲面上任意点的 SDF 值为零，曲面的"内部"为负，"外部"为正。本篇将推导球体、立方体、胶囊、环面等基本 3D 图形的 SDF 公式，讲解 SDF 的组合运算（Union、Intersection、Subtraction、Smooth Blend），并通过 Ray Marching 算法展示这些 SDF 如何被用于实际渲染。

---

## 适用场景与问题定义

### 什么时候用 SDF 3D

1. **程序化 3D 建模** - 用数学公式创建复杂 3D 形状
2. **Ray Marching 渲染** - SDF 是 Ray Marching 的核心数据结构
3. **碰撞检测** - SDF 可快速判断点与曲面的距离关系
4. **物理模拟** - 流体表面、建筑破坏等需要动态变形的场景
5. **3D 打印切片** - 从 SDF 提取等值面生成打印路径

### 核心问题

如何用**单一数学函数**描述一个**封闭的三维曲面**，使得曲面上的点满足 $f(P) = 0$？

---

## 核心原理拆解

### 1. SDF 3D 的数学定义

对于三维空间中的任意点 $P = (x, y, z)$，SDF 函数 $f(P)$ 返回到最近曲面的有符号距离：

$$
f(P) = \begin{cases} 
< 0 & \text{如果 } P \text{ 在形状内部} \\
= 0 & \text{如果 } P \text{ 在形状表面上} \\
> 0 & \text{如果 } P \text{ 在形状外部}
\end{cases}
$$

**关键性质**：

1. **准确性**：$|f(P)|$ 正好等于 $P$ 到曲面的最短欧几里得距离
2. **梯度性**：$\nabla f(P)$ 指向最近表面点的法线方向
3. **可组合性**：多个 SDF 可以通过布尔运算组合

### 2. 基本 3D 图形的 SDF

#### 2.1 球体 (Sphere)

球心为 $C = (cx, cy, cz)$，半径为 $r$：

$$
f_{sphere}(P) = |P - C| - r = \sqrt{(x-cx)^2 + (y-cy)^2 + (z-cz)^2} - r
$$

```glsl
float sdSphere(vec3 p, float r) {
    return length(p) - r;
}
```

#### 2.2 立方体 (Box)

尺寸为 $(b_x, b_y, b_z)$ 的轴对齐立方体：

$$
f_{box}(P) = |P| - B \text{，其中} B = (b_x, b_y, b_z)
$$

更精确的公式需要考虑内部情况：

```glsl
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;  // 到中心距离减去半尺寸
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
    // 外部：到表面的距离 = 长度
    // 内部：到表面的距离 = 到最大面的垂直距离
}
```

#### 2.3 胶囊 (Capsule) / 圆柱段

连接两点 $a$ 和 $b$、半径为 $r$ 的线段：

```glsl
// 胶囊 SDF
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a;  // 点到 a 的向量
    vec3 ba = b - a;  // 线段方向
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);  // 投影系数
    return length(pa - h * ba) - r;
}
```

#### 2.4 环面 (Torus)

主半径 $R$（管中心到环中心的距离），管半径 $r$：

```glsl
float sdTorus(vec3 p, vec2 t) {
    // t.x = 主半径 R, t.y = 管半径 r
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
}
```

#### 2.5 平面 (Plane)

通过点 $P_0$、法线为 $n$（已归一化）的平面：

```glsl
float sdPlane(vec3 p, vec3 n, float h) {
    // n 是平面法线（归一化），h 是平面到原点的距离
    return dot(p, n) + h;
    // 或通过平面上一点:
    // return dot(p - planePoint, n);
}
```

#### 2.6 圆柱 (Cylinder)

```glsl
float sdCylinder(vec3 p, vec3 c) {
    // c.x = 半径, c.y = 高度的一半
    return max(length(p.xz) - c.x, abs(p.y) - c.y);
}
```

### 3. SDF 布尔运算

多个 SDF 可以通过数学运算组合成更复杂的形状。

#### 3.1 Union（并集）

取两者的最小距离：

```glsl
float opUnion(float d1, float d2) {
    return min(d1, d2);
}

// 带有材质 ID 的版本
vec2 opUnion(vec2 d1, vec2 d2) {
    return d1.x < d2.x ? d1 : d2;  // 返回距离更近的那个
}
```

#### 3.2 Subtraction（差集）

从 d1 中减去 d2：

```glsl
float opSubtraction(float d1, float d2) {
    return max(d1, -d2);
}
```

#### 3.3 Intersection（交集）

取两者的最大距离：

```glsl
float opIntersection(float d1, float d2) {
    return max(d1, d2);
}
```

#### 3.4 Smooth Union（平滑并集）

平滑混合两个形状，避免生硬的边界：

```glsl
float opSmoothUnion(float d1, float d2, float k) {
    // k 控制平滑程度，值越大越平滑
    float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) - k * h * (1.0 - h);
}
```

**数学原理**：
```glsl
// 近似解释：
// 当 d1 ≈ d2 时，SDF 过渡到两者之间
// 当 |d1 - d2| >> k 时，形状保持各自独立
```

---

## 关键代码片段

### 扩展 3D 图形库

```glsl
// ============ SDF 3D 图形库 ============

// 球体
float sdSphere(vec3 p, float r) {
    return length(p) - r;
}

// 立方体（轴对齐）
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// 立方体（任意方向）
float sdOrientedBox(vec3 p, vec3 a, vec3 b, float th) {
    float l = length(b - a);
    vec3 d = (b - a) / l;
    vec3 q = p - (a + b) * 0.5;
    q = mat3(d.x, d.y, d.z, -d.z, d.x, d.y, -d.y, -d.x, d.z) * q;
    q = abs(q) - vec3(l, th, th) * 0.5;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// 胶囊
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - h * ba) - r;
}

// 环面
float sdTorus(vec3 p, vec2 t) {
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
}

// 圆柱
float sdCylinder(vec3 p, vec3 c) {
    return length(p.xz - c.xy) - c.z;
}

// 圆锥
float sdCone(vec3 p, vec2 c, float h) {
    vec2 q = h * vec2(c.x/c.y, -1.0);
    vec2 w = vec2(length(p.xz), p.y);
    vec2 a = w - q * clamp(dot(w,q) / dot(q,q), 0.0, 1.0);
    vec2 b = w - q * vec2(clamp(w.x/q.x, 0.0, 1.0), 1.0);
    float k = sign(q.y);
    float d = min(dot(a, a), dot(b, b));
    float s = max(k * (w.x*q.y - w.y*q.x), k * (w.y - q.y));
    return sqrt(d) * sign(s);
}

// 八面体
float sdOctahedron(vec3 p, float s) {
    p = abs(p);
    return (p.x + p.y + p.z - s) * 0.57735027;
}

// 圆环结
float sdTorus Knot(vec3 p, vec2 t, float ra, float rb) {
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(vec2(length(q) - ra, p.z)) - rb;
}

// ============ 布尔运算 ============

float opUnion(float d1, float d2) { return min(d1, d2); }
float opSubtraction(float d1, float d2) { return max(-d1, d2); }
float opIntersection(float d1, float d2) { return max(d1, d2); }

float opSmoothUnion(float d1, float d2, float k) {
    float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) - k * h * (1.0 - h);
}

float opSmoothSubtraction(float d1, float d2, float k) {
    float h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0);
    return mix(d2, -d1, h) + k * h * (1.0 - h);
}

float opSmoothIntersection(float d1, float d2, float k) {
    float h = clamp(0.5 - 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) + k * h * (1.0 - h);
}
```

---

## 性能优化要点

### 1. 利用 SDF 的 Lipschitz 常数

SDF 的梯度模长恒等于 1（或略小于 1），这保证了 Ray Marching 的收敛性。

### 2. 避免在 SDF 函数内部创建分支

```glsl
// 低效
float sdBoxSlow(vec3 p, vec3 b) {
    if (length(p) > 10.0) {  // 分支
        return length(p) - 1.0;
    }
    return ...;
}

// 高效：使用数学操作代替分支
float sdBoxFast(vec3 p, vec3 b) {
    vec3 clamped_p = clamp(p, -b, b);
    return length(p - clamped_p);
}
```

### 3. 时间复杂度

| 操作 | 时间复杂度 |
|------|-----------|
| 单个基本 SDF | O(1) |
| N 个形状 Union | O(N) |
| Smooth Union | O(1) 额外开销 |

---

## 常见坑与调试方法

### 坑 1：SDF 值不是真正的最短距离

**问题**：形状内部出现瑕疵

**原因**：某些 SDF 实现在大圆角或复杂几何上不够精确

**解决**：使用 IQ 的优化版本 SDF

### 坑 2：Smooth Union 的 k 值过大

**问题**：形状边界出现非物理的凸起

**经验法则**：k 值应小于被混合形状的最小尺寸

### 坑 3：Ray Marching 在凹面处步进过多

**问题**：U 形或凹陷区域渲染很慢

**原因**：SDF 梯度方向与光线方向夹角大

**解决**：使用自适应步长或增加最大步数

---

## 与相近技术的对比

| 技术 | 精度 | 性能 | 适用场景 |
|------|------|------|---------|
| **SDF 3D** | 数学精确 | O(N) 组合 | 程序化 3D、Ray Marching |
| **Mesh** | 顶点精度有限 | 高 | 传统渲染 |
| **体素** | 取决于分辨率 | 中 | Minecraft 式世界 |
| **隐式曲面** | 数学精确 | 中 | 几何建模 |

---

## 实战案例：Ray Marching SDF 场景

```glsl
#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;

// SDF 场景
vec2 map(vec3 p) {
    // 地面
    float ground = p.y + 0.75;
    
    // 球体
    float sphere = sdSphere(p - vec3(0.0, 0.0, 0.0), 0.5);
    
    // 立方体
    float box = sdBox(p - vec3(1.0, 0.0, 0.0), vec3(0.3));
    
    // 光滑并集
    float obj = opSmoothUnion(sphere, box, 0.3);
    
    return vec2(min(ground, obj), 1.0);  // vec2(distance, materialID)
}

// Ray Marching
vec2 rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        vec3 p = ro + rd * t;
        vec2 d = map(p);
        if (d.x < 0.001) return vec2(t, d.y);
        t += d.x;
        if (t > 100.0) break;
    }
    return vec2(-1.0, 0.0);
}

void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - u_resolution) / u_resolution.y;
    
    // 相机设置
    vec3 ro = vec3(2.0, 1.0, 2.0);  // 相机位置
    vec3 ta = vec3(0.0, 0.0, 0.0);  // 观察目标
    vec3 ww = normalize(ta - ro);
    vec3 uu = normalize(cross(ww, vec3(0,1,0)));
    vec3 vv = cross(uu, ww);
    vec3 rd = normalize(uv.x*uu + uv.y*vv + 2.0*ww);
    
    vec2 hit = rayMarch(ro, rd);
    vec3 col = hit.x > 0.0 ? vec3(0.5) : vec3(0.1);
    
    fragColor = vec4(col, 1.0);
}
```

---

## 小结

本篇介绍了 SDF 3D 的核心概念：
1. SDF 3D 的数学定义与性质
2. 基本 3D 图形的 SDF 公式
3. 布尔运算及其平滑版本
4. SDF 与 Ray Marching 的结合

---

## 延伸阅读与下一篇衔接

**延伸阅读**：
- Inigo Quilez - ["Distance Functions"](https://iquilezles.org/articles/distfunctions/)

**前置知识**：SDF 2D（第 1 篇）

**下一篇**：第 7 篇「法线估算」将讲解如何从 SDF 计算表面法线，这是光照计算的必要输入。

---

## 知识点清单（Checklist）

- [ ] 理解 SDF 3D 的数学定义（内部负/表面零/外部正）
- [ ] 掌握至少 5 种基本 3D 图形的 SDF 公式
- [ ] 理解 Smooth Union 的数学原理和 k 值选取
- [ ] 能够实现带材质 ID 的 SDF 布尔运算
- [ ] 理解 SDF 的 Lipschitz 性质
- [ ] 掌握 Ray Marching 的基本实现流程
