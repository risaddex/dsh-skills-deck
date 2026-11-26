// verify-131-archive-config.ts —— 归档配置（票 #131）的行为门禁。
// 门禁归属: src/host/archiveConfig.ts
//
// 守的事（每条都会在坏实现下变红）：
//   ① 文件不存在 → 状态是 missing（首次配置不是错误）；
//   ② 文件是坏 JSON / 版本不认 / 仓库缺字段 → 状态是 unreadable，并带上给日志用的枚举；
//   ③ 写入一个仓库后，读回的内容与写入的一致；
//   ④ 写第二个仓库不抹掉第一个（保住别的仓库的配置）；
//   ⑤ 文件读不了（坏内容、也包括 EACCES 这类读盘失败）时一律拒绝写，不静默覆盖：
//      只有「不存在」才允许从空文档开始（PR #136 评审 P2）；
//   ⑥ 写入失败时临时文件被清掉，正式文件保持上一份完整内容（原子性）；
//   ⑦ 路径落在 <home>/.dsh/mattskillsdeck/ 下，与 choices.json 同一个约定；
//   ⑧ 同一个文件上同时发起多次写：全部成功、全部保留，临时文件互不相同（PR #136 评审 P2）；
//   ⑨ 持久化边界的日志（PR #136 评审 P1）：坏文件与写失败各留一条告警、写成功只在调试档留一条；
//      字段恰好是约定的那几个，不带路径、仓库名与配置内容，日志本身出错不影响读写结果。
//
// 全程用内存里的假文件系统与假日志，不碰真实主目录。
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface FakeFsOptions {
  /** Faz o rename falhar com este código de sistema. */
  renameFails?: string
  /** Faz a leitura do arquivo falhar com este código de sistema (por exemplo EACCES). */
  readFails?: string
  /** Atraso artificial nas leituras e escritas, para forçar chamadas sobrepostas. */
  delayMs?: number
}

/** Sistema de arquivos falso: um Map de caminho para texto. "Não existe" usa code ENOENT. */
function makeFakeFs(initial: Record<string, string> = {}, opts: FakeFsOptions = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const writes: string[] = []
  const renames: string[] = []
  const delay = async (): Promise<void> => { if (opts.delayMs) await sleep(opts.delayMs) }
  const systemError = (code: string): Error => {
    const err = new Error(code + ': simulated failure') as Error & { code?: string }
    err.code = code
    return err
  }
  return {
    files,
    writes,
    renames,
    async mkdir(_dir: string) { return undefined },
    async readFile(p: string) {
      await delay()
      if (opts.readFails) throw systemError(opts.readFails)
      if (!files.has(p)) throw systemError('ENOENT')
      return files.get(p) as string
    },
    async writeFile(p: string, data: string) {
      await delay()
      writes.push(p)
      files.set(p, data)
    },
    async rename(oldP: string, newP: string) {
      renames.push(newP)
      if (opts.renameFails) throw systemError(opts.renameFails)
      if (!files.has(oldP)) throw new Error('origem sumiu: ' + oldP)
      files.set(newP, files.get(oldP) as string)
      files.delete(oldP)
    },
    async unlink(p: string) { files.delete(p) },
  }
}

/** Log falso. `debugOn` liga o nível de depuração; `explode` faz o log lançar erro. */
function makeLog(opts: { debugOn?: boolean; explode?: boolean } = {}) {
  const events: Array<{ level: string; event: string; fields: Record<string, unknown> }> = []
  return {
    events,
    fire(level: string, event: string, fields?: unknown) {
      if (opts.explode) throw new Error('o log quebrou')
      events.push({ level, event, fields: (fields || {}) as Record<string, unknown> })
    },
    isEnabled(level: string) {
      if (opts.explode) throw new Error('o log quebrou')
      return level !== 'debug' || !!opts.debugOn
    },
  }
}

const keysOf = (o: Record<string, unknown>): string => Object.keys(o).sort().join(',')

