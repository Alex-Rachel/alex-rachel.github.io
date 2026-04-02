# 第34篇｜物理模拟：GPU 并行计算

## 摘要

**GPU 物理模拟**利用大规模并行计算实现弹簧、 cloth、N-body 引力等效果。本篇讲解 GPU 上的物理计算模式。

---

## 核心原理

### 弹簧系统

```glsl
// N 个粒子，每个与其他粒子计算弹簧力
vec3 springForce(vec3 p1, vec3 p2, float restLength, float k) {
    vec3 delta = p2 - p1;
    float dist = length(delta);
    return k * (dist - restLength) * normalize(delta);
}

void main() {
    vec3 force = vec3(0.0);
    
    // 所有其他粒子
    for (int i = 0; i < numParticles; i++) {
        if (i == currentParticle) continue;
        force += springForce(pos[currentParticle], pos[i], restLength, stiffness);
    }
    
    vec3 acc = force / mass;
    velocity += acc * dt;
    position += velocity * dt;
}
```

### N-Body 引力

```glsl
vec3 gravityForce(vec3 p1, vec3 p2, float m1, float m2) {
    vec3 dir = p2 - p1;
    float distSq = dot(dir, dir) + epsilon;
    float force = G * m1 * m2 / distSq;
    return force * normalize(dir);
}
```

---

## 小结

GPU 适合大量独立计算并行执行，物理模拟是典型应用场景。

---

## 延伸阅读

**前置知识**：多 Pass 缓冲（第 31 篇）

**下一篇**：第 35 篇「WebGL 避坑指南」

---

## 知识点清单

- [ ] 理解 GPU 并行计算模式
- [ ] 掌握弹簧力的向量计算
