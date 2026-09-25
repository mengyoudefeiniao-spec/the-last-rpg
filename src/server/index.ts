import { startBattleServer } from './server.ts';

/**
 * 战斗服入口。
 * 所有逻辑都在 server.ts 里，这里只负责读环境变量、启动、打印地址 ——
 * 这样集成测试可以直接把 server.ts 拉起来，而不必 spawn 一个进程。
 */
const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';

const server = await startBattleServer({ port, host });
console.log(`[server] 战斗服已就绪 → ${server.url}`);
