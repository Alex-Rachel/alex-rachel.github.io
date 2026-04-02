# 第7篇｜法线估算：曲面细节的精确表达

## 摘要

**法线（Normal）**是渲染中最重要的几何信息之一，它决定了光线如何与表面交互。本篇将讲解如何从 SDF（尤其是 SDF 3D）计算表面法线，包括**有限差分法（Finite Differences）**和**四面体法（Tetrahedron Method）**两种主流算法，分析法线估算的精度与性能权衡，并给出 Unity HLSL 的适配实现。法线估算的正确实现直接决定了光照和阴影的质量。

---

## 适用场景与问题定义

### 什么时候需要计算法线

1. **光照计算** - Lambert/Phong/PBR 等光照模型都需要法线
2. **阴影计算** - 软阴影的 ray shadow 需要沿法线方向步进
3. **环境映射** - 反射需要法线计算反射方向
4. **纹理映射** - 法线贴图扰动需要原始法线作为输入

### 核心问题

如何从离散的 SDF 值快速准确地估算连续曲面的法线方向？

---

## 核心原理拆解

### 1. 法线的数学定义

对于曲面 $S: f(x, y, z) = 0$，曲面在某点的**法线**是**梯度向量**：

$$\vec{N} = \nabla f = \left(\frac{\partial f}{\partial x}, \frac{\partial f}{\partial y}, \frac{\partial f}{\partial z}\right)$$

对于 SDF，$f(P) = 0$ 的等值面就是曲面表面。SDF 的梯度方向恰好指向曲面的法线方向。

### 2. 有限差分法 (Finite Differences)

#### 原理

用差分近似偏导数：

$$\frac{\partial f}{\partial x} \approx \frac{f(x+\epsilon) - f(x-\epsilon)}{2\epsilon}$$

类似地计算 $y$ 和 $z$ 方向的偏导数，然后归一化：

```glsl
vec3 calcNormal(vec3 p) {
    const float eps = 0.001;
    vec2 e = vec2(eps, 0.0);
    
    // 中心差分
    float nx = map(p + e.xyy).x - map(p - e.xyy).x;
    float ny = map(p + e.yxy).x - map(p - e.yxy).x;
    float nz = map(p + e.yyx).x - map(p - e.yyx).x;
    
    return normalize(vec3(nx, ny, nz));
}
```

#### 精度分析

| 差分类型 | 公式 | 精度 |
|---------|------|------|
| 前向差分 | $(f(x+\epsilon) - f(x))/\epsilon$ | O(ε) |
| 后向差分 | $(f(x) - f(x-\epsilon))/\epsilon$ | O(ε) |
| **中心差分** | $(f(x+\epsilon) - f(x-\epsilon))/(2\epsilon)$ | O(ε²) |

### 3. 四面体法 (Tetrahedron Method)

#### 原理

在四面体的四个顶点上采样 SDF 值，根据值的大小关系确定法线方向：

```glsl
vec3 calcNormalTetrahedron(vec3 p) {
    const float eps = 0.001;
    vec3 e = vec3(eps, -eps, 0.0);
    
    // 四面体四个顶点的偏移
    return normalize(
        e.xyy * map(p + e.xyy).x +
        e.yyx * map(p + e.yyx).x +
        e.yxy * map(p + e.yxy).x +
        e.xxx * map(p + e.xxx).x
    );
}
```

**数学原理**：四个采样点的加权组合直接给出了梯度方向。

### 4. 自动微分 (Automatic Differentiation)

对于纯数学函数，可以使用链式法则精确计算导数：

```glsl
// 简化的自动微分结构
struct AD {
    float value;
    vec3 derivative;
};

AD adSqrt(AD x) {
    float sqrtVal = sqrt(x.value);
    return AD(
        sqrtVal,
        0.5 * x.derivative / sqrtVal
    );
}

AD adMul(AD a, AD b) {
    return AD(
        a.value * b.value,
        a.derivative * b.value + a.value * b.derivative
    );
}
```

---

## 关键代码片段

### 完整法线计算库

```glsl
// ============ 法线计算库 ============

// 方法 1：中心差分法
vec3 calcNormalCentralDiff(vec3 p, float eps) {
    vec2 e = vec2(eps, 0.0);
    float nx = map(p + e.xyy).x - map(p - e.xyy).x;
    float ny = map(p + e.yxy).x - map(p - e.yxy).x;
    float nz = map(p + e.yyx).x - map(p - e.yyx).x;
    return normalize(vec3(nx, ny, nz));
}

// 方法 2：四面体法（更高效，只需 4 次 SDF 查询）
vec3 calcNormalTetrahedron(vec3 p, float eps) {
    vec3 e = vec3(eps, -eps, 0.0);
    return normalize(
        e.xyy * map(p + e.xyy).x +
        e.yyx * map(p + e.yyx).x +
        e.yxy * map(p + e.yxy).x +
        e.xxx * map(p + e.xxx).x
    );
}

// 方法 3：前向差分（只在光线前进方向采样，更快但精度低）
vec3 calcNormalForwardDiff(vec3 p, vec3 rd, float eps) {
    vec2 e = vec2(0.0, eps);
    float base = map(p).x;
    float nx = map(p + e.yxx).x - base;
    float ny = map(p + e.xyx).x - base;
    float nz = map(p + e.xxy).x - base;
    return normalize(vec3(nx, ny, nz));
}

// Unity HLSL 适配
float3 CalcNormalHLSL(float3 pos, float eps) {
    float2 e = float2(eps, 0);
    float nx = SceneSDF(pos + float3(e.x, e.y, e.y)) 
             - SceneSDF(pos - float3(e.x, e.y, e.y));
    float ny = SceneSDF(pos + float3(e.y, e.x, e.y)) 
             - SceneSDF(pos - float3(e.y, e.x, e.y));
    float nz = SceneSDF(pos + float3(e.y, e.y, e.x)) 
             - SceneSDF(pos - float3(e.y, e.y, e.x));
    return normalize(float3(nx, ny, nz));
}

// 带材质 ID 的法线计算
struct SurfaceHit {
    float dist;
    int materialID;
    vec3 normal;
};

SurfaceHit rayMarchWithNormal(vec3 ro, vec3 rd) {
    float t = 0.0;
    SurfaceHit hit;
    hit.materialID = 0;
    
    for (int i = 0; i < 128; i++) {
        vec3 p = ro + rd * t;
        vec2 res = map(p);
        
        if (res.x < 0.001) {
            hit.dist = t;
            hit.materialID = int(res.y);
            hit.normal = calcNormalTetrahedron(p, 0.001);
            return hit;
        }
        
        t += res.x;
        if (t > 100.0) break;
    }
    
    hit.dist = -1.0;
    return hit;
}
```

