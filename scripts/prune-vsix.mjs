// Keeps the newest three .vsix packages in the project root and deletes the older ones.
import { readdirSync, statSync, unlinkSync } from 'node:fs';

const KEEP = 3;
const files = readdirSync('.')
  .filter((f) => f.endsWith('.vsix'))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
for (const f of files.slice(KEEP)) unlinkSync(f);
