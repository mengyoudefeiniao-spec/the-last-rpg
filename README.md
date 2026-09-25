# The Last RPG

> 一句话简介：待补。

## 当前状态

立项阶段：目录骨架已就位，尚未写代码与正文内容。

## 技术栈

- 语言：TypeScript
- 运行环境：浏览器（无后端；存档先用 `localStorage`，需要大量数据时换 `IndexedDB`）
- 构建工具：待定（推荐 Vite），入口为根目录 `index.html` + `src/main.ts`

## 四条轨道

| 轨道 | 目录 | 读者 | 内容 |
| --- | --- | --- | --- |
| 创作 | `docs/` | 人 | 世界背景、人物设定、剧情、玩法设计 |
| 数据 | `data/` | 程序 | 游戏运行时读取的 JSON |
| 实现 | `src/` | 程序 | TypeScript 源码 |
| 素材 | `public/` | 程序 | 图片、音频、字体等静态资源 |

`docs/` 是**唯一真相源**（设定以文档为准），`data/` 是它的**可执行投影**。
两者的一致性靠 `data/schema/` 的约束 + `tools/` 下的校验脚本保证，不靠人眼对齐。

## 目录导航

```
docs/     剧本与设计文档（世界/人物/剧情/玩法）
data/     游戏运行数据（JSON，按实体一分一档）
src/      源码（core → systems → ui/render 单向依赖）
public/   静态资源（构建时原样拷贝）
tests/    单元测试、集成测试、测试数据
tools/    开发脚本：剧本→数据导出、schema 校验、交叉引用检查
```

详见 `docs/README.md`、`data/README.md`、`src/README.md`。

## 命名约定

- **目录名**：一律英文、小写、短横线（`kebab-case`），不含空格。
- **代码文件**：`kebab-case.ts`；类型/类名 `PascalCase`。
- **文档文件**：允许中文命名，方便阅读。
- **数据文件**：文件名即 ID，如 `char.hero.json`、`quest.escape-village.json`。

## 起步顺序

1. 确认 `node -v` / `npm -v` 正常后初始化工程（`npm init` + 装 `vite` / `typescript`）。
2. 先写 `docs/00-总览/世界观.md` 与 `docs/10-世界/`，把术语表立起来。
3. 人物定稿后再镜像到 `data/characters/*.json`，同时在 `data/schema/` 补字段约束。
4. 代码从 `src/core/`（游戏循环、状态机）和 `src/data/`（加载器）开始。