---

## 性能优化要点

### 1. 减少 SDF 查询次数

| 方法 | SDF 查询次数 | 精度 |
|------|------------|------|
| 中心差分 | 6 次 | 高 |
| 四面体法 | 4 次 | 中高 |
| 前向差分 | 3 次 | 中 |

### 2. 动态 epsilon

```glsl
// 根据距离调整 epsilon
vec3 calcNormalAdaptive(vec3 p) {
    // 远处用更大的 epsilon，减少噪点
    float scale = 1.0 / (1.0 + length(p) * 0.1);
    float eps = 0.001 * scale;
    return calcNormalTetrahedron(p, eps);
}
```

### 3. 时间复杂度

| 操作 | 时间复杂度 |
|------|--------|
| 中心差分 | O(6·map) |
| 四面体法 | O(4·map) |
| 预计算法线 | O(1) |

---

## 常见坑与调试方法

### 坑 1：epsilon 太大导致法线不准确

**问题**：曲面平坦区域法线正确，但曲率大的区域法线偏离

**原因**：epsilon 相对于曲率半径过大

**解决**：对高曲率区域使用更小的 epsilon

### 坑 2：epsilon 太小导致数值不稳定

**问题**：法线出现随机噪声

**原因**：epsilon 小于浮点精度

**解决**：`epsilon = 0.001 ~ 0.01` 是通常的安全范围

### 坑 3：法线未归一化

**问题**：光照计算结果过亮或过暗

**解决**：始终 `normalize()` 计算后的法线

---

## 与相近技术的对比

| 技术 | 精度 | 性能 | 适用场景 |
|------|------|------|---------|
| **解析法线** | 数学精确 | 取决于函数 | 简单几何 |
| **差分估算** | 近似 | 中 | SDF |
| **顶点法线** | 插值精度 | 高 | 传统 Mesh |
| **法线贴图** | 高频细节 | 中 | 表面细节 |

---

## 实战案例：带法线的 PBR 光照

```glsl
vec3 pbrLighting(vec3 p, vec3 n, vec3 albedo, float roughness, vec3 lightDir, vec3 viewDir) {
    // Fresnel-Schlick
    vec3 F0 = vec3(0.04);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(viewDir, n), 0.0), 5.0);
    
    // 漫反射
    vec3 diff = (vec3(1.0) - F) * albedo / 3.14159;
    
    // GGX 镜面反射
    float NdotH = max(dot(n, normalize(viewDir + lightDir)), 0.0);
    float alpha = roughness * roughness;
    float D = alpha * alpha / (3.14159 * pow(NdotH * NdotH * (alpha * alpha - 1.0) + 1.0, 2.0));
    
    // 几何遮蔽
    float G = min(1.0, 2.0 * NdotH * max(dot(viewDir, n)) / max(dot(viewDir, normalize(viewDir + lightDir)), 0.001));
    
    vec3 spec = D * F * G / (4.0 * max(dot(viewDir, n), 0.001));
    
    return diff + spec;
}

void main() {
    vec3 p = /* 命中点 */;
    vec3 n = calcNormalTetrahedron(p, 0.001);
    vec3 col = pbrLighting(p, n, albedo, roughness, lightDir, viewDir);
    fragColor = vec4(col, 1.0);
}
```

---

## 小结

本篇介绍了法线估算的核心概念：
1. 法线的数学定义（梯度向量）
2. 中心差分法与四面体法
3. Unity HLSL 适配
4. 性能优化与常见坑

---

## 延伸阅读与下一篇衔接

**前置知识**：SDF 3D（第 6 篇）

**下一篇**：第 8 篇「光照模型」将讲解 Phong、Blinn-Phong、PBR 等光照模型的数学原理与实现。

---

## 知识点清单（Checklist）

- [ ] 理解法线是 SDF 梯度向量 $\nabla f$
- [ ] 掌握中心差分法的公式和代码
- [ ] 理解四面体法只需 4 次 SDF 查询的原理
- [ ] 知道 epsilon 取值过大/过小的问题
- [ ] 掌握带材质 ID 的法线计算
- [ ] 理解不同法线计算方法的精度与性能权衡
