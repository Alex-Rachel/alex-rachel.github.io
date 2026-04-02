# 第31篇｜多 Pass 缓冲：状态的艺术

## 摘要

**多 Pass 缓冲（Multi-pass Buffer）**通过在帧缓冲区存储中间计算结果，实现状态持久化和复杂模拟。本篇讲解 **Ping-Pong FBO** 和 **Buffer A/B/C** 的使用。

---

## 核心原理

### Ping-Pong FBO

```glsl
// 两帧交替读写
int current = frame % 2;
int previous = 1 - current;

void main() {
    // 读取上一帧数据
    vec4 prevState = texture(iChannel0, uv);
    
    // 计算新状态
    vec4 newState = update(prevState, iTime);
    
    // 输出到当前 buffer
    fragColor = newState;
}

// 使用：
// iChannel0 = Buffer A[current]
```

### Buffer A: 物理状态

```glsl
void main() {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 posVel = texture(iChannel0, uv);
    
    // 应用物理
    posVel.zw += gravity * 0.01;
    posVel.xy += posVel.zw;
    
    fragColor = posVel;
}
```

---

## 小结

Ping-Pong FBO 是实现粒子系统、流体模拟等有状态效果的基础。

---

## 延伸阅读

**前置知识**：渲染基础

**下一篇**：第 32 篇「高级纹理映射」

---

## 知识点清单

- [ ] 理解 Ping-Pong 的读写交替机制
- [ ] 掌握 Buffer 作为状态存储的使用
