# 第29篇｜抗锯齿：从 SSAA 到 TAA

## 摘要

**抗锯齿（Anti-Aliasing）**消除画面边缘的锯齿和闪烁。本篇讲解 **SSAA**、**FXAA**、**TAA** 的原理与实现。

---

## 核心原理

### SSAA (Super Sample AA)

```glsl
// 4x SSAA - 每像素采样4次
vec3 superSampleAA(vec2 fragCoord) {
    vec3 col = vec3(0.0);
    vec2 offsets[4] = vec2[](
        vec2(-0.25, -0.25), vec2(0.25, -0.25),
        vec2(-0.25, 0.25), vec2(0.25, 0.25)
    );
    
    for (int i = 0; i < 4; i++) {
        vec2 sampleCoord = fragCoord + offsets[i];
        col += render(sampleCoord);
    }
    
    return col / 4.0;
}
```

### FXAA (Fast Approximate AA)

```glsl
vec3 fxaa(vec2 uv) {
    vec3 col = texture(tex, uv).rgb;
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    
    // 检测边缘
    float lumaL = dot(texture(tex, uv - vec2(1,0)/res).rgb, vec3(0.299, 0.587, 0.114));
    float lumaR = dot(texture(tex, uv + vec2(1,0)/res).rgb, vec3(0.299, 0.587, 0.114));
    
    if (abs(lumaL - lumaR) > 0.1) {
        // 应用模糊
        col = gaussianBlur(tex, uv);
    }
    
    return col;
}
```

---

## 小结

SSAA 质量最高但性能最差，FXAA 性能最好但质量一般，TAA 是现代游戏的折中选择。

---

## 延伸阅读

**前置知识**：渲染基础

**下一篇**：第 30 篇「相机特效」

---

## 知识点清单

- [ ] 理解 SSAA 的多重采样原理
- [ ] 理解 TAA 的时间积累概念
