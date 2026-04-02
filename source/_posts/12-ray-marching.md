# 第12篇｜球追踪：Ray Marching 入门

## 摘要

**Ray Marching**（又称 Sphere Tracing）是利用 SDF 逐步推进来渲染 3D 场景的核心算法。本篇讲解其数学原理、步进策略、收敛条件，并给出完整实现。

---

## 核心原理

### 算法流程

```
1. 从相机位置发射射线
2. 沿射线方向前进：t = t + SDF(p)
3. 当 SDF(p) < ε 或 t > maxDist 时停止
4. 如果 SDF < ε：该点在表面上，计算光照
```

### 数学公式

$$t_{n+1} = t_n + f(\vec{O} + t_n\vec{D})$$

其中 $f$ 是 SDF 函数。

```glsl
vec2 rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    int materialID = 0;
    
    for (int i = 0; i < MAX_STEPS; i++) {
        vec3 p = ro + rd * t;
        vec2 res = map(p);  // res.x = 距离, res.y = 材质ID
        
        if (res.x < EPSILON) {
            return vec2(t, res.y);
        }
        
        t += res.x;
        
        if (t > MAX_DIST) break;
    }
    
    return vec2(-1.0, 0.0);
}
```

### 收敛条件

SDF 必须满足 **Lipschitz 条件**：$|\nabla f| \leq 1$，保证 $|f(P) - f(Q)| \leq |P - Q|$。

---

## 实战案例

```glsl
void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(fragCoord - center);
    
    vec2 hit = rayMarch(ro, rd);
    
    if (hit.x > 0.0) {
        vec3 p = ro + rd * hit.x;
        vec3 n = calcNormal(p);
        vec3 col = pbrLighting(p, n, albedo, roughness);
    } else {
        col = skyColor;
    }
    
    fragColor = vec4(col, 1.0);
}
```

---

## 小结

Ray Marching 是 SDF 3D 渲染的核心算法，利用 SDF 的 Lipschitz 性质保证收敛。

---

## 延伸阅读

- Inigo Quilez - ["Sphere Tracing"](https://iquilezles.org/articles/spherefunctions/)

**前置知识**：SDF 3D（第 6 篇）、法线估算（第 7 篇）

**下一篇**：第 13 篇「CSG 布尔运算」

---

## 知识点清单（Checklist）

- [ ] 理解 Ray Marching 的迭代原理
- [ ] 掌握 SDF 的 Lipschitz 性质
- [ ] 理解 EPSILON 和 MAX_DIST 的作用
- [ ] 能实现基本的 Ray Marching 循环
