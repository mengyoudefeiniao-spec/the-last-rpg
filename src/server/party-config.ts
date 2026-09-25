import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BATTLEFIELD_ID } from '../shared/data/battlefields.ts';
import { DEFAULT_ENVIRONMENT_ID, DEFAULT_WEATHER_ID } from '../shared/data/environments.ts';
import { DEFAULT_FORMATION_ID } from '../shared/data/formations.ts';
import type { PartyConfig } from '../shared/data/types.ts';

/**
 * 服务端的「队伍出战配置」。
 *
 * 阵法与场景是**战斗外**的设定，所以它们不能存在战斗会话里 —— 那样重开一局就丢了。
 * 这里把它落到磁盘上：重开一局、甚至进程重启，配置都还在。
 *
 * 将来菜单里的设置页写的正是这份数据；现在先用顶栏那个临时入口代替。
 */

/**
 * 配置文件位置。
 *
 * 支持用 PARTY_CONFIG_PATH 覆盖 —— 集成测试据此指向一个临时文件，
 * 免得跑一次测试就把开发者本地的队伍配置改掉。
 */
function configFile(): string {
  const override = process.env['PARTY_CONFIG_PATH'];
  if (override && override.length > 0) return override;
  return join(projectRoot(), '.runtime', 'party-config.json');
}

/** 本文件位于 <root>/src/server/，往上两级就是项目根。 */
function projectRoot(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
}

function defaults(): PartyConfig {
  return {
    formationId: DEFAULT_FORMATION_ID,
    battlefieldId: DEFAULT_BATTLEFIELD_ID,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    weatherId: DEFAULT_WEATHER_ID,
  };
}

/** 读配置。文件不存在或损坏时回落到默认值 —— 配置坏掉不该让战斗服起不来。 */
export async function readPartyConfig(): Promise<PartyConfig> {
  try {
    const raw = await readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PartyConfig>;
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

/**
 * 局部更新并落盘，返回更新后的完整配置。
 * 逐个字段取而不是直接展开 patch —— 用户可能只想换阵法，不该把其它字段冲成 undefined。
 */
export async function writePartyConfig(patch: Partial<PartyConfig>): Promise<PartyConfig> {
  const current = await readPartyConfig();
  const next: PartyConfig = {
    formationId: patch.formationId ?? current.formationId,
    battlefieldId: patch.battlefieldId ?? current.battlefieldId,
    environmentId: patch.environmentId ?? current.environmentId,
    weatherId: patch.weatherId ?? current.weatherId,
  };

  const file = configFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return next;
}
