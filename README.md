# The Last RPG

> 一句话简介：待补。

## 当前状态

**可运行的战斗原型**：5v5 的完整回合制战斗 —— 3D 战场（three.js）+ 头顶血条 + 底部指令栏 + 战斗日志。
含 HP / MP / 愤怒（SP）三条资源、增益与减益状态、九个指令、逐动作演出与视角控制。
剧本与数据层尚未开始填充。

### 运行

```powershell
npm install       # 首次
npm run dev       # 开发服务器，浏览器打开终端提示的地址
npm test          # 跑战斗逻辑测试（Node 内置测试器，不需要浏览器）
npm run typecheck # 类型检查
npm run build     # 类型检查 + 生产构建到 dist/
```

## 技术栈

- 语言：TypeScript
- 运行环境：浏览器（无后端；存档先用 `localStorage`，需要大量数据时换 `IndexedDB`）
- 构建工具：Vite，入口为根目录 `index.html` + `src/main.ts`
- 3D：three.js（战场与角色，都在 `src/render/`）

源码统一使用**带 `.ts` 扩展名**的相对导入。这样同一份逻辑：浏览器里由 Vite 处理，
`node --test` 里由 Node 内置的类型剥离直接跑 —— 无需任何额外构建步骤。
代价是 `tsconfig.json` 必须开 `allowImportingTsExtensions`。

## 战斗系统

回合状态机在 `src/systems/battle/battle.ts`，一个回合依次经过：

```
turnStart → commandInput → statusSettlement → executeCommands
          → bothSidesAction → actionEnd → （下一回合）
```

| 阶段 | 做什么 |
| --- | --- |
| `turnStart` | 回合数 +1、自然回复 MP/SP、结算回合开始触发的状态 |
| `commandInput` | 暂停，等待 UI 为每个我方单位收集指令 |
| `statusSettlement` | 判定能否行动（眩晕等）、汇总属性修正 |
| `executeCommands` | 校验并固化指令；防御与逃跑立即生效 |
| `bothSidesAction` | 按速度排序，敌我双方依次结算行动 |
| `actionEnd` | 结算 DoT/HoT，状态倒计时与到期移除 |

`Battle` 对 DOM 一无所知，只通过事件总线广播；事件由 `BattleView`（HUD）与
`BattleStage`（3D 战场）订阅，Node 里则由 `tests/` 订阅断言 —— 同一份战斗逻辑，多个消费者。

## 3D 战场与演出

战场在 `src/render/battle-stage.ts`：固定机位的立体战场，敌方 5 个单位在画面**左上**、
我方 5 个在**右下**，头顶挂 `CSS2DRenderer` 投影的血条（纯 DOM，所以样式可以复用 CSS）。

**视角规则**：只有指令阶段（`commandInput`）能拖动旋转、滚轮缩放，其余阶段一律锁定，
免得演到一半视角乱转。方位角与俯仰角都做了限位，防止转到敌我背后让「敌上我下」的构图失去意义。

**演出**走依赖倒置：`Battle` 定义 `BattleDirector` 接口（`onTurnStart` / `beforeAction` /
`onStrike` / `onStatus` / `afterAction`），在每个动作点 `await` 表现层。
`BattleStage` 实现它（前冲、挥击、受击闪红后退、飘伤害数字、倒下躺平）；
测试不挂 director，所有 await 直接跳过 —— 战斗瞬间跑完，这正是测试要的。

演出速度在顶栏可调（慢 / 常规 / 快 / 极快）。**默认「快」（2 倍速）**：十人一回合在 1 倍速下要 8 秒，
实测下来容易让人以为卡住了。

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
src/      源码（core → systems → render/ui 单向依赖）
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

## 下一步

1. 先写 `docs/00-总览/世界观.md` 与 `docs/10-世界/`，把术语表立起来 —— 人物与地名定不下来，后面的数据表会一直返工。
2. 把 `src/data/sample-battle.ts` 里的占位数值搬到 `data/characters/*.json`，并在 `data/schema/` 补字段约束，让战斗真正由 `data/` 驱动。
3. 法宝 / 灵宝 / 召唤 / 捕捉 仍是占位实现（UI 上带「占位」标记）：资源消耗与日志齐全，效果是简化的统一逻辑。
4. 角色目前是胶囊 + 球的几何体占位。接真模型时替换 `battle-stage.ts` 里 `createUnitView` 的建模部分即可，演出逻辑不用动。
