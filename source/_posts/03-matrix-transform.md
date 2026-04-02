# 第3篇｜矩阵变换：相机与坐标系统

## 摘要

**矩阵变换（Matrix Transform）**是图形渲染的数学基础，贯穿顶点着色器到片段着色器的全过程。本篇将系统讲解二维/三维坐标系统、仿射变换与齐次坐标、平移-旋转-缩放矩阵、相机 LookAt 矩阵、投影矩阵（正交与透视）的推导与实现。深入剖析欧拉角与四元数的优劣对比，最后给出 Unity Shader 中的实际应用案例。掌握矩阵变换，你才能真正理解 GPU 如何将顶点从模型空间一步步变换到屏幕空间。

---

## 适用场景与问题定义

### 什么时候用矩阵变换

1. **3D 物体移动/旋转/缩放** - 将模型顶点从局部坐标系变换到世界坐标系
2. **相机控制** - FPS 游戏、轨道相机、跟随相机
3. **透视校正** - 2D UI 在 3D 空间中的透视效果
4. **骨骼动画** - 多矩阵级联变换实现角色动画
5. **阴影投影** - 将阴影从物体投影到地面

### 核心问题

如何在 GPU 中高效地表达和组合**平移、旋转、缩放**这三种基本变换？

---

## 核心原理拆解

### 1. 坐标系统与齐次坐标

#### 为什么需要齐次坐标？

普通 3D 向量 $(x, y, z)$ 无法直接表达**平移变换**——因为旋转和缩放都是线性变换（经过原点），而平移不是。为了用统一的矩阵形式表达所有变换，我们引入**齐次坐标** $(x, y, z, w)$：

- 当 $w = 1$ 时，表示空间中的一个点
- 当 $w = 0$ 时，表示一个方向（常用于光照计算中的光线方向）

#### 仿射变换的矩阵形式

```
[ x']   [ a  b  c  tx ] [ x ]
[ y'] = [ d  e  f  ty ] [ y ]
[ z']   [ g  h  i  tz ] [ z ]
[ 1 ]   [ 0  0  0  1  ] [ 1 ]
```

其中 $3 \times 3$ 左上部分控制**线性变换**（旋转+缩放），最后一列 $(t_x, t_y, t_z)$ 控制**平移**。

### 2. 基本变换矩阵

#### 2.1 缩放矩阵 (Scale)

沿坐标轴缩放：

```
[ sx  0  0  0 ]
[ 0  sy  0  0 ]   当 sx = sy = sz 时为均匀缩放
[ 0   0 sz  0 ]
[ 0   0  0  1 ]
```

```glsl
mat4 scaleMatrix(vec3 s) {
    return mat4(
        s.x, 0.0, 0.0, 0.0,
        0.0, s.y, 0.0, 0.0,
        0.0, 0.0, s.z, 0.0,
        0.0, 0.0, 0.0, 1.0
    );
}
```

#### 2.2 平移矩阵 (Translation)

```
[ 1   0  0  tx ]
[ 0   1  0  ty ]   平移是最简单的矩阵
[ 0   0  1  tz ]
[ 0   0  0  1  ]
```

```glsl
mat4 translationMatrix(vec3 t) {
    return mat4(
        1.0, 0.0, 0.0, t.x,
        0.0, 1.0, 0.0, t.y,
        0.0, 0.0, 1.0, t.z,
        0.0, 0.0, 0.0, 1.0
    );
}
```

#### 2.3 旋转矩阵 (Rotation)

绕 X 轴旋转（右手定则，正值为逆时针）：

```
[ 1    0       0    0 ]
[ 0   cosθ  -sinθ  0 ]
[ 0   sinθ   cosθ  0 ]
[ 0    0       0    1 ]
```

绕 Y 轴旋转：

```
[ cosθ   0   sinθ  0 ]
[ 0      1     0    0 ]
[ -sinθ  0   cosθ  0 ]
[ 0      0     0    1 ]
```

