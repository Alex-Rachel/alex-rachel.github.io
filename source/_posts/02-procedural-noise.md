# 第2篇｜程序化噪声：图形学的瑞士军刀

## 摘要

**程序化噪声（Procedural Noise）**是现代图形学中最强大的工具之一，它通过数学函数生成看似随机的数值序列，广泛应用于地形生成、纹理合成、流体模拟、动画驱动等领域。本篇将系统讲解 **Value Noise**、**Perlin Noise**、**Simplex Noise** 和 **Worley Noise** 的数学原理与实现细节，深入剖析 **FBM（分形布朗运动）** 的层叠技巧，并讨论各类噪声的适用场景与性能权衡。程序化噪声不仅是 SDF 变形（Domain Warping）的核心驱动力，更是程序化内容生成的数学基石。

---

## 适用场景与问题定义

### 什么时候用程序化噪声

1. **程序化地形/云层** - 用噪声驱动高度场变化
2. **材质细节** - 生成大理石、木纹、皮肤毛孔等程序化纹理
3. **动画与运动** - 用噪声驱动角色动作、粒子运动
4. **有机形态变形** - Domain Warping 让刚性形状变得有机
5. **光影细节** - 噪声扰动法线、模拟粗糙表面散射

### 核心问题

如何生成**确定性**的**伪随机**值——即相同输入总是产生相同输出，同时在空间上具有**相关性**（相邻点值相近）？

---

## 核心原理拆解

### 1. 随机性与相关性的矛盾

纯随机数（如白噪声）在空间上没有相关性，生成的图案是"杂讯"：

```
纯随机：[0.8, 0.1, 0.9, 0.2, 0.7, 0.3, 0.95, 0.15]
        ↑  无空间相关性 ↑
```

而程序化噪声在相邻位置产生**平滑过渡**的值：

```
平滑噪声：[0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95]
          ↑  相邻点值接近 ↑
```

### 2. Value Noise（值噪声）

#### 数学原理

Value Noise 通过在网格顶点存储随机值，然后进行**插值**得到连续的值：

**步骤 1**：在整数网格点 $(i, j)$ 上生成伪随机值 $V(i,j)$

```glsl
// 基于哈希函数的网格点值生成
float hash(vec2 p) {
    // 将 2D 坐标哈希到 [0, 1] 的值
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// 在网格点 (i,j) 的值
float gridValue(vec2 ij) {
    return hash(ij);  // 伪随机但确定性的值
}
```

**步骤 2**：对连续坐标 $(x, y)$ 进行插值

$$
f(x, y) = \text{lerp}\left(\text{lerp}(V(\lfloor x \rfloor, \lfloor y \rfloor), V(\lceil x \rceil, \lfloor y \rfloor), f_x), \text{lerp}(V(\lfloor x \rfloor, \lceil y \rceil), V(\lceil x \rceil, \lceil y \rceil), f_x), f_y\right)
$$

其中 $f_x = x - \lfloor x \rfloor$，$f_y = y - \lfloor y \rfloor$，$\text{lerp}(a, b, t) = a + (b-a)t$。

**平滑插值（平滑阶跃）**：

```glsl
// 使用平滑阶跃代替线性插值，消除块状感
float smootherstep(float x) {
    return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

float smoothlerp(float a, float b, float t) {
    return a + (b - a) * smootherstep(t);
}
```

### 3. Perlin Noise（柏林噪声）

#### 数学原理

Perlin Noise 的核心思想是用**梯度向量**代替 Value Noise 的随机标量值：

1. 在网格顶点存储一个随机单位**梯度向量** $G(i,j)$
2. 对于任意点 $P$，计算它到四个顶点的**距离向量**
3. 计算每个顶点的**点积** $G \cdot (P - V_{ij})$
4. 对四个点积值进行**平滑插值**

```glsl
// 生成随机梯度方向
vec2 randomGradient(vec2 p) {
    // 将随机方向编码到一个圆上
    float angle = hash(p) * 6.283185;  // 2π
    return vec2(cos(angle), sin(angle));
}

// Perlin Noise 实现
float perlinNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    // 四个角点的梯度
    vec2 g00 = randomGradient(i + vec2(0, 0));
    vec2 g10 = randomGradient(i + vec2(1, 0));
    vec2 g01 = randomGradient(i + vec2(0, 1));
    vec2 g11 = randomGradient(i + vec2(1, 1));
    
    // 距离向量（从角点指向当前点）
    vec2 d00 = f - vec2(0, 0);
    vec2 d10 = f - vec2(1, 0);
    vec2 d01 = f - vec2(0, 1);
    vec2 d11 = f - vec2(1, 1);
    
    // 点积
    float v00 = dot(g00, d00);
    float v10 = dot(g10, d10);
    float v01 = dot(g01, d01);
    float v11 = dot(g11, d11);
    
    // 平滑插值
    vec2 u = f * f * (3.0 - 2.0 * f);  // smootherstep
    
    return mix(
        mix(v00, v10, u.x),
        mix(v01, v11, u.x),
        u.y
    );
}
```

