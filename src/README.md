# src/ —— TypeScript 源码

## 三层结构

代码按「谁运行它」分成三层，这直接决定了它能 import 什么：

```
src/
├─ shared/   前后端共用 —— 战斗规则、数据表、协议。不得 import DOM 或 Node API
├─ server/   只在 Node 里跑 —— 权威状态与网络入口
└─ client/   只在浏览器里跑 —— 渲染与交互
```

依赖方向是单向的：`server → shared ← client`。
shared 不知道另外两层的存在，所以同一套战斗规则既可以被服务端执行，也能被 Node 测试直接跑。

## 各目录职责

### shared/ —— 规则与数据的所在

- `data/types.ts`：全项目类型的唯一来源。
- `data/statuses.ts`：状态表（中毒、冻伤、灼地……）。**是数据，不含逻辑。**
- `data/battlefields.ts`：战场定义 —— 敌方阵位 + 地形分区 + 上方事件区。
- `data/formations.ts`：阵法表 —— 阵位坐标与阵图连线。**只作用于我方。**
- `data/environments.ts`：环境主题与天气预设。**只影响观感，不参与规则。**
- `data/stage-events.ts`：剧情事件表（目前只有演示用的渡劫天雷）。
- `data/sample-battle.ts`：占位队伍数据，等 `docs/` 的人物定稿后由 `data/characters/*.json` 取代。
- `config/balance.ts`：数值参数，含行动条的 `gaugeMax` / `gaugeRate` / `gaugeStep`。调平衡只改这里。
- `core/`：可复现随机数、事件总线等无副作用的小工具。
- `systems/battle/battle.ts`：**行动条（实时 ATB）驱动的战斗**，以及剧情事件的结算入口。
- `systems/battle/ai.ts`：敌人 AI 与自动战斗决策。
- `systems/battle/terrain.ts`：地形判定（谁站在哪个区域）。
- `systems/battle/status-effects.ts`：状态结算逻辑（叠加、倒计时、DoT/HoT）。
- `systems/battle/battle-unit.ts`：单位构造与伤害公式。
- `systems/battle/commands.ts`：九种指令的定义与可用性校验。
- `protocol.ts`：前后端契约。**改协议就是改这里**，两侧编译会同时报错。

### server/ —— 权威状态与时间

- `server.ts`：WebSocket 入口，同时也是**节拍器** —— 按 100ms 推进行动条，
  并靠「演出闸门」协调推进与播放。导出 `startBattleServer()`，集成测试直接把它拉起来。
- `battle-session.ts`：一场战斗的会话，也就是这个游戏的「全局缓存」。
- `party-config.ts`：队伍出战配置（阵法 / 战场 / 环境 / 天气）落盘。
  **阵法与场景是战斗外的设定**，不能存在会话里 —— 否则重开一局就丢了。

### client/ —— 只负责表现

- `net/battle-client.ts`：WebSocket 收发，不解析语义、不改状态。
- `state/battle-mirror.ts`：服务端快照的本地只读副本，含行动值的插值基点。
- `render/battle-stage.ts`：three.js 战场、地形分区、阵图、天气、演出播放。
- `render/formation-view.ts`：阵图（阵位圆环 + 连线）。
- `render/weather.ts`：天气粒子层。
- `render/animator.ts`：极简补间，带速度倍率。
- `ui/battle-view.ts`：HUD —— 顶栏、右上角行动条、布阵面板、指令栏、日志、队伍配置弹窗。

## 六条不许破的边界

1. **shared 不许 import client 或 server** —— 一旦破了，测试就再也跑不动了。
2. **客户端不许推导任何战斗结果** —— 扣多少血、谁先到行动点、特技能不能放，
   全由服务端算完推过来。连「指令按钮该不该置灰」都是服务端的 `commands` 字段说了算。
3. **战斗逻辑里不许出现定时器** —— 时间一律由 `Battle.advance(deltaMs)` 从外部注入：
   服务端按节拍喂，测试喂一大段。一旦有了定时器，测试就没法在毫秒内跑完整场战斗。
4. **地形效果只在 `terrain.ts` 判定一次** —— 想加新地形只改 `data/battlefields.ts`。
5. **状态表在 `data/`，状态逻辑在 `systems/`** —— 数据层不该反向依赖逻辑层。
6. **阵法只管站位与阵图，环境只管观感** —— 两者都不该偷偷影响战斗结算。

## 约定

- 文件名 `kebab-case.ts`，类型与类名 `PascalCase`。
- 相对导入一律**带 `.ts` 扩展名**：浏览器端交给 Vite，Node 端由内置类型剥离直接跑，
  两端都不需要额外的构建步骤（代价是 `tsconfig.json` 要开 `allowImportingTsExtensions`）。
- 不在模块顶层读写 `window` / `localStorage` 等有副作用的对象，统一从入口注入。
- 演出节奏的开关只有 `render/battle-stage.ts` 顶部的 `TIMING` 一处，别散落。
- **行动条心跳（`tick`）不许排进演出队列** —— 它只挪动条上的图标。一旦跟着演出一起排队，
  行动条就会滞后于真实进度，看起来像「卡在行动点上等人下指令」。
- **我方到点即冻结全场** —— `advance()` 一看到有人在等指令就立刻收手，敌我也不许再攒条。
  这条方向反复过一次，别想当然：**演出不拦推进，玩家才拦**。
- 集成测试必须把 `PARTY_CONFIG_PATH` 指向临时文件 —— 别改开发者本地的队伍配置。
