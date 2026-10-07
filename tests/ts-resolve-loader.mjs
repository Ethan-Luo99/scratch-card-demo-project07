/**
 * Node ESM 解析钩子（零依赖，仅 node --test 使用）：
 * src 内 TS 文件按 vue-tsc（TS 4.9）规范写扩展名省略的相对导入，
 * 而 Node 原生 type-stripping 要求显式扩展名 —— 这里为省略扩展名的
 * 相对导入补 '.ts' 后再走默认解析。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[a-z0-9]+$/i.test(specifier)
  ) {
    try {
      const candidate = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier + '.ts', context)
      }
    } catch {
      /* 落入默认解析 */
    }
  }
  return nextResolve(specifier, context)
}