绕 Z 轴旋转：

```
[ cosθ  -sinθ  0  0 ]
[ sinθ   cosθ  0  0 ]
[ 0       0     1  0 ]
[ 0       0     0  1 ]
```

```glsl
mat4 rotationX(float angle) {
    float c = cos(angle), s = sin(angle);
    return mat4(
        1.0, 0.0, 0.0, 0.0,
        0.0, c,   -s,  0.0,
        0.0, s,    c,  0.0,
        0.0, 0.0, 0.0, 1.0
    );
}
```

### 3. 矩阵组合与变换顺序

#### 矩阵乘法顺序的重要性

**矩阵乘法不满足交换律**：

```glsl
// 绕原点旋转再平移 ≠ 平移再绕原点旋转
mat4 transform1 = translationMatrix(vec3(1,0,0)) * rotationZ(3.14159/4.0);
mat4 transform2 = rotationZ(3.14159/4.0) * translationMatrix(vec3(1,0,0));
```

#### 标准的 MVP 变换顺序

从模型到屏幕的完整变换链：

```
模型空间 → [Model Matrix] → 世界空间 → [View Matrix] → 观察空间 → [Projection Matrix] → 裁剪空间
```

```glsl
// 计算 MVP 矩阵
mat4 model = rotationY(u_time) * translationMatrix(vec3(0, 0, 0));
mat4 view = lookAt(cameraPos, cameraTarget, vec3(0, 1, 0));
mat4 projection = perspective(fov, aspect, near, far);
mat4 mvp = projection * view * model;
```

**注意**：矩阵乘法从右向左执行——先应用 model，再 view，最后 projection。

### 4. LookAt 矩阵

LookAt 矩阵将相机放置在特定位置，看向特定目标：

```glsl
mat4 lookAt(vec3 eye, vec3 target, vec3 up) {
    // 计算相机坐标系三个轴
    vec3 z = normalize(eye - target);           // 相机 Z 轴（看向 -Z）
    vec3 x = normalize(cross(up, z));           // 相机 X 轴
    vec3 y = cross(z, x);                      // 相机 Y 轴
    
    // 构建观察矩阵（注意转置因为我们用的是列主序）
    return mat4(
        vec4(x.x, y.x, z.x, 0),
        vec4(x.y, y.y, z.y, 0),
        vec4(x.z, y.z, z.z, 0),
        vec4(-dot(x, eye), -dot(y, eye), -dot(z, eye), 1)
    );
}
```

### 5. 投影矩阵

#### 5.1 正交投影 (Orthographic)

正交投影没有透视效果，物体大小不随距离变化：

```
left, right, bottom, top, near, far
```

```glsl
mat4 orthographic(float left, float right, float bottom, float top, float near, float far) {
    float rl = right - left;
    float tb = top - bottom;
    float fn = far - near;
    
    return mat4(
        2.0/rl, 0.0, 0.0, 0.0,
        0.0, 2.0/tb, 0.0, 0.0,
        0.0, 0.0, -2.0/fn, 0.0,
        -(right+left)/rl, -(top+bottom)/tb, -(far+near)/fn, 1.0
    );
}
```

#### 5.2 透视投影 (Perspective)

透视投影模拟人眼视觉效果，近大远小：

```glsl
mat4 perspective(float fov, float aspect, float near, float far) {
    float tanHalfFov = tan(fov * 0.5);
    float fn = far - near;
    
    return mat4(
        1.0 / (aspect * tanHalfFov), 0.0, 0.0, 0.0,
        0.0, 1.0 / tanHalfFov, 0.0, 0.0,
        0.0, 0.0, -(far+near)/fn, -1.0,
        0.0, 0.0, -(2.0*far*near)/fn, 0.0
    );
}
```

---

## 关键代码片段

### 四元数基础

四元数 $q = w + xi + yj + zk$ 用四个标量表示三维旋转：

