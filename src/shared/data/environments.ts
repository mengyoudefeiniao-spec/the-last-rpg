import type { EnvironmentTheme, WeatherPreset } from './types.ts';

/**
 * 场景外观表 —— 环境主题与天气。
 *
 * 这两样**只影响观感**，不参与任何战斗规则。之所以和战场（地形）分开，
 * 就是因为：地形会改战斗结果，环境不会。将来剧情切场景时，换的是这里。
 */

const ENVIRONMENTS: Record<string, EnvironmentTheme> = {
  'dusk-moor': {
    id: 'dusk-moor',
    name: '苍茫暮野',
    desc: '天光将尽的原野，一切颜色都沉了下去。',
    sky: 0x0a0f18,
    fog: 0x0a0f18,
    fogNear: 30,
    fogFar: 62,
    ground: 0x1b2533,
    gridMajor: 0x2f4358,
    gridMinor: 0x1f2c3c,
    keyLight: 0xffe6bd,
    keyIntensity: 2.0,
    hemiSky: 0x9fc4ff,
    hemiGround: 0x11161f,
    keyDirection: [9, 17, 11],
  },

  'frost-peak': {
    id: 'frost-peak',
    name: '寒山雪原',
    desc: '雪光把天地都映成青白色，连影子都是冷的。',
    sky: 0xbcd4e8,
    fog: 0xc6d9ea,
    fogNear: 22,
    fogFar: 54,
    ground: 0xdfe9f2,
    gridMajor: 0x9db6cd,
    gridMinor: 0xb9cde0,
    keyLight: 0xfff4e0,
    keyIntensity: 2.6,
    hemiSky: 0xdcecff,
    hemiGround: 0x8fa6bd,
    keyDirection: [6, 20, 9],
  },

  'ember-waste': {
    id: 'ember-waste',
    name: '赤炎焦土',
    desc: '地火把天边烧成暗红色，空气里全是焦味。',
    sky: 0x1c0d0a,
    fog: 0x2a1108,
    fogNear: 20,
    fogFar: 50,
    ground: 0x2b1a14,
    gridMajor: 0x6b3520,
    gridMinor: 0x42220f,
    keyLight: 0xff9a4d,
    keyIntensity: 2.4,
    hemiSky: 0xff7a3c,
    hemiGround: 0x1a0a06,
    keyDirection: [11, 14, 8],
  },

  'spirit-vale': {
    id: 'spirit-vale',
    name: '灵源幽谷',
    desc: '灵气自地脉渗出，草木与山石都泛着淡淡的青。',
    sky: 0x08161a,
    fog: 0x0b2226,
    fogNear: 26,
    fogFar: 58,
    ground: 0x18302f,
    gridMajor: 0x2f6b62,
    gridMinor: 0x1d4a44,
    keyLight: 0xc8ffe8,
    keyIntensity: 2.1,
    hemiSky: 0x7fffd4,
    hemiGround: 0x0d1f1c,
    keyDirection: [7, 18, 12],
  },
};

const WEATHERS: Record<string, WeatherPreset> = {
  clear: {
    id: 'clear',
    name: '晴',
    desc: '无风无雨。',
    kind: 'clear',
    density: 0,
    color: 0xffffff,
    fallSpeed: 0,
    drift: 0,
    size: 0,
  },

  snowfall: {
    id: 'snowfall',
    name: '飞雪',
    desc: '细雪斜斜落下，视野里全是白点。',
    kind: 'snow',
    density: 900,
    color: 0xffffff,
    fallSpeed: 2.6,
    drift: 1.1,
    size: 0.16,
  },

  downpour: {
    id: 'downpour',
    name: '骤雨',
    desc: '急雨砸下来，天地间拉起一道道斜线。',
    kind: 'rain',
    density: 1400,
    color: 0xa8d0ff,
    fallSpeed: 22,
    drift: 2.4,
    size: 0.1,
  },

  sandstorm: {
    id: 'sandstorm',
    name: '风沙',
    desc: '黄沙贴着地面横扫，连阵型都快看不清了。',
    kind: 'sand',
    density: 1100,
    color: 0xd9b06a,
    fallSpeed: 1.4,
    drift: 9,
    size: 0.14,
  },

  spiritMist: {
    id: 'spiritMist',
    name: '灵雾',
    desc: '灵气凝成的雾霭缓缓上浮，像是有人在暗处吐纳。',
    kind: 'mist',
    density: 700,
    color: 0x8effd8,
    fallSpeed: -0.7,
    drift: 0.4,
    size: 0.3,
  },
};

export const DEFAULT_ENVIRONMENT_ID = 'dusk-moor';
export const DEFAULT_WEATHER_ID = 'clear';

export function getEnvironment(id: string): EnvironmentTheme {
  return structuredClone(ENVIRONMENTS[id] ?? ENVIRONMENTS[DEFAULT_ENVIRONMENT_ID]!);
}

export function getWeather(id: string): WeatherPreset {
  return structuredClone(WEATHERS[id] ?? WEATHERS[DEFAULT_WEATHER_ID]!);
}

export function listEnvironments(): EnvironmentTheme[] {
  return Object.keys(ENVIRONMENTS).map((id) => getEnvironment(id));
}

export function listWeathers(): WeatherPreset[] {
  return Object.keys(WEATHERS).map((id) => getWeather(id));
}
