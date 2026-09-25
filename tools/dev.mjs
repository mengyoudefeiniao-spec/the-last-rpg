#!/usr/bin/env node
/**
 * 开发启动器：同时拉起 Vite（前端）与战斗服（后端）。
 *
 * 不引 concurrently 之类的依赖 —— 这里只需要 spawn 两个进程、给输出加前缀、
 * 任一退出就一起收摊。服务端用 Node 内置的类型剥离跑 .ts，不需要额外构建。
 */
import { spawn } from 'node:child_process';

const SPECS = [
  { name: 'vite', color: '\u001b[36m', command: 'npx', args: ['vite'] },
  { name: 'server', color: '\u001b[35m', command: 'node', args: ['src/server/index.ts'] },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

for (const spec of SPECS) {
  const child = spawn(spec.command, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
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