```glsl
// 四元数构造
vec4 quaternion(vec3 axis, float angle) {
    float halfAngle = angle * 0.5;
    float s = sin(halfAngle);
    return vec4(axis * s, cos(halfAngle));
}

// 四元数乘法（组合旋转）
vec4 quaternionMultiply(vec4 a, vec4 b) {
    return vec4(
        a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz),
        a.w * b.w - dot(a.xyz, b.xyz)
    );
}

// 四元数转旋转矩阵
mat4 quaternionToMatrix(vec4 q) {
    vec4 n = normalize(q);
    float xx = n.x * n.x, yy = n.y * n.y, zz = n.z * n.z;
    float xy = n.x * n.y, xz = n.x * n.z, yz = n.y * n.z;
    float xw = n.x * n.w, yw = n.y * n.w, zw = n.z * n.w;
    
    return mat4(
        1.0 - 2.0*(yy + zz), 2.0*(xy - zw), 2.0*(xz + yw), 0.0,
        2.0*(xy + zw), 1.0 - 2.0*(xx + zz), 2.0*(yz - xw), 0.0,
        2.0*(xz - yw), 2.0*(yz + xw), 1.0 - 2.0*(xx + yy), 0.0,
        0.0, 0.0, 0.0, 1.0
    );
}
```

### 欧拉角与四元数转换

```glsl
// 欧拉角（Yaw-Pitch-Roll）转四元数
vec4 eulerToQuaternion(vec3 euler) {
    float cy = cos(euler.x * 0.5);  // Yaw
    float sy = sin(euler.x * 0.5);
    float cp = cos(euler.y * 0.5);  // Pitch
    float sp = sin(euler.y * 0.5);
    float cr = cos(euler.z * 0.5);  // Roll
    float sr = sin(euler.z * 0.5);
    
    return vec4(
        sr * cp * cy - cr * sp * sy,  // x
        cr * sp * cy + sr * cp * sy,  // y
        cr * cp * sy - sr * sp * cy,  // z
        cr * cp * cy + sr * sp * sy   // w
    );
}

// 四元数转欧拉角（存在万向锁问题）
vec3 quaternionToEuler(vec4 q) {
    float sinr_cosp = 2.0 * (q.w * q.x + q.y * q.z);
    float cosr_cosp = 1.0 - 2.0 * (q.x * q.x + q.y * q.y);
    float roll = atan(sinr_cosp, cosr_cosp);
    
    float sinp = 2.0 * (q.w * q.y - q.z * q.x);
    float pitch = asin(clamp(sinp, -1.0, 1.0));
    
    float siny_cosp = 2.0 * (q.w * q.z + q.x * q.y);
    float cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z);
    float yaw = atan(siny_cosp, cosy_cosp);
    
    return vec3(yaw, pitch, roll);
}
```

### 完整顶点着色器示例

```glsl
// 3D 场景顶点着色器
#version 300 es
precision highp float;

in vec3 a_position;     // 模型空间顶点
in vec3 a_normal;       // 模型空间法线
in vec2 a_uv;           // UV 坐标

uniform mat4 u_model;       // 模型矩阵
uniform mat4 u_view;        // 视图矩阵
uniform mat4 u_projection;  // 投影矩阵
uniform mat3 u_normalMatrix; // 法线矩阵（模型矩阵的逆转置）
uniform float u_time;

out vec3 v_normal;       // 传递到片元着色器的世界空间法线
out vec3 v_worldPos;     // 传递到片元着色器的世界空间位置
out vec2 v_uv;

void main() {
    // 计算世界空间位置
    vec4 worldPos = u_model * vec4(a_position, 1.0);
    v_worldPos = worldPos.xyz;
    
    // 变换法线到世界空间
    v_normal = normalize(u_normalMatrix * a_normal);
    
    // 传递 UV
    v_uv = a_uv;
    
    // MVP 变换到裁剪空间
    gl_Position = u_projection * u_view * worldPos;
}
```

