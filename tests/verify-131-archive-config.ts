// verify-131-archive-config.ts —— 归档配置（票 #131）的行为门禁。
// 门禁归属: src/host/archiveConfig.ts
//
// 守的事（每条都会在坏实现下变红）：
//   ① 文件不存在 → 状态是 missing（首次配置不是错误）；
//   ② 文件是坏 JSON / 版本不认 / 仓库缺字段 → 状态是 unreadable，不当成有配置；
//   ③ 写入一个仓库后，读回的内容与写入的一致；
//   ④ 写第二个仓库不抹掉第一个（保住别的仓库的配置）；
//   ⑤ 文件坏的时候拒绝写，不静默覆盖（不销毁读不懂的数据）；
//   ⑥ 写入失败时临时文件被清掉，正式文件保持上一份完整内容（原子性）；
//   ⑦ 路径落在 <home>/.dsh/mattskillsdeck/ 下，与 choices.json 同一个约定。
//
// 全程用内存里的假文件系统，不碰真实主目录。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-131-archive-config.ts

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failed = false
let passCount = 0
let totalCount = 0

const check = (ok: boolean, msg: string): void => {
  totalCount++
  if (ok) passCount++
  else failed = true
  console.log((ok ? '  PASS ' : '  FAIL ') + msg)
}

/** Sistema de arquivos falso: um Map de caminho para texto. Erros de "não existe" usam code ENOENT. */
function makeFakeFs(initial: Record<string, string> = {}, failOn: { rename?: boolean; writeFile?: boolean } = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const port = {
    files,
    async mkdir(_dir: string) { return undefined },
    async readFile(p: string) {
      if (!files.has(p)) {
        const err = new Error('ENOENT: no such file ' + p) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return files.get(p) as string
    },
    async writeFile(p: string, data: string) {
      if (failOn.writeFile) throw new Error('disco cheio')
      files.set(p, data)
    },
    async rename(oldP: string, newP: string) {
      if (failOn.rename) throw new Error('falha ao trocar o arquivo')
      if (!files.has(oldP)) throw new Error('origem sumiu')
      files.set(newP, files.get(oldP) as string)
      files.delete(oldP)
    },
    async unlink(p: string) { files.delete(p) },
  }
  return port
}

const HOME = '/tmp/fake-home'

async function main(): Promise<void> {
  const mod: any = await import(pathToFileURL(path.join(ROOT, 'src/host/archiveConfig.ts')).href)
  const { readArchiveConfig, writeArchiveRepoConfig, archiveConfigFilePath, parseArchiveConfig, ARCHIVE_CONFIG_VERSION } = mod
  const FILE = path.join(HOME, '.dsh', 'mattskillsdeck', 'archive-config.json')

  console.log('\n[1] caminho e ausência')
  check(archiveConfigFilePath(HOME) === FILE, 'o arquivo fica em <home>/.dsh/mattskillsdeck/archive-config.json')
  check(archiveConfigFilePath('') === '', 'sem pasta home, o caminho é vazio')

  const empty = makeFakeFs()
  const r0 = await readArchiveConfig(HOME, empty)
  check(r0.state === 'missing', 'arquivo ausente vira estado missing (não é erro)')

  console.log('\n[2] leitura de arquivo ruim')
  check(parseArchiveConfig('{não é json', FILE).state === 'unreadable', 'JSON quebrado vira unreadable')
  check(parseArchiveConfig(JSON.stringify({ version: 99, repos: {} }), FILE).state === 'unreadable', 'versão não reconhecida vira unreadable')
  check(parseArchiveConfig(JSON.stringify({ version: ARCHIVE_CONFIG_VERSION, repos: { 'a/b': { cloneDir: '' , rootDir: 'x' } } }), FILE).state === 'unreadable', 'repositório com cloneDir vazio vira unreadable')
  check(parseArchiveConfig(JSON.stringify([1, 2]), FILE).state === 'unreadable', 'raiz que não é objeto vira unreadable')

  console.log('\n[3] gravar e reler')
  const fs1 = makeFakeFs()
  const w1 = await writeArchiveRepoConfig(HOME, 'ombrello/solar-docs', { cloneDir: '~/Work/Ombrello/ombrello-solar-docs', rootDir: 'engenharia/specs-arquivadas' }, fs1)
  check(w1.ok === true, 'gravar um repositório funciona')
  const r1 = await readArchiveConfig(HOME, fs1)
  check(r1.state === 'ok', 'depois de gravar, a leitura dá estado ok')
  check(r1.state === 'ok' && r1.doc.repos['ombrello/solar-docs'].cloneDir === '~/Work/Ombrello/ombrello-solar-docs', 'o caminho do clone volta igual ao gravado')
  check(r1.state === 'ok' && r1.doc.repos['ombrello/solar-docs'].rootDir === 'engenharia/specs-arquivadas', 'a pasta-raiz volta igual ao gravada')

  console.log('\n[4] gravar um segundo repositório não apaga o primeiro')
  const w2 = await writeArchiveRepoConfig(HOME, 'outro/repo', { cloneDir: '~/Work/outro', rootDir: 'docs' }, fs1)
  check(w2.ok === true, 'gravar o segundo repositório funciona')
  const r2 = await readArchiveConfig(HOME, fs1)
  check(r2.state === 'ok' && !!r2.doc.repos['ombrello/solar-docs'] && !!r2.doc.repos['outro/repo'], 'os dois repositórios convivem no arquivo')

  console.log('\n[5] arquivo ilegível não é sobrescrito')
  const bad = makeFakeFs({ [FILE]: '{ quebrado' })
  const wBad = await writeArchiveRepoConfig(HOME, 'x/y', { cloneDir: '/a', rootDir: 'b' }, bad)
  check(wBad.ok === false, 'gravar sobre arquivo ilegível é recusado')
  check(bad.files.get(FILE) === '{ quebrado', 'o conteúdo ilegível continua intacto no disco')

  console.log('\n[6] falha na troca não deixa lixo e não corrompe o original')
  const orig = JSON.stringify({ version: ARCHIVE_CONFIG_VERSION, repos: { 'a/b': { cloneDir: '/c', rootDir: 'd' } } })
  const failing = makeFakeFs({ [FILE]: orig }, { rename: true })
  const wFail = await writeArchiveRepoConfig(HOME, 'novo/repo', { cloneDir: '/e', rootDir: 'f' }, failing)
  check(wFail.ok === false, 'uma falha na troca é relatada, não engolida')
  check(failing.files.get(FILE) === orig, 'o arquivo original fica exatamente como estava')
  check(!failing.files.has(FILE + '.tmp'), 'o temporário é apagado depois da falha')

  console.log('\n[7] entrada inválida é recusada antes de tocar no disco')
  const fsNo = makeFakeFs()
  const wNo = await writeArchiveRepoConfig(HOME, 'x/y', { cloneDir: '', rootDir: 'z' }, fsNo)
  check(wNo.ok === false, 'cloneDir vazio é recusado')
  check(fsNo.files.size === 0, 'nada foi gravado no disco')

  console.log('\n' + passCount + '/' + totalCount + ' assertions passed')
  if (failed) {
    console.log('FAIL: verify-131-archive-config')
    process.exit(1)
  }
  console.log('GATE-RESULT: verify-131-archive-config PASS')
}

main().catch((e) => {
  console.error('FAIL: erro inesperado', e)
  process.exit(1)
})
