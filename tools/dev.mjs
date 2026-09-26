#!/usr/bin/env node
/**
 * 开发启动器：同时拉起 Vite（前端）与战斗服（后端）。
 *
 * 不引 concurrently 之类的依赖 —— 这里只需要 spawn 两个进程、给输出加前缀、
 * 任一退出就一起收摊。服务端用 Node 内置的类型剥离跑 .ts，不需要额外构建。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/*
 * 直接跑各自的入口，**不走 npx、不开 shell**。
 *
 * 在 Windows 上 npx 是 .cmd，非得 shell: true 才执行得了；而一旦开 shell，
 * Node 会把 args 直接拼进命令行（不做转义），于是触发 DEP0190 警告。
 * 绕开它最简单：用 process.execPath（就是当前这个 node）+ 脚本路径。
 */
const SPECS = [
  {
    name: 'vite',
    color: '\u001b[36m',
    command: process.execPath,
    args: [resolve('node_modules/vite/bin/vite.js')],
  },
  {
    name: 'server',
    color: '\u001b[35m',
    command: process.execPath,
    args: [resolve('src/server/index.ts')],
  },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.killed || child.pid === undefined) continue;

    if (process.platform === 'win32') {
      /*
       * Windows 上 kill() 只送得到直接子进程，孙子进程（vite 自己 fork 的
       * esbuild 之类）会留在原地占着端口 —— 下次启动就 EADDRINUSE。
       * taskkill /T 连整棵进程树一起收，才是干净的做法。
       */
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  }

  process.exit(code);
}

for (const spec of SPECS) {
  const child = spawn(spec.command, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const prefix = `${spec.color}[${spec.name}]\u001b[0m `;

  const forward = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
  };

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}已退出（code=${code}），正在关闭其余进程…\n`);
    shutdown(code ?? 0);
  });

  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write('开发环境启动中：前端 Vite + 后端战斗服（Ctrl+C 结束）\n');