---

## 性能优化要点

### 1. 减少矩阵乘法

```glsl
// 低效：每个顶点计算 MVP
gl_Position = u_projection * u_view * u_model * vec4(position, 1.0);

// 高效：CPU 预计算 MVP，GPU 只做一次乘法
gl_Position = u_mvp * vec4(position, 1.0);
```

### 2. 使用 `mat3` 处理法线变换

法线是方向向量，不应受平移影响：

```glsl
// 低效：使用完整的 4x4 矩阵
v_normal = normalize(mat3(u_model) * a_normal);

// 高效：直接使用 3x3 矩阵
v_normal = normalize(u_normalMatrix * a_normal);
```

### 3. 避免在着色器中计算逆矩阵

```glsl
// 着色器中计算逆矩阵极其昂贵
// 正确做法：CPU 计算好逆矩阵，通过 uniform 传入
uniform mat4 u_inverseModel;
```

### 4. 时间复杂度

| 操作 | 复杂度 |
|------|--------|
| 4x4 矩阵 × 4D 向量 | O(16) = O(1) |
| 4x4 矩阵 × 4x4 矩阵 | O(64) = O(1) |
| 逆矩阵计算 | O(n³)，GPU 上极慢 |

---

## 常见坑与调试方法

### 坑 1：行主序 vs 列主序混淆

**问题**：变换结果完全错误

**原因**：不同数学约定和 API 使用不同主序

**解决**：GLSL 使用**列主序**，矩阵乘法 `mat * vec` 等同于数学上的 `vec^T * mat^T`

```glsl
// 列主序存储
mat4 m = mat4(
    1.0, 0.0, 0.0, 0.0,  // 列 0
    0.0, 1.0, 0.0, 0.0,  // 列 1
    0.0, 0.0, 1.0, 0.0,  // 列 2
    1.0, 2.0, 3.0, 1.0   // 列 3（平移分量）
);
```

### 坑 2：四元数万向锁（Gimbal Lock）

**问题**：在特定角度旋转丢失一个自由度

**原因**：欧拉角在 Pitch = ±90° 时 Yaw 和 Roll 描述的是同一旋转

**解决**：使用四元数存储和插值旋转

### 坑 3：法线变换使用模型矩阵而非逆转置

**问题**：非均匀缩放时法线方向错误

**原因**：缩放会导致法线不再垂直于表面

**解决**：
```glsl
// 正确的法线矩阵
mat3 normalMatrix = transpose(inverse(mat3(model)));
```

### 坑 4：透视除法遗漏

**问题**：3D 物体看起来没有透视效果

**原因**：忘记在顶点着色器后做透视除法（`gl_Position.xyz /= gl_Position.w`）

**解决**：GPU 自动处理，但要注意 NDC 坐标范围

---

## 与相近技术的对比

| 技术 | 表示方式 | 优点 | 缺点 | 适用场景 |
|------|---------|------|------|---------|
| **矩阵** | 4×4 齐次矩阵 | 统一、可组合、可逆 | 16 个参数、需正交化 | 所有变换 |
| **欧拉角** | 3 个角度 | 直观、易理解 | 万向锁、插值不平滑 | 简单旋转 |
| **四元数** | 4 元数 | 无万向锁、插值平滑、可快速运算 | 不直观 | 角色动画、相机 |
| **轴角** | 轴+角 | 最直观 | 组合运算复杂 | 旋转表示 |

**对比结论**：生产环境常用**矩阵**存储变换、**四元数**存储旋转（骨骼动画）、**欧拉角**用于用户输入。

---

## 实战案例：3D 轨道相机系统

### 需求

实现一个轨道相机，支持：
- 鼠标拖拽旋转
- 滚轮缩放距离
- 自动阻尼平滑

### 实现

