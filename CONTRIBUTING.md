# Contributing

感谢想为 dsh-lan-memory 做贡献！

## 开发

`ash
# 安装依赖
pnpm install
# 语法检查
node --check src/index.js
node --check src/client.js
`

## 结构

- src/index.js — 宿主插件：存储层 / 工具 / 人格注入 / mood 捕获 / 一键整理 / REST API
- src/client.js — 浏览器半区：设置页多标签 UI + mood 卡片
- docs/ — 设计规格

## 约定

- 工具统一 lan_ 前缀
- 写入同步落盘（先 tmp 再 rename），保持原子性
- 新功能需带备份/回滚路径
