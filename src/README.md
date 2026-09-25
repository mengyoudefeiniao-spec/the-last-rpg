# src/ —— TypeScript 源码

## 分层与依赖方向

箭头表示「可以依赖」，反向依赖一律禁止（否则逻辑会漏进渲染层，变得无法测试）：

```
main → ui / render / input / audio → systems → core
                        ↘ data（加载与类型）↙
config / utils 被各层共用，自身不依赖任何人
```

## 各目录职责

- `core/`：引擎无关的骨架——游戏循环、场景与状态机、事件总线、可复现随机数、游戏内时间。
  **不得 import DOM 或浏览器 API**，这样核心逻辑可以在 Node 里直接测。
- `data/`：加载并校验 `data/*.json`，导出类型定义。`types.ts` 是全项目数据类型的唯一来源。
- `systems/`：纯玩法逻辑——战斗、背包、任务、对话、成长、经济。接收状态、返回结果，不画界面。
- `world/`：地图解析、实体与坐标、寻路与碰撞、NPC 调度、触发器。
- `render/`：把 `world` 的状态画到 Canvas/WebGL。**只读玩法状态，不修改**。
- `ui/`：HUD、菜单、对话框、设置面板。
- `input/`：键盘/鼠标/触摸/手柄 → 游戏内动作的映射。
- `audio/`：BGM/SFX 调度、音量与静音管理。
- `save/`：存档序列化（localStorage/IndexedDB）与版本迁移。
- `config/`：常量与平衡参数。调数值只改这里，别散落到各系统。
- `utils/`：无状态工具函数。

## 约定

- 文件名 `kebab-case.ts`，类型与类名 `PascalCase`。
- 新增玩法模块的顺序：先在 `systems/` 写纯逻辑 + 在 `tests/unit` 覆盖，再接 `ui/`、`render/`。
- 不在模块顶层读写 `window`、`localStorage` 等有副作用的全局对象，统一从入口注入，便于测试与换平台。
- 存档里只存**状态**，不存逻辑推导结果，避免版本升级后数据自相矛盾。