```glsl
// ============ 顶点着色器 ============
#version 300 es
precision highp float;

in vec3 a_position;
uniform mat4 u_mvp;

void main() {
    gl_Position = u_mvp * vec4(a_position, 1.0);
}

// ============ 相机系统（CPU 端伪代码）============

class OrbitalCamera {
    float distance;      // 相机距离目标距离
    float azimuth;       // 水平角度（弧度）
    float elevation;     // 垂直角度（弧度）
    vec3 target;         // 观察目标点
    
    // 平滑参数
    float smoothAzimuth, smoothElevation, smoothDistance;
    
    // 从球坐标计算相机位置
    vec3 getPosition() {
        return target + vec3(
            distance * cos(elevation) * sin(azimuth),
            distance * sin(elevation),
            distance * cos(elevation) * cos(azimuth)
        );
    }
    
    // 构建观察矩阵
    mat4 getViewMatrix() {
        vec3 eye = getPosition();
        return lookAt(eye, target, vec3(0, 1, 0));
    }
    
    // 每帧更新（带阻尼）
    void update(float dt) {
        // 阻尼系数（越大越"重"）
        const float damping = 5.0;
        
        smoothAzimuth += (azimuth - smoothAzimuth) * damping * dt;
        smoothElevation += (elevation - smoothElevation) * damping * dt;
        smoothDistance += (distance - smoothDistance) * damping * dt;
    }
    
    // 处理鼠标输入
    void onMouseDrag(float dx, float dy) {
        azimuth -= dx * 0.01;
        elevation = clamp(elevation - dy * 0.01, -1.5, 1.5);
    }
    
    void onMouseWheel(float delta) {
        distance = clamp(distance + delta * 0.1, 2.0, 100.0);
    }
};
```

---

## 小结

本篇介绍了矩阵变换的核心概念：

1. **齐次坐标** - 用 4D 向量统一表达所有仿射变换
2. **基本变换矩阵** - 平移、旋转、缩放
3. **MVP 变换链** - 模型→世界→观察→裁剪空间
4. **LookAt 矩阵** - 构建相机的数学方法
5. **投影矩阵** - 正交与透视投影
6. **四元数** - 解决万向锁问题的旋转表示

矩阵变换是图形学的基础设施，后续所有 3D 渲染都建立在这个数学框架之上。

---

## 延伸阅读与下一篇衔接

**延伸阅读**：
- Eric Lengyel - ["Mathematics for 3D Game Programming"](https://www.amazon.com/Mathematics-Programming-Computer-Graphics-Third/dp/1435458869)：矩阵数学的权威参考
- Song Ho Ahn - ["OpenGL Transformation"](http://www.songho.ca/opengl/gl_matrix.html)：变换的直观图解

**前置知识**：
- 向量运算（点积、叉积）
- 基本三角函数

**下一篇衔接**：
第 4 篇「纹理采样：从像素到连续空间」将介绍 GPU 纹理系统的工作原理——从纹理坐标到采样过滤，从 Mipmap 到各向异性采样。纹理采样是连接"数学定义的形状"和"视觉丰富度"的桥梁。

---

## 知识点清单（Checklist）

- [ ] 理解齐次坐标 $(x, y, z, w)$ 中 $w=1$ 表示点、$w=0$ 表示方向的意义
- [ ] 能够写出平移、旋转（X/Y/Z轴）、缩放的 4×4 矩阵
- [ ] 理解矩阵乘法不满足交换律，并能解释 `A*B` 与 `B*A` 的区别
- [ ] 掌握 MVP 变换链及乘法从右到左的执行顺序
- [ ] 能够推导 LookAt 矩阵的三个基向量计算
- [ ] 理解正交投影和透视投影的区别及各自适用场景
- [ ] 掌握四元数与旋转矩阵/欧拉角的转换方法
- [ ] 理解万向锁问题及四元数如何避免它
- [ ] 知道法线矩阵需要使用逆转置（transpose(inverse(mat3(model))））
- [ ] 能够实现一个完整的轨道相机系统
