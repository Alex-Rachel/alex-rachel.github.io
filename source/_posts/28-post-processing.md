# 第28篇｜后处理特效：Bloom 与色调映射

## 摘要

**后处理（Post-Processing）**在渲染管线末端增强画面效果。本篇讲解 **Bloom**、**色调映射（ACES/Reinhard）**、**暗角** 等常用特效。

---

## 核心原理

### Bloom

```glsl
// 高斯模糊提取亮部
vec3 extractBright(vec3 color, float threshold) {
    float brightness = dot(color, vec3(0.299, 0.587, 0.114));
    return brightness > threshold ? color : vec3(0.0);
}

vec3 gaussianBlur(sampler2D tex, vec2 uv) {
    vec2 texel = 1.0 / vec2(textureSize(tex, 0));
    
    vec3 result = vec3(0.0);
    for (int x = -4; x <= 4; x++) {
        for (int y = -4; y <= 4; y++) {
            vec2 offset = vec2(x, y) * texel * 2.0;
            result += texture(tex, uv + offset).rgb;
        }
    }
    return result / 81.0;
}
```

### ACES 色调映射

```glsl
vec3 acesTonemap(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
```

---

## 小结

后处理是渲染管线的最后一步，Bloom 和色调映射是提升画面品质的关键技术。

---

## 延伸阅读

**前置知识**：光照模型（第 8 篇）

**下一篇**：第 29 篇「抗锯齿」

---

## 知识点清单

- [ ] 理解 Bloom 的两步法（提取+模糊）
- [ ] 掌握 ACES 色调映射公式
