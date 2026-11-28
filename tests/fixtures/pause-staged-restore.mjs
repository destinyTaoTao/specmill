import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname } from 'node:path';

// Pause the test server after the real write, while its restore is still in flight.
const writeFile = fs.writeFile;
fs.writeFile = async (path, ...args) => {
  const result = await writeFile(path, ...args);
  if (typeof path === 'string' && basename(dirname(path)).startsWith('.restore-')) {
    process.stdout.write('restore-staged\n');
    await new Promise(() => {});
  }
  return result;
};
syncBuiltinESMExports();
