import { existsSync, realpathSync, rmSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';

/** Cleanup is restricted to this workspace's tmp tree, including resolved symlinks. */
export function removeLocalTemp(path: string): void {
  if (!existsSync(path)) return;
  const root = realpathSync(resolve('tmp'));
  const target = realpathSync(path);
  const child = relative(root, target);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP');
  rmSync(target, { recursive: true, force: true });
}
