# 第35篇｜WebGL 避坑指南：常见错误汇总

## 摘要

本篇总结 **WebGL/GLSL** 开发中的常见错误和调试方法，帮助快速定位和解决问题。

---

## 常见坑

### 1. 变量声明顺序 (TDZ)

```glsl
// 错误 - TDZ 导致白屏
void main() {
    gl_FragColor = vec4(color);  // color 还未声明！
    vec3 color = vec3(1.0);
}

// 正确 - 先声明后使用
void main() {
    vec3 color = vec3(1.0);
    gl_FragColor = vec4(color);
}
```

### 2. 函数声明顺序

```glsl
// 错误 - 使用前未声明
void main() {
    vec3 n = getNormal();  // Error!
}
vec3 getNormal() { return vec3(0,1,0); }

// 正确 - 声明或定义在前
vec3 getNormal();
void main() {
    vec3 n = getNormal();
}
vec3 getNormal() { return vec3(0,1,0); }
```

### 3. 宏定义限制

```glsl
// 错误 - 宏不能使用函数调用
#define LIGHT_DIR normalize(vec3(1,1,1))

// 正确 - 使用 const
const vec3 LIGHT_DIR = normalize(vec3(1,1,1));
```

### 4. Uniform 被优化

```glsl
// 如果 uniform 未使用，编译器可能优化掉
// 使用 uniform 确保不被优化
float unused = u_myUniform;  // 引用它！
```

---

## 调试方法

### 检查 GLSL 编译错误

```javascript
gl.compileShader(fs);
if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(fs));
}
```

---

## 小结

WebGL 开发中变量声明顺序、函数声明、宏限制是需要特别注意的坑。

---

## 延伸阅读

**前置知识**：任意 Shader 经验

**下一篇**：第 36 篇「实战：完整渲染管线」

---

## 知识点清单

- [ ] 理解 TDZ（暂时性死区）的含义
- [ ] 掌握 GLSL 的函数声明顺序要求
- [ ] 知道宏定义的限制
