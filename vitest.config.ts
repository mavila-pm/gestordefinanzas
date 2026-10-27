import { configDefaults, defineConfig } from 'vitest/config';

// Agent worktrees (.claude/worktrees) hold full copies of the repo: their tests must never run with this checkout's.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
