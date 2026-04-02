# 第25篇｜分形渲染：从 Mandelbrot 到 Mandelbulb

## 摘要

**分形（Fractals）**通过迭代函数产生无限细节的自相似结构。本篇讲解 **Mandelbrot**、**Julia Sets** 和 **3D 分形（Mandelbulb）**。

---

## 核心原理

### Mandelbrot 集合

$$z_{n+1} = z_n^2 + c$$

```glsl
float mandelbrot(vec2 c) {
    vec2 z = vec2(0.0);
    int maxIter = 100;
    int iter;
    
    for (iter = 0; iter < maxIter; iter++) {
        z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
        if (dot(z, z) > 4.0) break;
    }
    
    return float(iter) / float(maxIter);
}
```

### Mandelbulb 3D

$$z_{n+1} = z_n^p + c, \quad p = 8$$

```glsl
float mandelbulb(vec3 pos, int iterations) {
    vec3 z = pos;
    float dr = 1.0;
    float r = 0.0;
    float power = 8.0;
    
    for (int i = 0; i < iterations; i++) {
        r = length(z);
        if (r > 2.0) break;
        
        float theta = acos(z.z / r);
        float phi = atan(z.y, z.x);
        dr = pow(r, power - 1.0) * power * dr + 1.0;
        
        float zr = pow(r, power);
        theta *= power;
        phi *= power;
        
        z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)) + pos;
    }
    
    return 0.5 * log(r) * r / dr;
}
```

---

## 小结

分形通过迭代函数产生无限自相似结构，是程序化生成最复杂形状的技术。

---

## 延伸阅读

**前置知识**：复数数学基础

**下一篇**：第 26 篇「2D 程序化图案」

---

## 知识点清单（Checklist）

- [ ] 理解 Mandelbrot 集合的迭代公式
- [ ] 掌握 Mandelbulb 的球坐标迭代
- [ ] 理解逃逸时间算法的意义
