/**
 * 生成 client.js。
 *
 * 本插件的浏览器半边没有需要内嵌的资源，所以 build 就是把 src/client.js
 * 抄成 client.js（DSH 加载的是后者）。留着这一步，是为了和 dsh-search 一样
 * 守住「改 src 之后要重新生成」的规矩。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'src', 'client.js')
const target = join(root, 'client.js')

const text = readFileSync(source, 'utf8')
for (const placeholder of ['__MASCOT_DATA_URL__', '__PLACEHOLDER__']) {
  if (text.includes(placeholder)) throw new Error(`src/client.js 还留着占位符 ${placeholder}`)
}
writeFileSync(target, text, 'utf8')
console.log(`client.js 已生成：${text.length} 字节`)
