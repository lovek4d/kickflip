#!/usr/bin/env node
// node agent.mjs start|progress|done <wave>/<id> ... is `node board.mjs builder ...`; sessions still call it by this name.
import { main } from './board.mjs';

process.exitCode = await main(['builder', ...process.argv.slice(2)]);