const HOME = '/tmp/fake-home'

async function main(): Promise<void> {
  const mod: any = await import(pathToFileURL(path.join(ROOT, 'src/host/archiveConfig.ts')).href)
  const { readArchiveConfig, writeArchiveRepoConfig, archiveConfigFilePath, parseArchiveConfig, ARCHIVE_CONFIG_VERSION } = mod
  const FILE = path.join(HOME, '.dsh', 'mattskillsdeck', 'archive-config.json')
  const REPO_A = { cloneDir: '~/Work/Ombrello/ombrello-solar-docs', rootDir: 'engenharia/specs-arquivadas' }
  const goodDoc = (repos: Record<string, unknown>): string => JSON.stringify({ version: ARCHIVE_CONFIG_VERSION, repos })

  console.log('\n[1] caminho e ausência')
  check(archiveConfigFilePath(HOME) === FILE, 'o arquivo fica em <home>/.dsh/mattskillsdeck/archive-config.json')
  check(archiveConfigFilePath('') === '', 'sem pasta home, o caminho é vazio')
  const r0 = await readArchiveConfig(HOME, { fs: makeFakeFs() })
  check(r0.state === 'missing', 'arquivo ausente vira estado missing (não é erro)')

  console.log('\n[2] leitura de arquivo ruim')
  const bad = (text: string): any => parseArchiveConfig(text, FILE)
  check(bad('{não é json').state === 'unreadable' && bad('{não é json').code === 'not-json', 'JSON quebrado vira unreadable com código not-json')
  check(bad(JSON.stringify({ version: 99, repos: {} })).code === 'bad-version', 'versão não reconhecida vira unreadable com código bad-version')
  check(bad(goodDoc({ 'a/b': { cloneDir: '', rootDir: 'x' } })).code === 'bad-repo', 'repositório com cloneDir vazio vira unreadable com código bad-repo')
  check(bad(JSON.stringify([1, 2])).code === 'not-object', 'raiz que não é objeto vira unreadable com código not-object')
  check(bad(JSON.stringify({ version: ARCHIVE_CONFIG_VERSION, repos: [] })).code === 'bad-repos', 'campo repos que não é objeto vira unreadable com código bad-repos')

  console.log('\n[3] gravar e reler')
  const fs1 = makeFakeFs()
  const w1 = await writeArchiveRepoConfig(HOME, 'ombrello/solar-docs', REPO_A, { fs: fs1 })
  check(w1.ok === true, 'gravar um repositório funciona')
  const r1 = await readArchiveConfig(HOME, { fs: fs1 })
  check(r1.state === 'ok', 'depois de gravar, a leitura dá estado ok')
  check(r1.state === 'ok' && r1.doc.repos['ombrello/solar-docs'].cloneDir === REPO_A.cloneDir, 'o caminho do clone volta igual ao gravado')
  check(r1.state === 'ok' && r1.doc.repos['ombrello/solar-docs'].rootDir === REPO_A.rootDir, 'a pasta-raiz volta igual à gravada')
  check([...fs1.files.keys()].join('|') === FILE, 'só o arquivo definitivo fica no disco (nenhum temporário sobra)')

  console.log('\n[4] gravar um segundo repositório não apaga o primeiro')
  const w2 = await writeArchiveRepoConfig(HOME, 'outro/repo', { cloneDir: '~/Work/outro', rootDir: 'docs' }, { fs: fs1 })
  check(w2.ok === true, 'gravar o segundo repositório funciona')
  const r2 = await readArchiveConfig(HOME, { fs: fs1 })
  check(r2.state === 'ok' && !!r2.doc.repos['ombrello/solar-docs'] && !!r2.doc.repos['outro/repo'], 'os dois repositórios convivem no arquivo')

  console.log('\n[5] arquivo que não dá para ler não é sobrescrito (nem por falha de leitura)')
  const broken = makeFakeFs({ [FILE]: '{ quebrado' })
  const wBroken = await writeArchiveRepoConfig(HOME, 'x/y', { cloneDir: '/a', rootDir: 'b' }, { fs: broken })
  check(wBroken.ok === false, 'gravar sobre conteúdo ilegível é recusado')
  check(broken.files.get(FILE) === '{ quebrado' && broken.writes.length === 0, 'o conteúdo ilegível continua intacto e nada foi escrito')
  // O caso do PR #136: a leitura falha com EACCES mas a pasta aceitaria a troca. Se a gravação seguisse
  // com um documento vazio, o rename daria certo e todos os repositórios já configurados sumiriam.
  const keepers = goodDoc({ 'a/b': { cloneDir: '/c', rootDir: 'd' }, 'e/f': { cloneDir: '/g', rootDir: 'h' } })
  for (const code of ['EACCES', 'EIO', 'EMFILE']) {
    const denied = makeFakeFs({ [FILE]: keepers }, { readFails: code })
    const wDenied = await writeArchiveRepoConfig(HOME, 'novo/repo', { cloneDir: '/i', rootDir: 'j' }, { fs: denied })
    check(wDenied.ok === false, 'falha de leitura ' + code + ' recusa a gravação')
    check(denied.files.get(FILE) === keepers && denied.writes.length === 0 && denied.renames.length === 0, 'com ' + code + ' o arquivo com os dois repositórios fica intacto e nem se tenta trocar')
  }
  const rDenied: any = await readArchiveConfig(HOME, { fs: makeFakeFs({ [FILE]: keepers }, { readFails: 'EACCES' }) })
  check(rDenied.state === 'unreadable' && rDenied.code === 'read-fail' && rDenied.errorCode === 'EACCES', 'a leitura com EACCES vira unreadable, código read-fail, com o código do sistema')

  console.log('\n[6] falha na troca não deixa lixo e não corrompe o original')
  const orig = goodDoc({ 'a/b': { cloneDir: '/c', rootDir: 'd' } })
  const failing = makeFakeFs({ [FILE]: orig }, { renameFails: 'ENOSPC' })
  const wFail = await writeArchiveRepoConfig(HOME, 'novo/repo', { cloneDir: '/e', rootDir: 'f' }, { fs: failing })
  check(wFail.ok === false, 'uma falha na troca é relatada, não engolida')
  check(failing.files.get(FILE) === orig, 'o arquivo original fica exatamente como estava')
  check([...failing.files.keys()].join('|') === FILE, 'o temporário é apagado depois da falha')

  console.log('\n[7] entrada inválida é recusada antes de tocar no disco')
  const fsNo = makeFakeFs()
  const wNo = await writeArchiveRepoConfig(HOME, 'x/y', { cloneDir: '', rootDir: 'z' }, { fs: fsNo })
  check(wNo.ok === false, 'cloneDir vazio é recusado')
  check(fsNo.files.size === 0, 'nada foi gravado no disco')
  const wHome = await writeArchiveRepoConfig('', 'x/y', { cloneDir: '/a', rootDir: 'b' }, { fs: fsNo })
  check(wHome.ok === false && fsNo.files.size === 0, 'sem pasta home a gravação é recusada sem tocar no disco')

  console.log('\n[8] gravações sobrepostas no mesmo arquivo')
  // O atraso nas leituras e escritas força as chamadas a se intercalarem. Sem a fila por arquivo, todas leem o
  // documento vazio e a última sobrescreve as outras; sem temporário próprio, elas ainda brigam pelo mesmo .tmp.
  const busy = makeFakeFs({}, { delayMs: 5 })
  const results = await Promise.all([
    writeArchiveRepoConfig(HOME, 'um/repo', { cloneDir: '/1', rootDir: 'a' }, { fs: busy }),
    writeArchiveRepoConfig(HOME, 'dois/repo', { cloneDir: '/2', rootDir: 'b' }, { fs: busy }),
    writeArchiveRepoConfig(HOME, 'tres/repo', { cloneDir: '/3', rootDir: 'c' }, { fs: busy }),
  ])
  check(results.every((r: any) => r.ok === true), 'as três gravações sobrepostas terminam com sucesso')
  const rBusy: any = await readArchiveConfig(HOME, { fs: busy })
  check(rBusy.state === 'ok' && Object.keys(rBusy.doc.repos).sort().join(',') === 'dois/repo,tres/repo,um/repo', 'o arquivo final tem os três repositórios, nenhum atualização se perdeu')
  check(new Set(busy.writes).size === 3, 'cada gravação usou o seu próprio arquivo temporário')
  check([...busy.files.keys()].join('|') === FILE, 'nenhum temporário sobrou depois das três')
  const failMid = makeFakeFs({}, { delayMs: 3 })
  const mixed = await Promise.all([
    writeArchiveRepoConfig(HOME, 'a/a', { cloneDir: '/1', rootDir: 'a' }, { fs: failMid }),
    writeArchiveRepoConfig('', 'b/b', { cloneDir: '/2', rootDir: 'b' }, { fs: failMid }),
    writeArchiveRepoConfig(HOME, 'c/c', { cloneDir: '/3', rootDir: 'c' }, { fs: failMid }),
  ])
  const rMixed: any = await readArchiveConfig(HOME, { fs: failMid })
  check(mixed[0].ok === true && mixed[1].ok === false && mixed[2].ok === true && rMixed.state === 'ok' && Object.keys(rMixed.doc.repos).length === 2, 'uma chamada inválida no meio da fila não impede as outras')

  console.log('\n[9] log na fronteira de persistência')
  // ausente e válido não fazem barulho
  const quiet = makeLog()
  await readArchiveConfig(HOME, { fs: makeFakeFs(), logCtx: quiet })
  await readArchiveConfig(HOME, { fs: makeFakeFs({ [FILE]: orig }), logCtx: quiet })
  check(quiet.events.length === 0, 'arquivo ausente e arquivo válido não geram nenhum evento')
  // sem log nenhum nada quebra
  const noLogWrite = await writeArchiveRepoConfig(HOME, 'x/y', REPO_A, { fs: makeFakeFs() })
  check(noLogWrite.ok === true, 'sem logCtx a gravação funciona normalmente')

  const logBadJson = makeLog()
  await readArchiveConfig(HOME, { fs: makeFakeFs({ [FILE]: '{ quebrado' }), logCtx: logBadJson })
  const badEvent = logBadJson.events[0]
  check(logBadJson.events.length === 1 && badEvent.event === 'archiveConfig.file.bad' && badEvent.level === 'warn', 'um arquivo com JSON quebrado deixa um aviso archiveConfig.file.bad')
  check(!!badEvent && keysOf(badEvent.fields) === 'errorCode,reason' && badEvent.fields.reason === 'not-json' && badEvent.fields.errorCode === '', 'o aviso só tem reason e errorCode (not-json, sem código de sistema)')

  const logEacces = makeLog()
  await readArchiveConfig(HOME, { fs: makeFakeFs({ [FILE]: orig }, { readFails: 'EACCES' }), logCtx: logEacces })
  check(logEacces.events.length === 1 && logEacces.events[0].fields.reason === 'read-fail' && logEacces.events[0].fields.errorCode === 'EACCES', 'a falha de leitura EACCES deixa reason read-fail e o código EACCES')

  const logFailWrite = makeLog()
  let clock = 100
  const tick = (): number => { const v = clock; clock += 30; return v }
  await writeArchiveRepoConfig(HOME, 'ombrello/solar-docs', REPO_A, { fs: makeFakeFs({}, { renameFails: 'ENOSPC' }), logCtx: logFailWrite, now: tick })
  const failEvent = logFailWrite.events.find((e) => e.event === 'archiveConfig.write.fail')
  check(!!failEvent && failEvent.level === 'warn', 'uma gravação que falha deixa um aviso archiveConfig.write.fail')
  check(!!failEvent && keysOf(failEvent.fields) === 'errorCode,latencyMs,reason,step', 'o aviso só tem step, reason, errorCode e latencyMs')
  check(!!failEvent && failEvent.fields.step === 'rename' && failEvent.fields.reason === 'io-fail' && failEvent.fields.errorCode === 'ENOSPC', 'o aviso diz em que passo parou (rename), o enum io-fail e o código ENOSPC')
  check(!!failEvent && failEvent.fields.latencyMs === 30, 'a duração vem do relógio injetado (30 ms)')

  const logRefused = makeLog()
  await writeArchiveRepoConfig(HOME, 'x/y', REPO_A, { fs: makeFakeFs({ [FILE]: '{ quebrado' }), logCtx: logRefused })
  const refusedEvents = logRefused.events.map((e) => e.event + ':' + (e.fields.step || e.fields.reason)).join('|')
  check(refusedEvents === 'archiveConfig.file.bad:not-json|archiveConfig.write.fail:read', 'gravar sobre arquivo ilegível deixa file.bad e depois write.fail no passo read')

  const logOkOff = makeLog()
  await writeArchiveRepoConfig(HOME, 'x/y', REPO_A, { fs: makeFakeFs(), logCtx: logOkOff })
  check(logOkOff.events.length === 0, 'gravação com sucesso e interruptor de depuração desligado não deixa evento')
  const logOkOn = makeLog({ debugOn: true })
  await writeArchiveRepoConfig(HOME, 'x/y', REPO_A, { fs: makeFakeFs(), logCtx: logOkOn })
  const okEvent = logOkOn.events[0]
  check(logOkOn.events.length === 1 && okEvent.event === 'archiveConfig.write' && okEvent.level === 'debug', 'com o interruptor ligado, o sucesso deixa um evento archiveConfig.write de depuração')
  check(!!okEvent && keysOf(okEvent.fields) === 'latencyMs,repoCount' && okEvent.fields.repoCount === 1, 'o evento de sucesso só tem repoCount e latencyMs')

  // nada sensível nos eventos: caminho do home, caminho do clone, nome do repositório, conteúdo do documento
  const everything = JSON.stringify([...logBadJson.events, ...logEacces.events, ...logFailWrite.events, ...logRefused.events, ...logOkOn.events])
  check(!everything.includes(HOME) && !everything.includes('ombrello') && !everything.includes('solar-docs') && !everything.includes('engenharia'), 'nenhum evento carrega caminho, nome de repositório ou conteúdo da configuração')
  const logPathy = makeLog()
  const pathyFs = makeFakeFs({}, { renameFails: '/tmp/fake-home/segredo' })
  await writeArchiveRepoConfig(HOME, 'x/y', REPO_A, { fs: pathyFs, logCtx: logPathy })
  const pathyEvent = logPathy.events.find((e) => e.event === 'archiveConfig.write.fail')
  check(!!pathyEvent && pathyEvent.fields.errorCode === '' && !JSON.stringify(logPathy.events).includes('segredo'), 'um "código" de erro que parece caminho é descartado e não chega ao log')

  // log que quebra não derruba nem muda o resultado
  const boom = makeLog({ explode: true })
  const okWithBoom = await writeArchiveRepoConfig(HOME, 'x/y', REPO_A, { fs: makeFakeFs(), logCtx: boom })
  check(okWithBoom.ok === true, 'um log que lança erro não faz uma gravação com sucesso falhar')
  const failWithBoom = await writeArchiveRepoConfig(HOME, 'x/y', REPO_A, { fs: makeFakeFs({}, { renameFails: 'ENOSPC' }), logCtx: boom })
  check(failWithBoom.ok === false, 'um log que lança erro não esconde uma falha de gravação')
  const readWithBoom: any = await readArchiveConfig(HOME, { fs: makeFakeFs({ [FILE]: '{ quebrado' }), logCtx: boom })
  check(readWithBoom.state === 'unreadable', 'um log que lança erro não muda o resultado de uma leitura')

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
