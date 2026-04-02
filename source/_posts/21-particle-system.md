# 第21篇｜粒子系统：火、雨与星辰

## 摘要

**粒子系统（Particle Systems）**是渲染火焰、爆炸、雨雪等自然现象的核心技术。本篇讲解**无状态**和**有状态**粒子系统的实现，以及噪声驱动的粒子行为。

---

## 核心原理

### 无状态粒子 (Stateless)

每个粒子独立计算，不依赖历史帧：

```glsl
vec3 statelessParticle(vec2 uv, float time) {
    float particles = 0.0;
    
    for (int i = 0; i < 50; i++) {
        float seed = float(i) * 123.456;
        vec2 pos = hash2(vec2(seed)) - 0.5;
        float phase = hash(vec2(seed)) * 6.28;
        
        // 向上漂浮
        pos.y += sin(time * 2.0 + phase) * 0.1;
        
        float d = length(uv - pos);
        particles += smoothstep(0.02, 0.01, d);
    }
    
    return vec3(particles);
}
```

### 有状态粒子 (Stateful)

需要 buffer 存储每帧状态，需要多 pass：

```glsl
// Buffer A: 存储粒子位置和速度
vec4 updateParticle(vec2 uv, float time) {
    vec4 state = texture(iChannel0, uv);  // xy=pos, zw=vel
    
    // 应用重力
    state.w -= 0.001;
    
    // 更新位置
    state.xy += state.zw * 0.01;
    
    // 如果超出屏幕，重置
    if (any(greaterThan(abs(state.xy), vec2(1.0)))) {
        state = vec4(0.0);
    }
    
    return state;
}
```

---

## 小结

粒子系统通过大量小元素的聚合行为产生宏观效果，无状态适合简单效果，有状态需要多 pass。

---

## 延伸阅读

**前置知识**：程序化噪声（第 2 篇）

**下一篇**：第 22 篇「细胞自动机」

---

## 知识点清单（Checklist）

- [ ] 理解无状态和有状态粒子的区别
- [ ] 掌握噪声驱动粒子行为的方法
- [ ] 理解粒子 Billboard 渲染技术