**Perlin vs Value Noise**：Perlin 的梯度插值在所有方向上具有一致的视觉特性（各向同性），而 Value Noise 在对角线方向有时会出现视觉不连续。

### 4. Simplex Noise

#### 数学原理

Simplex Noise 由 Ken Perlin 改进，解决了 Perlin Noise 在高维时的计算效率问题。核心思想是用**单形**（三角形/四面体）代替网格单元：

```glsl
// Simplex 2D Noise 实现（简化版）
float simplexNoise(vec2 p) {
    const float K1 = 0.366025;  // (sqrt(3)-1)/2
    const float K2 = 0.211324;  // (3-sqrt(3))/6
    
    // 偏斜变换：将网格偏斜到单形顶点
    vec2 i = floor(p + (p.x + p.y) * K1);
    vec2 a = p - i + (i.x + i.y) * K2;
    
    // 确定是哪个三角形单元
    vec2 o = a.x > a.y ? vec2(1, 0) : vec2(0, 1);
    
    // 三个顶点的偏移
    vec2 b = a - o + K2;
    vec2 c = a - 1.0 + 2.0 * K2;
    
    // 计算贡献值
    float get Contribution(vec2 x, vec2 g) {
        float t = 0.5 - dot(x, x);
        return t * t * t * dot(x, g);
    }
    
    // 梯度计算（与 Perlin 类似但使用不同的方向）
    vec2 grad = vec2(hash(i) * 2.0 - 1.0);
    
    float n = 0.0;
    n += contribution(a, randomGradient(i));
    n += contribution(b, randomGradient(i + o));
    n += contribution(c, randomGradient(i + 1.0));
    
    return 70.0 * n;  // 归一化因子
}
```

**Simplex vs Perlin**：
- 计算复杂度：Simplex O(N²) vs Perlin O(N²) 在 2D 相近，但 3D+ 时 Simplex 更优
- 视觉：Simplex 的各向同性更好，没有 Perlin 的"轴对齐"痕迹

### 5. Worley Noise（Voronoi Noise）

#### 数学原理

Worley Noise 基于 **Voronoi 图**——空间被分割为到各特征点最近距离的区域：

```glsl
// Worley Noise - 到最近特征点的距离
float worleyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    float minDist = 1.0;
    
    // 检查周围 3x3 邻域的特征点
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 point = hash(i + neighbor);  // 伪随机特征点位置
            
            float d = length(neighbor + point - f);
            minDist = min(minDist, d);
        }
    }
    
    return minDist;
}

// 变体：F2 - F1（细胞边缘距离，用于裂纹效果）
float worleyEdge(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    float f1 = 1.0;
    float f2 = 1.0;
    
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 point = hash(i + neighbor);
            
            float d = length(neighbor + point - f);
            
            if (d < f1) {
                f2 = f1;
                f1 = d;
            } else if (d < f2) {
                f2 = d;
            }
        }
    }
    
    return f2 - f1;  // 细胞边缘到最近边缘的距离
}
```

---

## 关键代码片段

### FBM（分形布朗运动）

FBM 通过叠加不同频率（octave）的噪声来创建自然细节：

```glsl
// FBM - 分形布朗运动
float fbm(vec2 p, int octaves) {
    float value = 0.0;      // 累计值
    float amplitude = 0.5;  // 初始振幅
    float frequency = 1.0;  // 初始频率
    
    for (int i = 0; i < octaves; i++) {
        value += amplitude * perlinNoise(p * frequency);
        amplitude *= 0.5;   // 每次减半振幅
        frequency *= 2.0;   // 每次倍增频率
    }
    
    return value;
}

// ridged noise（山脊噪声）- 用于悬崖、山脉
float ridgedNoise(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    
    for (int i = 0; i < octaves; i++) {
        float n = perlinNoise(p * frequency);
        value += amplitude * (1.0 - abs(n));  // 反转并取绝对值，形成山脊
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return value;
}

// turbulence（湍流噪声）- 用于火焰、熔岩
float turbulence(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    
    for (int i = 0; i < octaves; i++) {
        value += amplitude * abs(perlinNoise(p * frequency));
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return value;
}
```

### 完整噪声库

