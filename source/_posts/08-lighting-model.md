# 第8篇｜光照模型：Phong → PBR 的演进

## 摘要

**光照模型（Lighting Model）**是渲染的核心，决定了物体表面的视觉外观。本篇将系统讲解从 **Phong**、**Blinn-Phong** 到 **PBR（Physically Based Rendering）** 的演进历程，深入剖析 **Cook-Torrance** BRDF 的数学推导，讲解 **能量守恒**、**Fresnel 反射**、**微表面分布（GGX）** 等核心概念。通过本篇学习，你将能够实现高质量的实时光照着色器。

---

## 适用场景与问题定义

### 什么时候需要光照模型

1. **3D 渲染** - 任何 3D 场景的基本着色
2. **材质系统** - 不同材质（金木石水）需要不同光照响应
3. **风格化渲染** - 卡通、赛博朋克等需要定制光照
4. **后处理** - Bloom、环境光遮蔽需要光照信息

### 核心问题

如何用数学模型准确描述**光线与表面材质交互**的物理规律？

---

## 核心原理拆解

### 1. 光照的基本组成

光照 = **直接光照**（来自光源）+ **间接光照**（环境反射）

直接光照又分为：
- **漫反射 (Diffuse)**：光线进入表面内部，向各方向均匀散射
- **镜面反射 (Specular)**：光线在表面直接反射

### 2. Phong 模型

#### 数学公式

$$L = k_d \cdot I_d \cdot \max(\hat{N} \cdot \hat{L}, 0) + k_s \cdot I_s \cdot \max(\hat{R} \cdot \hat{V}, 0)^n$$

其中：
- $\hat{N}$：法线方向
- $\hat{L}$：光线方向
- $\hat{R} = 2(\hat{N} \cdot \hat{L})\hat{N} - \hat{L}$：反射方向
- $\hat{V}$：视线方向
- $k_d, k_s$：漫反射和镜面反射系数
- $n$：光泽度（越大高光越集中）

```glsl
vec3 phongLighting(vec3 p, vec3 n, vec3 v, vec3 lightPos, vec3 lightColor, 
                   vec3 albedo, float shininess) {
    vec3 l = normalize(lightPos - p);
    vec3 r = reflect(-l, n);
    vec3 v_dir = normalize(-v);
    
    // 漫反射
    float diff = max(dot(n, l), 0.0);
    vec3 diffuse = albedo * diff;
    
    // 镜面反射
    float spec = pow(max(dot(r, v_dir), 0.0), shininess);
    vec3 specular = lightColor * spec;
    
    return diffuse + specular;
}
```

### 3. Blinn-Phong 模型

#### 改进

用**半程向量 (Half Vector)** $\hat{H} = \frac{\hat{L} + \hat{V}}{|\hat{L} + \hat{V}|}$ 代替反射方向：

```glsl
vec3 blinnPhongLighting(vec3 p, vec3 n, vec3 v, vec3 lightPos, vec3 lightColor,
                        vec3 albedo, float roughness) {
    vec3 l = normalize(lightPos - p);
    vec3 h = normalize(l + v);
    
    float diff = max(dot(n, l), 0.0);
    float spec = pow(max(dot(n, h), 0.0), 1.0 / (roughness * roughness));
    
    return albedo * diff + lightColor * spec;
}
```

**优点**：计算更简单，且在高光掠射角时更自然。

### 4. PBR (Cook-Torrance BRDF)

#### 核心思想

PBR 基于**微表面理论 (Microfacet Theory)**：表面由无数微小镜面组成，每个微表面的朝向由法线分布函数 (NDF) 描述。

#### BRDF 公式

$$f_r(\omega_i, \omega_o) = \frac{D \cdot F \cdot G}{4(\hat{N} \cdot \hat{L})(\hat{N} \cdot \hat{V})}$$

