// 临时 git 夹具只验证仓库行为，不验证个人签名设置；用环境变量传给子进程，绝不改写用户配置。
const raw = Number(process.env.GIT_CONFIG_COUNT || '0')
const count = Number.isInteger(raw) && raw >= 0 ? raw : 0
process.env['GIT_CONFIG_KEY_' + count] = 'commit.gpgsign'
process.env['GIT_CONFIG_VALUE_' + count] = 'false'
process.env['GIT_CONFIG_KEY_' + (count + 1)] = 'tag.gpgsign'
process.env['GIT_CONFIG_VALUE_' + (count + 1)] = 'false'
process.env.GIT_CONFIG_COUNT = String(count + 2)
module.exports = {}
