// 临时 git 夹具只验证仓库行为，不验证个人设置；用环境变量传给子进程，绝不改写用户配置。
//
// 两层隔离，缺一不可：
//  1. 签名：commit.gpgsign / tag.gpgsign 关掉。夹具仓库里没有签名密钥，开着签名要么失败要么偷偷用本机的 gpg-agent 成功，
//     两种结果都不是在验证仓库行为。
//  2. 全局与系统配置：GIT_CONFIG_GLOBAL 指向一个空文件，GIT_CONFIG_NOSYSTEM=1。本机的 core.hooksPath 会让 `git rev-parse
//     --git-path hooks` 与 `git hook run` 去读用户目录里的钩子，而不是夹具仓库的 .git/hooks；全局身份、别名也会混进来。
//     只把 core.hooksPath 置空不行：产品代码要读到真实的 hooksPath，置空会让它读不到而抛错（已试过）。
//
// 反例（不要这样改）：不要用 GIT_CONFIG_COUNT 单独覆盖 core.hooksPath——它挡不住全局文件里别的键。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const raw = Number(process.env.GIT_CONFIG_COUNT || '0')
const count = Number.isInteger(raw) && raw >= 0 ? raw : 0
process.env['GIT_CONFIG_KEY_' + count] = 'commit.gpgsign'
process.env['GIT_CONFIG_VALUE_' + count] = 'false'
process.env['GIT_CONFIG_KEY_' + (count + 1)] = 'tag.gpgsign'
process.env['GIT_CONFIG_VALUE_' + (count + 1)] = 'false'
process.env.GIT_CONFIG_COUNT = String(count + 2)

// 已经有人显式指定了全局配置（比如某个门禁要测全局身份）就尊重它，不覆盖。
if (!process.env.GIT_CONFIG_GLOBAL) {
  const emptyGlobal = path.join(os.tmpdir(), 'dsh-gate-empty-gitconfig')
  fs.writeFileSync(emptyGlobal, '')
  process.env.GIT_CONFIG_GLOBAL = emptyGlobal
}
process.env.GIT_CONFIG_NOSYSTEM = '1'