其中：
- **D (NDF)**：法线分布函数，描述微表面法线的统计分布
- **F (Fresnel)**：Fresnel 方程，描述不同角度的反射率
- **G (Geometry)**：几何遮蔽函数，描述微表面间的自遮蔽

#### GGX 法线分布

$$D_{GGX}(N, H, \alpha) = \frac{\alpha^2}{\pi((N \cdot H)^2(\alpha^2-1)+1)^2}$$

```glsl
float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH * NdotH;
    
    float num = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = 3.14159 * denom * denom;
    
    return num / denom;
}
```

#### Fresnel-Schlick 近似

$$F_{Schlick} = F_0 + (1 - F_0)(1 - \cos\theta)^5$$

```glsl
vec3 fresnelSchlick(float cosTheta, vec3 F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}
```

#### 几何遮蔽 (Smith's Schlick-GGX)

$$G_{Smith}(N, V, L, k) = \frac{(N \cdot V)}{(N \cdot V)(1-k)+k} \cdot \frac{(N \cdot L)}{(N \cdot L)(1-k)+k}$$

```glsl
float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = roughness + 1.0;
    float k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    return GeometrySchlickGGX(NdotV, roughness) * GeometrySchlickGGX(NdotL, roughness);
}
```

#### 完整 PBR 着色器

```glsl
vec3 PBR(vec3 p, vec3 n, vec3 v, vec3 lightPos, vec3 lightColor,
          vec3 albedo, float metallic, float roughness) {
    vec3 l = normalize(lightPos - p);
    vec3 h = normalize(v + l);
    
    // 基础反射率
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    
    // Fresnel
    vec3 F = fresnelSchlick(max(dot(h, v), 0.0), F0);
    
    // NDF (GGX)
    float D = DistributionGGX(n, h, roughness);
    
    // 几何遮蔽
    float G = GeometrySmith(n, v, l, roughness);
    
    // Cook-Torrance BRDF
    vec3 numerator = D * F * G;
    float denominator = 4.0 * max(dot(n, v), 0.0) * max(dot(n, l), 0.0) + 0.0001;
    vec3 spec = numerator / denominator;
    
    // 能量守恒：漫反射 = 1 - Fresnel（金属没有漫反射）
    vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
    vec3 diffuse = kD * albedo / 3.14159;
    
    // 最终光照
    float NdotL = max(dot(n, l), 0.0);
    return (diffuse + spec) * lightColor * NdotL;
}
```

---

## 性能优化要点

### 1. 预计算常数值

```glsl
// 高效：预计算 1/π
const float INV_PI = 1.0 / 3.14159;
const float INV_2PI = 1.0 / 6.28318;
```

### 2. 避免在光照计算中归一化中间向量

```glsl
// 如果 v 和 l 已归一化，h 只需近似归一化
vec3 h = normalize(v + l);  // 已足够精确
```

---

## 小结

本篇介绍了光照模型的演进：
1. Phong → Blinn-Phong → PBR 的发展
2. PBR 的三大核心：D (NDF)、F (Fresnel)、G (Geometry)
3. 能量守恒原则

---

## 延伸阅读

- Disney PBR Paper: ["Physically-Based Shading at Disney"](https://disney-animation.s3.amazonaws.com/library/s2012_pbs_disney_brdf_notes_v2.pdf)

**前置知识**：法线估算（第 7 篇）

**下一篇**：第 9 篇「阴影技术」将讲解硬阴影到软阴影的实现。

---

## 知识点清单（Checklist）

- [ ] 理解 Phong 模型的两个部分：漫反射 + 镜面反射
- [ ] 理解 Blinn-Phong 的半程向量改进
- [ ] 掌握 PBR 的三大核心：NDF、Fresnel、Geometry
- [ ] 理解 GGX 法线分布函数的数学形式
- [ ] 理解能量守恒：漫反射 = 1 - Fresnel
- [ ] 能够实现完整的 PBR 着色器
