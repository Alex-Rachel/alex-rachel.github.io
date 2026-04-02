# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是 Alex 的个人技术博客，基于 **Hexo 7.x** 框架 + **Fluid 主题**，托管在 GitHub Pages（https://alex-rachel.github.io）。博客内容以 GLSL Shader 开发系列文章为主。

## 常用命令

```bash
# 本地预览（访问 http://localhost:4000）
npx hexo server

# 清除缓存（构建异常时先执行）
npx hexo clean

# 生成静态文件
npx hexo generate   # 或 npm run build

# 新建文章（自动创建到 source/_posts/）
npx hexo new "文章标题"
```

## 博客文章生成流程

### 文章存放位置
所有文章在 `source/_posts/` 目录，使用 Markdown 格式。

### Front Matter 格式（必填字段）
```markdown
---
title: 文章标题
date: 2026-04-02 12:00:00
tags: [标签1, 标签2]
---
```
scaffold 模板在 `scaffolds/post.md`，目前只有 title/date/tags 三个字段。

### 命名规范（参考现有文章）
数字前缀 + 语义名称：`01-sdf-2d-basics.md`、`02-procedural-noise.md`，以此类推。

### 发布流程
1. 在 `source/_posts/` 创建或编辑 `.md` 文件
2. `git add . && git commit -m "描述" && git push origin main`
3. GitHub Actions（`.github/workflows/pages.yml`）自动触发，约 1-2 分钟完成部署

### GitHub Actions 构建步骤
- Node.js 20 + npm install（含 `themes/fluid` 单独安装依赖）
- `npm run build`（即 `hexo generate`）
- 产物 `./public` 上传并部署到 GitHub Pages

## 配置文件层次

| 文件 | 用途 |
|------|------|
| `_config.yml` | Hexo 全局配置（URL、主题、permalink、高亮等） |
| `themes/fluid/_config.yml` | Fluid 主题详细配置 |
| `_config.landscape.yml` | landscape 主题配置（备用，未激活） |

当前激活主题：`theme: fluid`（在 `_config.yml` 第 19 行）。

若需覆盖主题配置而不修改 `themes/fluid/` 内的文件，可在根目录创建 `_config.fluid.yml`。

## 现有内容结构

- `source/_posts/` 包含 36 篇 GLSL Shader 系列文章（01-36）+ 入门导读
- `source/about/index.md` — About 页面
- Permalink 格式：`:year/:month/:day/:title/`
