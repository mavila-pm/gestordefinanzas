// Lets Node (--experimental-strip-types) run scripts that import src/ modules written with extensionless
// specifiers (as Next/TypeScript allow). Usage: node --experimental-strip-types --import ./scripts/ts-resolve.mjs <script.ts>
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if ((spec.startsWith('.') || spec.startsWith('/')) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
    throw e;
  }
}`));