```glsl
// ============ 完整噪声库 ============

// 哈希函数
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), 
             dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

// 2D Value Noise
float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    float a = hash(i);
    float b = hash(i + vec2(1, 0));
    float c = hash(i + vec2(0, 1));
    float d = hash(i + vec2(1, 1));
    
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 2D Perlin Noise
float perlinNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    vec2 u = f * f * (3.0 - 2.0 * f);
    
    return mix(
        mix(dot(hash2(i) * 2.0 - 1.0, f),
            dot(hash2(i + vec2(1,0)) * 2.0 - 1.0, f - vec2(1,0)), u.x),
        mix(dot(hash2(i + vec2(0,1)) * 2.0 - 1.0, f - vec2(0,1)),
            dot(hash2(i + vec2(1,1)) * 2.0 - 1.0, f - vec2(1,1)), u.x),
        u.y
    ) * 0.5 + 0.5;
}

// Worley Noise
float worleyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    
    float minDist = 1.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 point = hash2(i + neighbor);
            float d = length(neighbor + point - f);
            minDist = min(minDist, d);
        }
    }
    return minDist;
}

// FBM 封装
float fbm(vec2 p, int octaves, float lacunarity, float gain) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    float totalAmplitude = 0.0;
    
    for (int i = 0; i < octaves; i++) {
        value += amplitude * perlinNoise(p * frequency);
        totalAmplitude += amplitude;
        frequency *= lacunarity;
        amplitude *= gain;
    }
    
    return value / totalAmplitude;  // 归一化
}
```

---

## 性能优化要点

### 1. 减少采样次数

FBM 的 octave 数量直接影响性能：

| Octave 数 | 适用场景 |
|-----------|---------|
| 3-4 | 移动端、低性能需求 |
| 6 | 桌面端默认值 |
| 8+ | 电影级品质 |

### 2. 使用低精度哈希

```glsl
// 高精度但较慢
float hashHighPrec(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 低精度但较快（适合移动端）
float hashLowPrec(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 0.0001) * 10000.0;
}
```

### 3. 避免在噪声函数内部分支

```glsl
// 低效写法
float slowNoise(vec2 p) {
    float result = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i < octaves) {  // 分支！
            result += ...;
        }
    }
    return result;
}

// 高效写法
float fastNoise(vec2 p) {
    float result = 0.0;
    for (int i = 0; i < 8; i++) {
        result += step(float(i), float(octaves)) * (...);
    }
    return result;
}
```

### 4. 时间复杂度

| 噪声类型 | 时间复杂度 | 空间复杂度 |
|---------|----------|-----------|
| Value Noise | O(1) 单次采样 | 无 |
| Perlin Noise | O(1) 单次采样 | 无 |
| Worley Noise | O(9) 固定邻域 | 无 |
| FBM (n octaves) | O(n) | 无 |

---

## 常见坑与调试方法

### 坑 1：噪声结果不归一化

**问题**：不同参数下噪声值范围差异大，难以复用

**原因**：FBM 累加后值可能超出 [0,1]

**解决方法**：
```glsl
// FBM 归一化处理
float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    float maxValue = 0.0;  // 累计最大值
    
    for (int i = 0; i < octaves; i++) {
        value += amplitude * perlinNoise(p * frequency);
        maxValue += amplitude;  // 理论最大值
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return value / maxValue;  // 归一化到 [0,1]
}
```

### 坑 2：低频噪声产生"拉伸"感

**问题**：地形或纹理有明显的方向性拉伸

**原因**：噪声采样方向与预期不符

**解决方法**：旋转噪声采样轴
```glsl
// 旋转45度采样
vec2 rotatedP = mat2(0.707, -0.707, 0.707, 0.707) * p;
float n = perlinNoise(rotatedP);
```

### 坑 3：Voronoi 边缘不连续

**问题**：相邻像素的 Worley 边缘值不同

**原因**：每个像素独立计算，没有跨像素一致性

**解决方法**：使用基于特征点而非像素的确定性采样

### 坑 4：移动端纹理走样

**问题**：纹理在缩放时出现摩尔纹

**原因**：没有使用 Mipmap 或各向异性采样

**Unity 解决方案**：启用各向异性纹理过滤

---

## 与相近技术的对比

| 技术 | 特性 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| **Value Noise** | 哈希插值 | 最快、最省内存 | 对角线痕迹明显 | 移动端、性能敏感 |
| **Perlin Noise** | 梯度插值 | 各向同性好 | 计算稍复杂 | 程序化纹理、地形 |
| **Simplex Noise** | 单形插值 | 无拉伸、高维高效 | 实现复杂 | 高品质地形、云层 |
| **Worley Noise** | Voronoi 图 | 天然细胞结构 | 边缘可能锯齿 | 裂纹、细胞、宝石 |

**对比结论**：大多数场景优先使用 **Perlin Noise** 或 **Simplex Noise**；需要细胞/裂纹效果时使用 **Worley Noise**。

---

