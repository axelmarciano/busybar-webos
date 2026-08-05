#!/usr/bin/env node
// npx/global entrypoint: registers the tsx loader, then boots the TS sources.
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
