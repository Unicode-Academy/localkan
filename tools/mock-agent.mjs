#!/usr/bin/env node
// Mock coding agent for testing Localkan + Orca without spending AI credits.
//
// Run it inside an Orca terminal (the bridge does this when a card uses the "mock" agent
// in dev mode). It waits for Orca's worker preamble + TASK block on stdin, then:
//   - if the task text contains "ASK:", asks the coordinator a blocking question first
//     ("ASK: question || a, b" offers the choices a and b);
//   - if it contains "LOGIN: <url>", opens <url> in Orca's shared browser, asks for a sign-in
//     with a "[LOGIN] <url>" question, then records what the page shows after the answer;
//   - if it contains "FAIL", reports failure;
//   - otherwise appends a line to MOCK_CHANGES.md and reports success (in a multi-repo task
//     folder: in every repo listed in the task, or only the one named by "ONLY: <repo>").
// Every message goes through the `orca orchestration` CLI, exactly like a real worker.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCA = process.env.ORCA_BIN || 'orca';
let buffer = '';
let timer = null;

function log(msg) {
  process.stdout.write(`[mock-agent] ${msg}\n`);
}

function orca(args) {
  return execFileSync(ORCA, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function handleTask(text) {
  const taskId = text.match(/--task-id (task_[A-Za-z0-9]+)/)?.[1];
  const dispatchId = text.match(/--dispatch-id (ctx_[A-Za-z0-9]+)/)?.[1];
  const spec = text.split('=== TASK ===').pop().trim();
  // Use the sender handle Orca wrote into the preamble; it proves this pane is the assignee.
  const from = text.match(/--type worker_done[^\n]*?--from (\S+)/)?.[1] || text.match(/--from (term_[A-Za-z0-9-]+)/)?.[1] || 'worker';
  if (!taskId || !dispatchId) {
    log('Could not find task/dispatch ids in the preamble; ignoring input.');
    return;
  }
  log(`task=${taskId} dispatch=${dispatchId}`);
  log(`spec: ${spec.slice(0, 200)}`);

  let answer = '';
  const ask = spec.match(/ASK:\s*(.+)/);
  if (ask) {
    // "ASK: question || option a, option b" offers choices.
    const [question, options] = ask[1].split('||').map((x) => x.trim());
    log(`asking coordinator: ${question}`);
    const args = ['orchestration', 'ask', '--from', from, '--question', question, '--timeout-ms', '600000'];
    if (options) args.push('--options', options);
    answer = orca(args).trim();
    log(`coordinator answered: ${answer}`);
  }

  const login = spec.match(/LOGIN:\s*(https?:\/\/\S+)/);
  if (login) {
    const url = login[1];
    const tab = JSON.parse(orca(['tab', 'create', '--url', url, '--json']));
    const page = tab.result.browserPageId;
    log(`opened ${url} in Orca's browser (page ${page}); asking for a sign-in`);
    answer = orca(['orchestration', 'ask', '--from', from, '--question', `[LOGIN] ${url} needs the test account`, '--timeout-ms', '600000']).trim();
    log(`coordinator answered: ${answer}`);
    orca(['reload', '--page', page, '--json']);
    execFileSync('sleep', ['1']);
    const body = JSON.parse(orca(['eval', '--page', page, '--expression', 'document.body.innerText', '--json'])).result.result;
    answer = `page after sign-in: ${String(body).replace(/\s+/g, ' ').slice(0, 80)}`;
    log(answer);
  }

  log('working…');
  if (/FAIL/.test(spec)) {
    orca([
      'orchestration', 'send', '--from', from, '--type', 'worker_done',
      '--subject', 'Mock failure',
      '--body', 'The mock agent was told to fail. Nothing was changed. Retry without FAIL in the task.',
      '--task-id', taskId, '--dispatch-id', dispatchId, '--outcome', 'failed',
    ]);
    log('reported failure');
    return;
  }

  // Multi-repo task folder: the spec lists the repos ("- `frontend/`: its own git repository");
  // edit each of them, or only the one named by "ONLY: <repo>".
  const repos = [...spec.matchAll(/^- `([^`/]+)\/`: its own git repository/gm)].map((m) => m[1]);
  const only = spec.match(/ONLY:\s*(\S+)/)?.[1];
  const dirs = repos.length ? repos.filter((r) => !only || r === only).map((r) => join(process.cwd(), r)) : [process.cwd()];
  for (const dir of dirs) {
    const file = join(dir, 'MOCK_CHANGES.md');
    appendFileSync(file, `- ${new Date().toISOString()} ${spec.split('\n')[0].slice(0, 120)}${answer ? ` (answer: ${answer})` : ''}\n`);
    log(`edited ${file}`);
  }
  if (spec.includes('.localkan/handoff.md')) {
    mkdirSync(join(process.cwd(), '.localkan'), { recursive: true });
    const saw = [/Project memory/.test(spec) && 'project memory', /continues the earlier task/.test(spec) && 'parent handoff', /Recent work/.test(spec) && 'recent notes']
      .filter(Boolean)
      .join(', ');
    writeFileSync(
      join(process.cwd(), '.localkan', 'handoff.md'),
      `## ${spec.split('\n')[0]}\n\n- Appended one line to MOCK_CHANGES.md.\n- Context received: ${saw || 'none'}.\n`,
    );
    log('wrote .localkan/handoff.md');
  }
  orca([
    'orchestration', 'send', '--from', from, '--type', 'worker_done',
    '--subject', 'Mock change done',
    '--body', `Appended one line to MOCK_CHANGES.md. The mock agent made no other changes. Nothing is left to do.`,
    '--task-id', taskId, '--dispatch-id', dispatchId, '--outcome', 'succeeded',
    '--files-modified', 'MOCK_CHANGES.md',
  ]);
  log('reported success; idle.');
}

log(`ready in ${process.cwd()} (waiting for a task)`);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  // Strip bracketed-paste markers that terminals add around pasted text.
  buffer += chunk.replace(/\u001b\[20[01]~/g, '');
  if (!buffer.includes('=== TASK ===')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const text = buffer;
    buffer = '';
    try {
      handleTask(text);
    } catch (err) {
      log(`error: ${err.stderr || err.message}`);
    }
  }, 1500);
});
