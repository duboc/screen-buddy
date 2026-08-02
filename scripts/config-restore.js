#!/usr/bin/env node
'use strict';

/**
 * Roll config.json back, from the command line.
 *
 * Deliberately plain Node with no Electron and no dependencies: the moment you
 * most need to undo a config change is the moment the app will not start
 * because of it, and a recovery tool that runs inside the broken thing is not a
 * recovery tool. This reads and writes ordinary JSON files in
 * config.backups/ and works with screen-buddy stopped.
 *
 *   npm run config:list
 *   npm run config:restore                 # most recent snapshot
 *   npm run config:restore -- <id>
 *   npm run config:reset                   # theme and layout only
 *   npm run config:reset -- --all          # everything, back to the template
 *   npm run config:pin -- "before neon"
 */

const fs = require('node:fs');
const path = require('node:path');
const restore = require('../src/main/restore');

const [, , command = 'list', ...rest] = process.argv;

const GREY = '\x1b[90m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

const when = (at) => {
  if (!at) return '';
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

function printList() {
  const entries = restore.list();
  console.log('');
  console.log(`${BOLD}Restore points${OFF} ${GREY}(${restore.paths.DIR})${OFF}`);
  console.log('');

  for (const [i, e] of entries.entries()) {
    const marker = i === 0 && e.kind !== 'shipped' ? `${GREEN}*${OFF}` : ' ';
    const kind =
      e.kind === 'pinned'
        ? `${YELLOW}pinned${OFF}`
        : e.kind === 'shipped'
          ? `${GREEN}shipped${OFF}`
          : `${GREY}auto${OFF}`;
    const size = e.bytes ? `${(e.bytes / 1024).toFixed(1)} kB` : '';
    console.log(
      `${marker} ${e.id}\n    ${kind}  ${GREY}${when(e.at)}  ${size}  ${e.label}${OFF}`,
    );
  }
  console.log('');
  console.log(`${GREY}Roll back with:  npm run config:restore -- <id>${OFF}`);
  console.log('');
}

function ok(result) {
  console.log(`${GREEN}Restored${OFF} ${result.restored}`);
  if (result.previous) {
    console.log(
      `${GREY}The configuration you just replaced was saved as ${result.previous} — this is undoable.${OFF}`,
    );
  }
  console.log(`${GREY}Restart screen-buddy to pick it up:  npm run restart${OFF}`);
}

try {
  switch (command) {
    case 'list':
      printList();
      break;

    case 'restore': {
      let id = rest[0];
      if (!id) {
        // No argument means "undo the last thing", which is what anyone typing
        // this in a hurry wants. The shipped template is skipped, since falling
        // back to it is what `reset` is for and doing it by accident would be a
        // surprise.
        const newest = restore.list().find((e) => e.kind !== 'shipped');
        if (!newest) {
          console.error('No restore points yet. Use `npm run config:reset -- --all`.');
          process.exit(1);
        }
        id = newest.id;
        console.log(`${GREY}No id given; using the most recent: ${id}${OFF}`);
      }
      ok(restore.restore(id));
      break;
    }

    case 'reset': {
      const all = rest.includes('--all');
      const result = restore.reset({ scope: all ? 'all' : 'appearance' });
      console.log(
        all
          ? `${GREEN}Reset to the shipped template.${OFF}`
          : `${GREEN}Theme and layout reset.${OFF} ${GREY}Display, window and sensor settings kept.${OFF}`,
      );
      if (result.previous) {
        console.log(
          `${GREY}Previous configuration saved as ${result.previous} — this is undoable.${OFF}`,
        );
      }
      console.log(`${GREY}Restart screen-buddy to pick it up:  npm run restart${OFF}`);
      break;
    }

    case 'pin': {
      const entry = restore.pin(rest.join(' '));
      if (!entry) {
        console.error('Nothing to pin: config.json does not exist yet.');
        process.exit(1);
      }
      console.log(`${GREEN}Pinned${OFF} ${entry.id}`);
      console.log(`${GREY}Pinned points are never pruned automatically.${OFF}`);
      break;
    }

    case 'show':
      process.stdout.write(restore.read(rest[0] ?? restore.SHIPPED));
      break;

    default:
      console.error(`Unknown command "${command}". Try: list, restore, reset, pin, show`);
      process.exit(1);
  }
} catch (err) {
  console.error(`${YELLOW}${err.message}${OFF}`);
  process.exit(1);
}
