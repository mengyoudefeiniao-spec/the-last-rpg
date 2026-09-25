# data/ —— 游戏运行数据

程序直接读取的结构化数据。**只放定稿、可被程序消费的内容**；创作中的草稿留在 `docs/`。

## 格式约定

- 统一用 **JSON**。理由：浏览器原生支持、`tsc` 可 `import` 并做编译期类型检查、零依赖。
  若确实需要 YAML 的可读性，得额外引解析库且丢掉编译期检查，暂不推荐。
- 一个实体一个文件，**文件名即 ID**：`characters/char.hero.json`、`quests/quest.escape-village.json`。
- ID 规则：`类型.短横线名`，全小写，**一经使用不再改**——存档、引用、脚本全依赖它。
- 文本不要硬编码在代码里；面向玩家的文案走 `i18n/`，代码只引用 key。

## 各目录职责

- `schema/`：JSON Schema，定义每类文件的字段约束（必填、类型、取值范围）。
- `characters/`：角色属性、成长曲线、技能与装备引用。
- `dialogues/`：对白节点、分支、触发条件与效果。
- `quests/`：任务定义、目标、奖励、前置条件。
- `story/`：章节结构、剧情 flag、触发器、结局判定。
- `items/`：道具、装备、消耗品。
- `skills/`：技能与技能树。
- `maps/`：地图数据（瓦片层、碰撞层、出入口、NPC 布点）。
- `encounters/`：遭遇与战斗编组、掉落表。
- `i18n/`：文本表，中文原文与其它语言。

## 校验

`tools/` 下的脚本负责两件事：

1. **schema 校验**——文件是否符合 `schema/` 的约束；
2. **交叉引用检查**——例如任务引用的 NPC、地图布点的 NPC、掉落表引用的道具是否真实存在。

建议每次提交前跑一次。接入测试框架后，由 `tests/` 固化这条检查。

## 当前状态

### 已建立的 schema（8 个）

`common` · `character` · `quest` · `dialogue` · `story` · `encounter` · `item` · `skill`

### 已完成的数据（序章 + 第一卷）

| 目录 | 内容 |
| --- | --- |
| `characters/` | `char.hero`（主角跨世档案，含七世身份与可用指令）、`char.suzhao`、`char.yunhe` |
| `story/` | `story.prologue`、`story.vol1` |
| `quests/` | 序章 4 个 + 第一卷 5 个主线 + 1 个支线（`quest.side.caravan`） |
| `dialogues/` | `dlg.vol1.prologue`、`dlg.vol1.yunhe-stele`、`dlg.vol1.finale` |
| `encounters/` | 第一卷 3 场（野狗 / 野猪群 / 妖兽之乱） |
| `items/` | 轮回碑残段、平安符 |
| `skills/` | 法术（`skill.spell`）、缓存体（`skill.soul.cache`） |
| `i18n/` | `zh-CN`（样例，key 格式：`<实体 id>.<节点 id>.<字段>`） |

### 已知待补

- `story.vol1.next` → `story.vol2`：**第二卷数据未做**，跨章引用暂悬空（正常）。
- `maps/` 尚无数据：第一卷「隐藏洞窟」的布点待补。
- 第二至七世的 NPC / 任务 / 对话尚未导出（主角各世身份已写在 `char.hero` 内）。
