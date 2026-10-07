/** 注册 tests/ts-resolve-loader.mjs（npm run test:engine 通过 --import 加载）。 */
import { register } from 'node:module'

register('./ts-resolve-loader.mjs', import.meta.url)
