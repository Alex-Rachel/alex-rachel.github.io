# 第36篇｜实战：完整渲染管线

## 摘要

本篇综合运用前 35 篇的知识，构建一个完整的 **SDF 3D 渲染管线**，包含几何建模、光照、阴影、环境光遮蔽、后处理。

---

## 完整渲染器实现

```glsl
#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;

// ============= SDF 场景 =============
vec2 map(vec3 p) {
    // 地面
    float ground = p.y + 1.0;
    
    // 球体
    vec3 spherePos = p - vec3(0.0, 0.5, 0.0);
    float sphere = sdSphere(spherePos, 0.5);
    
    // 立方体
    vec3 boxPos = p - vec3(1.2, 0.0, 0.0);
    float box = sdBox(boxPos, vec3(0.4));
    
    // 平滑并集
    float scene = opSmoothUnion(sphere, box, 0.2);
    
    return vec2(min(ground, scene), 1.0);
}

// ============= Ray Marching =============
vec2 rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        vec3 p = ro + rd * t;
        vec2 res = map(p);
        if (res.x < 0.001) return vec2(t, res.y);
        t += res.x;
        if (t > 100.0) break;
    }
    return vec2(-1.0, 0.0);
}

// ============= 法线 =============
vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(
        map(p + e.xyy).x - map(p - e.xyy).x,
        map(p + e.yxy).x - map(p - e.yxy).x,
        map(p + e.yyx).x - map(p - e.yyx).x
    ));
}

// ============= 光照 =============
float calcAO(vec3 p, vec3 n) {
    float occ = 0.0;
    float scale = 1.0;
    for (int i = 0; i < 5; i++) {
        float h = 0.01 + 0.12 * float(i);
        float d = map(p + h * n).x;
        occ += (h - d) * scale;
        scale *= 0.95;
    }
    return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
}

float softShadow(vec3 ro, vec3 rd) {
    float res = 1.0;
    float t = 0.02;
    for (int i = 0; i < 64; i++) {
        float h = map(ro + rd * t).x;
        res = min(res, 10.0 * h / t);
        t += clamp(h, 0.01, 0.2);
        if (res < 0.001 || t > 20.0) break;
    }
    return clamp(res, 0.0, 1.0);
}

vec3 render(vec3 ro, vec3 rd) {
    vec2 hit = rayMarch(ro, rd);
    
    if (hit.x < 0.0) return vec3(0.1, 0.15, 0.2);  // 天空
    
    vec3 p = ro + rd * hit.x;
    vec3 n = calcNormal(p);
    vec3 lightPos = vec3(5.0, 8.0, 3.0);
    vec3 lightDir = normalize(lightPos - p);
    
    // 阴影
    float shadow = softShadow(p + n * 0.01, lightDir);
    
    // AO
    float ao = calcAO(p, n);
    
    // 基础光照
    float diff = max(dot(n, lightDir), 0.0);
    vec3 col = vec3(0.1) * ao;
    col += diff * shadow * ao;
    
    return col;
}

void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - u_resolution) / u_resolution.y;
    
    // 相机
    vec3 ro = vec3(2.0, 2.0, 4.0);
    vec3 ta = vec3(0.0, 0.5, 0.0);
    vec3 ww = normalize(ta - ro);
    vec3 uu = normalize(cross(ww, vec3(0,1,0)));
    vec3 vv = cross(uu, ww);
    vec3 rd = normalize(uv.x*uu + uv.y*vv + 2.0*ww);
    
    vec3 col = render(ro, rd);
    col = pow(col, vec3(1.0/2.2));  // Gamma
    
    fragColor = vec4(col, 1.0);
}
```

---

## 总结

本系列博客涵盖了 Shader 开发的 36 个核心技术：

| 阶段 | 主题 |
|------|------|
| 基础 | SDF 2D、噪声、矩阵、纹理、调色 |
| 3D 几何 | SDF 3D、法线、光照、阴影、AO |
| 高级渲染 | Ray Marching、路径追踪、体积渲染、大气 |
| 模拟 | 流体、粒子、细胞自动机 |
| 程序化 | 地形、海洋、分形、图案 |
| 后处理 | Bloom、AA、相机特效 |
| 基础设施 | 多 Pass、WebGL 技巧 |

**持续学习建议**：
1. 在 ShaderToy 上实践每个技术
2. 阅读 IQ、Sebastian Lague 等作者的实现
3. 尝试组合多种技术创造独特效果

---

*本系列博客由 Alex 撰写，GitHub: https://github.com/Alex-Rachel/skills*
