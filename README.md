# Alex's Blog 操作指南 🐶

## 博客地址
- **线上地址**: https://alex-rachel.github.io
- **GitHub 仓库**: https://github.com/Alex-Rachel/alex-rachel.github.io

## 本地开发

### 1. 启动本地预览
```bash
cd ~/.openclaw/workspace/blog
npx hexo server
```
访问 http://localhost:4000 查看效果

### 2. 停止服务
在终端按 `Ctrl + C`

---

## 写博客

### 方法一：新建博客文章
```bash
cd ~/.openclaw/workspace/blog
npx hexo new "文章标题"
```
文章会创建在 `source/_posts/` 目录

### 方法二：直接编辑
在 `source/_posts/` 目录下新建 `.md` 文件，格式：
```markdown
---
title: 文章标题
date: 2026-04-02 12:00:00
tags: [标签1, 标签2]
---

正文内容...
```

---

## 发布到 GitHub

```bash
cd ~/.openclaw/workspace/blog
git add .
git commit -m "更新博客"
git push origin main
```

推送后等待约 1-2 分钟，GitHub Actions 自动构建部署。

---

## GitHub Actions 状态查看
1. 打开 https://github.com/Alex-Rachel/alex-rachel.github.io
2. 点击 Actions 标签
3. 查看最新部署状态

---

## 目录结构
```
blog/
├── source/_posts/     # 博客文章 (.md 文件)
├── themes/fluid/      # 主题文件
├── _config.yml        # Hexo 配置
├── package.json       # 依赖
└── .github/workflows/ # 自动部署配置
```

---

## 常用命令
| 命令 | 说明 |
|------|------|
| `npx hexo server` | 本地预览 |
| `npx hexo clean` | 清除缓存 |
| `npx hexo new "标题"` | 新建文章 |
| `npx hexo g` | 生成静态文件 |

---

## 注意事项
- node_modules 不需要提交（已在 .gitignore）
- 每次推送后等待 GitHub Actions 自动部署
- 如需修改主题配置，编辑 `themes/fluid/_config.yml` 或创建 `_config.fluid.yml` 覆盖