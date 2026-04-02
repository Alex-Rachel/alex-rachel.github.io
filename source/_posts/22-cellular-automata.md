# 第22篇｜细胞自动机：生命游戏与反应扩散

## 摘要

**细胞自动机（Cellular Automata）**通过简单规则的迭代产生复杂图案。本篇讲解 **Game of Life** 和 **反应-扩散系统（Turing Patterns）**。

---

## 核心原理

### Game of Life 规则

1. 活细胞周围有 2-3 个活邻居 → 继续存活
2. 死细胞周围有正好 3 个活邻居 → 复活
3. 其他情况 → 死亡或保持死亡

```glsl
// Buffer A: Game of Life
void main() {
    vec2 uv = fragCoord / iResolution.xy;
    int alive = 0;
    
    // 计算邻居
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            vec2 neighborUV = uv + vec2(dx, dy) / iResolution.xy;
            alive += texture(iChannel0, neighborUV).r > 0.5 ? 1 : 0;
        }
    }
    
    // 应用规则
    float current = texture(iChannel0, uv).r;
    float next = current;
    
    if (current > 0.5) {
        // 活细胞
        next = (alive == 2 || alive == 3) ? 1.0 : 0.0;
    } else {
        // 死细胞
        next = (alive == 3) ? 1.0 : 0.0;
    }
    
    fragColor = vec4(next, 0, 0, 1);
}
```

### 反应-扩散（Turing Patterns）

$$\frac{\partial A}{\partial t} = D_A \nabla^2 A - AB^2 + f(1-A)$$
$$\frac{\partial B}{\partial t} = D_B \nabla^2 B + AB^2 - (k+f)B$$

```glsl
// Gray-Scott 反应扩散简化版
vec4 reactionDiffusion(vec2 uv, vec2 texel) {
    vec4 state = texture(iChannel0, uv);
    float a = state.r;
    float b = state.g;
    
    // 扩散
    float laplacianA = (
        texture(iChannel0, uv + vec2(-1,0)*texel).r +
        texture(iChannel0, uv + vec2(1,0)*texel).r +
        texture(iChannel0, uv + vec2(0,-1)*texel).r +
        texture(iChannel0, uv + vec2(0,1)*texel).r - 4.0*a
    ) * 0.2;
    
    // 反应
    float abb = a * b * b;
    float da = laplacianA - abb + (1.0 - a) * 0.1;
    float db = laplacianA * 0.5 + abb - (0.05 + b) * 0.1;
    
    return vec4(clamp(a + da, 0.0, 1.0), clamp(b + db, 0.0, 1.0), 0, 1);
}
```

---

## 小结

细胞自动机通过简单规则的迭代产生复杂图案，Game of Life 和反应扩散是两种经典形式。

---

## 延伸阅读

**前置知识**：多 Pass 缓冲

**下一篇**：第 23 篇「海洋与水体」

---

## 知识点清单（Checklist）

- [ ] 掌握 Game of Life 的三条规则
- [ ] 理解反应-扩散的数学方程
- [ ] 掌握 ping-pong buffer 的使用
