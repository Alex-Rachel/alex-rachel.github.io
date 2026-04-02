# 第30篇｜相机特效：景深与运动模糊

## 摘要

**相机特效（Camera Effects）**模拟真实相机的光学特性。本篇讲解 **景深（DOF）**、**运动模糊**、**镜头畸变**。

---

## 核心原理

### 景深 (Depth of Field)

```glsl
vec3 depthOfField(vec2 uv, float focusDist) {
    vec3 col = vec3(0.0);
    float totalWeight = 0.0;
    
    for (int i = 0; i < 16; i++) {
        vec2 offset = sampleCircle(i, 16) * 0.02;
        vec2 sampleUV = uv + offset;
        
        // 根据焦距计算模糊
        float depth = getDepth(sampleUV);
        float coc = abs(depth - focusDist) * 10.0;
        float weight = 1.0 / (1.0 + coc);
        
        col += render(sampleUV) * weight;
        totalWeight += weight;
    }
    
    return col / totalWeight;
}
```

### 运动模糊

```glsl
vec3 motionBlur(vec2 uv, float shutterAngle) {
    vec3 col = vec3(0.0);
    
    for (int i = 0; i < 8; i++) {
        float time = iTime + float(i) * shutterAngle / 8.0;
        col += renderAtTime(uv, time);
    }
    
    return col / 8.0;
}
```

---

## 小结

相机特效通过模拟真实光学系统的物理特性增强画面真实感。

---

## 延伸阅读

**前置知识**：多 Pass 缓冲（第 35 篇）

**下一篇**：第 31 篇「多 Pass 缓冲」

---

## 知识点清单

- [ ] 理解 Circle of Confusion 的概念
- [ ] 理解运动模糊的时间采样