## 实战案例：程序化地形高度图

### 需求

生成一个程序化岛屿地形，具备：
- 中央隆起、边缘下降（模拟岛屿）
- 多层细节（海岸线、山脉）
- 自然噪声驱动

### 实现

```glsl
// 高度图生成
float getHeight(vec2 p) {
    // 1. 岛屿遮罩 - 中心高，边缘低
    float distFromCenter = length(p);
    float islandMask = 1.0 - smoothstep(0.0, 0.8, distFromCenter);
    
    // 2. 大尺度地形（低频 FBM）
    float largeScale = fbm(p * 2.0, 4);
    
    // 3. 中尺度细节（中频 FBM）
    float mediumScale = fbm(p * 4.0 + largeScale, 4);
    
    // 4. 小尺度细节（高频 FBM）
    float smallScale = fbm(p * 16.0, 3);
    
    // 5. 组合各层
    float height = 0.0;
    height += largeScale * 0.5;      // 基础起伏
    height += mediumScale * 0.3;     // 中等细节
    height += smallScale * 0.1;      // 表面细节
    height += ridgedNoise(p * 3.0, 3) * 0.2;  // 山脊
    
    // 6. 应用岛屿遮罩
    height *= islandMask;
    
    // 7. 调整范围到 [0, 1]
    height = height * 0.5 + 0.5;
    
    return height;
}

// 着色器中使用
void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - u_resolution) / u_resolution.y;
    
    float h = getHeight(p);
    
    // 根据高度着色
    vec3 col;
    if (h < 0.3) {
        col = mix(vec3(0.0, 0.1, 0.3), vec3(0.0, 0.3, 0.5), h / 0.3);  // 深海
    } else if (h < 0.4) {
        col = mix(vec3(0.0, 0.3, 0.5), vec3(0.2, 0.6, 0.8), (h-0.3)/0.1);  // 浅海
    } else if (h < 0.45) {
        col = vec3(0.9, 0.8, 0.6);  // 沙滩
    } else if (h < 0.7) {
        col = mix(vec3(0.2, 0.5, 0.1), vec3(0.3, 0.4, 0.2), (h-0.45)/0.25);  // 草地
    } else if (h < 0.85) {
        col = mix(vec3(0.3, 0.4, 0.2), vec3(0.5, 0.5, 0.5), (h-0.7)/0.15);  // 岩石
    } else {
        col = mix(vec3(0.5, 0.5, 0.5), vec3(1.0), (h-0.85)/0.15);  // 山顶雪
    }
    
    fragColor = vec4(col, 1.0);
}
```

---

## 小结

本篇介绍了程序化噪声的核心概念：

1. **噪声的本质** - 确定性、空间相关的伪随机序列
2. **Value Noise** - 最基础但有对角线痕迹
3. **Perlin Noise** - 梯度插值，各向同性好
4. **Simplex Noise** - 单形插值，高维更优
5. **Worley Noise** - Voronoi 图，天然细胞结构
6. **FBM** - 层叠噪声，创建自然细节

噪声是程序化图形的"瑞士军刀"，掌握好它可以生成无限丰富的自然效果。

---

## 延伸阅读与下一篇衔接

**延伸阅读**：
- Ken Perlin - ["Improving Noise"](https://mrl.nyu.edu/~perlin/paper445.pdf)：Simplex Noise 原始论文
- Inigo Quilez - ["Noise - Voronoi"](https://iquilezles.org/articles/voronoise/)：Worley/Voronoi 噪声详解

**前置知识**：
- 向量基础运算
- 插值函数（lerp, smootherstep）

**下一篇衔接**：
第 3 篇「矩阵变换：相机与坐标系统」将介绍 GPU 渲染中不可或缺的**矩阵变换**——从模型矩阵到投影矩阵，从欧拉角到四元数。这些数学工具是构建 3D 世界的基础，也是理解坐标空间转换的关键。

---

## 知识点清单（Checklist）

- [ ] 理解程序化噪声"确定性"和"空间相关性"两个核心特性
- [ ] 能够解释 Value Noise 和 Perlin Noise 的核心区别
- [ ] 理解 Simplex Noise 的"单形"思想及其相对 Perlin 的优势
- [ ] 掌握 Worley Noise 的 Voronoi 原理及其变体（F2-F1 边缘检测）
- [ ] 能够实现完整的 FBM 函数并理解各参数作用
- [ ] 理解ridged noise 和 turbulence noise 的生成方式
- [ ] 掌握噪声结果归一化的重要性及实现方法
- [ ] 了解不同噪声类型的性能差异和使用场景
- [ ] 能够用程序化噪声生成一个有说服力的地形案例
- [ ] 理解噪声在 SDF 变形（Domain Warping）中的应用
