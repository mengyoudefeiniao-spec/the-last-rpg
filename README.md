# The Last RPG

> 一句话简介：待补。

## 当前状态

**战斗系统最小可行原型已可运行**：一场 3v3 的完整回合制战斗，含 HP / MP / 愤怒（SP）三条资源、
增益与减益状态、九个指令按钮、战斗日志与目标选择。剧本与数据层尚未开始填充。

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

`Battle` 对 DOM 一无所知，只通过事件总线广播。浏览器里由 `BattleView` 订阅渲染，
Node 里由 `tests/` 订阅断言 —— 同一份战斗逻辑，两个消费者。

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

## 下一步

1. 先写 `docs/00-总览/世界观.md` 与 `docs/10-世界/`，把术语表立起来 —— 人物与地名定不下来，后面的数据表会一直返工。
2. 把 `src/data/sample-battle.ts` 里的占位数值搬到 `data/characters/*.json`，并在 `data/schema/` 补字段约束，让战斗真正由 `data/` 驱动。
3. 法宝 / 灵宝 / 召唤 / 捕捉 目前是占位实现（UI 上带「占位」标记）：资源消耗与日志齐全，效果是简化的统一逻辑。
4. 战斗演出目前同步跑完、一次性出结果。要加逐条动画时，把 `Battle` 的阶段推进改成由 UI 逐步驱动即可，逻辑层不用动。
