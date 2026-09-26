#!/usr/bin/env node
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
  cwd: process.cwd(),
});
