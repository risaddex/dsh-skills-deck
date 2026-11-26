/**
 * src/host/archiveConfig.ts —— configuração local do arquivamento de specs (ticket #131)
 *
 * O que guarda: para cada repositório, o caminho local do clone de destino e a pasta-raiz
 * onde as specs fechadas são gravadas em Markdown antes de serem arquivadas no Linear.
 *
 * Por que fica fora do repositório: o arquivo docs/agents/workspace.yaml é versionado e
 * compartilhado com o time, e o próprio código proíbe caminhos e tokens nele
 * (cabeçalho de src/deck/rules/workspace-file.ts). Caminho de máquina pertence à máquina.
 *
 * Onde fica: <home>/.dsh/mattskillsdeck/archive-config.json, ao lado de choices.json e
 * linear-accounts.yaml (a mesma convenção, src/host/choiceStore.ts). Não criar outro caminho.
 *
 * Regras (as mesmas do choiceStore, mais a serialização):
 *  1. a escrita é atômica: grava um arquivo temporário e troca pelo definitivo; se cair
 *     no meio, o arquivo definitivo continua sendo o último completo;
 *  2. o arquivo é lido em três estados distintos: ausente (primeira vez, sem erro),
 *     ilegível (não usar e não sobrescrever às cegas) e válido. SÓ o estado "ausente" autoriza
 *     começar de um documento vazio. Qualquer ilegível, inclusive uma falha de leitura como
 *     EACCES ou EIO, recusa a gravação: gravar por cima de um arquivo que não conseguimos
 *     ler apagaria, sem aviso, todos os repositórios que já estavam configurados;
 *  3. a chave de cada repositório é o nome dele (por exemplo "owner/name"). O código aceita
 *     qualquer texto não vazio como chave; quem chama é que deve passar o nome do repositório;
 *  4. o ciclo inteiro de uma gravação (ler, alterar, gravar, trocar) é serializado por arquivo
 *     dentro deste processo, e cada gravação usa o seu próprio arquivo temporário. Sem isso,
 *     duas gravações sobrepostas leem o mesmo documento antigo e a última some com a primeira.
 *     A fila vale só dentro do processo: duas instâncias do DSH escrevendo ao mesmo tempo ainda
 *     podem perder uma atualização (o arquivo nunca fica corrompido, por causa da troca atômica
 *     e do temporário único, mas vale a última gravação). O choiceStore tem a mesma fronteira.
 *
 * Nada aqui confere se o clone existe. Isso acontece só na exportação (decisão do #131).
 *
 * Log (fronteira de persistência, ver AGENTS.md "Logging instrumentation discipline"): três
 * eventos, todos com o nome e os campos escritos como literais no ponto de chamada, porque o
 * gate tests/verify-log-fields.ts lê a forma do código. Nunca entram nos eventos o caminho do
 * clone, o nome do repositório nem o conteúdo do documento: só enumerações, números e códigos
 * curtos de erro do sistema (EACCES, ENOSPC).
 *   · archiveConfig.file.bad    (aviso, sempre grava): o arquivo existe mas não pôde ser usado;
 *   · archiveConfig.write.fail  (aviso, sempre grava): uma gravação não aconteceu, e em que passo;
 *   · archiveConfig.write       (depuração, só com o interruptor ligado): a gravação concluiu.
 */
// @ts-expect-error
import { randomUUID } from 'node:crypto'
// @ts-expect-error
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
// @ts-expect-error
import { join } from 'node:path'

/** Nome do arquivo e a pasta dele, relativos à pasta home. */
export const ARCHIVE_CONFIG_HOME_SEGMENT = '.dsh'
export const ARCHIVE_CONFIG_DIR_NAME = 'mattskillsdeck'
export const ARCHIVE_CONFIG_FILE_NAME = 'archive-config.json'
/** Versão do formato deste arquivo. Um número diferente é tratado como ilegível, nunca adivinhado. */
export const ARCHIVE_CONFIG_VERSION = 1

/** Configuração de um repositório. Os dois campos são obrigatórios para arquivar. */
export interface ArchiveRepoConfig {
  /** Caminho local do clone de destino, por exemplo ~/Work/Ombrello/ombrello-solar-docs. */
  cloneDir: string
  /** Pasta dentro do clone onde as specs são gravadas, por exemplo engenharia/specs-arquivadas. */
  rootDir: string
}

/** Arquivo inteiro: versão e um mapa de repositório ("owner/name") para a sua configuração. */
export interface ArchiveConfigDoc {
  version: typeof ARCHIVE_CONFIG_VERSION
  repos: Record<string, ArchiveRepoConfig>
}

/**
 * Por que um arquivo não pôde ser usado. É o único valor que vai para o log (campo `reason` de
 * archiveConfig.file.bad), por isso é uma enumeração fechada e não a mensagem para a pessoa.
 *   no-home      não há pasta home para guardar a configuração;
 *   read-fail    a leitura falhou por outro motivo que não "não existe" (EACCES, EIO...);
 *   not-json     o conteúdo não é JSON;
 *   bad-version  o número de versão não é o que este código entende;
 *   not-object   a raiz do JSON não é um objeto;
 *   bad-repos    o campo "repos" não é um objeto;
 *   bad-repo     algum repositório não tem cloneDir e rootDir preenchidos.
 */
export type ArchiveUnreadableCode = 'no-home' | 'read-fail' | 'not-json' | 'bad-version' | 'not-object' | 'bad-repos' | 'bad-repo'

/**
 * Resultado da leitura, em três estados distintos:
 *  - missing: o arquivo não existe (primeira configuração; não é erro);
 *  - unreadable: não pode ser usado. `code` é a enumeração para o log, `reason` a frase para a pessoa
 *    e `errorCode` o código curto do sistema quando a falha veio do disco (vazio nos demais casos);
 *  - ok: arquivo válido, com `doc` preenchido.
 */
export type ArchiveConfigRead =
  | { state: 'missing'; filePath: string }
  | { state: 'unreadable'; filePath: string; code: ArchiveUnreadableCode; reason: string; errorCode: string }
  | { state: 'ok'; filePath: string; doc: ArchiveConfigDoc }

/** Sistema de arquivos injetável. Em produção usa o node:fs; o teste troca por uma versão falsa. */
export interface ArchiveConfigFs {
  mkdir(dir: string, opts?: unknown): Promise<unknown>
  readFile(path: string, encoding?: unknown): Promise<unknown>
  rename(oldPath: string, newPath: string): Promise<unknown>
  unlink(path: string): Promise<unknown>
  writeFile(path: string, data: string, opts?: unknown): Promise<unknown>
}

/**
 * Saída de log: a mesma forma de LogCtx do choiceStore, repetida aqui de propósito. Importar o tipo
 * dele seria um import entre arquivos da mesma camada, que o repositório controla por lista.
 */
export interface ArchiveConfigLogCtx {
  fire(level: string, event: string, fields?: unknown): void
  isEnabled(level: string): boolean
}

/** Tudo que pode ser trocado de fora. Sem nada, usa o disco real, sem log e o relógio do sistema. */
export interface ArchiveConfigDeps {
  fs?: ArchiveConfigFs
  logCtx?: ArchiveConfigLogCtx | null
  now?: () => number
}

/** Em qual passo uma gravação parou (campo `step` de archiveConfig.write.fail). */
export type ArchiveWriteStep = 'read' | 'mkdir' | 'write-tmp' | 'rename'

const FS_DEFAULT: ArchiveConfigFs = { mkdir, readFile, rename, unlink, writeFile }

/**
 * Fila por arquivo. Cada entrada é o fim da cadeia de gravações em andamento para aquele caminho;
 * quando a cadeia esvazia a entrada sai do mapa, então o mapa não cresce com o tempo.
 */
const writeQueues = new Map<string, Promise<unknown>>()

/** Roda `task` depois de todas as gravações já enfileiradas para `key`, e devolve o resultado dela. */
function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) || Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  writeQueues.set(key, tail)
  void tail.then(() => { if (writeQueues.get(key) === tail) writeQueues.delete(key) })
  return run
}

/** Caminho completo do arquivo. Sem pasta home, devolve vazio (quem chama trata como "não há onde guardar"). */
export function archiveConfigFilePath(homeDir: unknown): string {
  if (!homeDir) return ''
  return join(String(homeDir), ARCHIVE_CONFIG_HOME_SEGMENT, ARCHIVE_CONFIG_DIR_NAME, ARCHIVE_CONFIG_FILE_NAME)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Código curto do sistema (EACCES, ENOSPC...) para o log. Só passa o que parece um código de verdade;
 * qualquer outra coisa, inclusive uma mensagem com caminho dentro, vira vazio e nunca chega ao disco.
 */
function systemErrorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : ''
}

/** Confere a forma de um repositório. Qualquer campo faltando ou vazio torna o repo inválido. */
function cleanRepo(raw: unknown): ArchiveRepoConfig | null {
  if (!isRecord(raw)) return null
  const cloneDir = typeof raw.cloneDir === 'string' ? raw.cloneDir.trim() : ''
  const rootDir = typeof raw.rootDir === 'string' ? raw.rootDir.trim() : ''
  if (!cloneDir || !rootDir) return null
  return { cloneDir, rootDir }
}

function unreadable(filePath: string, code: ArchiveUnreadableCode, reason: string, errorCode = ''): ArchiveConfigRead {
  return { state: 'unreadable', filePath, code, reason, errorCode }
}

/**
 * Lê o texto do arquivo e devolve o estado. Não toca o disco nem o log: recebe o texto já lido,
 * para poder ser testado sem arquivo.
 */
export function parseArchiveConfig(text: string, filePath: string): ArchiveConfigRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return unreadable(filePath, 'not-json', 'o arquivo não é JSON válido')
  }
  if (!isRecord(parsed)) return unreadable(filePath, 'not-object', 'a raiz do arquivo não é um objeto')
  if (parsed.version !== ARCHIVE_CONFIG_VERSION) {
    return unreadable(filePath, 'bad-version', 'versão ' + String(parsed.version) + ' não reconhecida (esperada ' + ARCHIVE_CONFIG_VERSION + ')')
  }
  if (!isRecord(parsed.repos)) return unreadable(filePath, 'bad-repos', 'o campo "repos" não é um objeto')
  const repos: Record<string, ArchiveRepoConfig> = {}
  for (const key of Object.keys(parsed.repos)) {
    const repo = cleanRepo(parsed.repos[key])
    if (!repo) return unreadable(filePath, 'bad-repo', 'o repositório "' + key + '" não tem cloneDir e rootDir preenchidos')
    repos[key] = repo
  }
  return { state: 'ok', filePath, doc: { version: ARCHIVE_CONFIG_VERSION, repos } }
}

/** Lê o arquivo de configuração do disco. Ausente é "missing", não erro. Um arquivo inutilizável deixa um aviso no log. */
export async function readArchiveConfig(homeDir: unknown, deps: ArchiveConfigDeps = {}): Promise<ArchiveConfigRead> {
  const fsPort = deps.fs || FS_DEFAULT
  const logCtx = deps.logCtx || null
  const filePath = archiveConfigFilePath(homeDir)

  /** Todo resultado inutilizável sai por aqui e deixa um aviso; ausente e válido passam sem log. */
  const logIfBad = (read: ArchiveConfigRead): ArchiveConfigRead => {
    if (read.state === 'unreadable') {
      const reasonCode = read.code
      const errorCode = read.errorCode
      try { if (logCtx && typeof logCtx.fire === 'function') logCtx.fire('warn', 'archiveConfig.file.bad', { reason: reasonCode, errorCode: errorCode }) } catch (eL) {}
    }
    return read
  }

  if (!filePath) return logIfBad(unreadable(filePath, 'no-home', 'não há pasta home para guardar a configuração'))
  let text: string
  try {
    text = String(await fsPort.readFile(filePath, 'utf8'))
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'ENOENT') return { state: 'missing', filePath }
    return logIfBad(unreadable(filePath, 'read-fail', 'não foi possível ler o arquivo (' + String((e as Error)?.message || e).slice(0, 120) + ')', systemErrorCode(e)))
  }
  return logIfBad(parseArchiveConfig(text, filePath))
}

/**
 * Grava a configuração de um repositório, preservando os outros. Escrita atômica:
 * grava em um arquivo temporário próprio ao lado e troca pelo definitivo.
 * Recusa gravar quando o arquivo não pôde ser usado, seja por conteúdo ruim ou por falha de leitura,
 * para não apagar dado que não conseguimos entender. Só um arquivo ausente começa do zero.
 * O ciclo inteiro roda numa fila por arquivo: duas chamadas sobrepostas acontecem uma depois da outra.
 */
export async function writeArchiveRepoConfig(
  homeDir: unknown,
  repoKey: string,
  repo: ArchiveRepoConfig,
  deps: ArchiveConfigDeps = {},
): Promise<{ ok: true; filePath: string } | { ok: false; reason: string }> {
  const key = String(repoKey || '').trim()
  if (!key) return { ok: false, reason: 'chave do repositório vazia' }
  const cleaned = cleanRepo(repo)
  if (!cleaned) return { ok: false, reason: 'cloneDir e rootDir são obrigatórios' }

  const filePath = archiveConfigFilePath(homeDir)
  const now = deps.now || Date.now
  const started = now()
  const logCtx = deps.logCtx || null

  /** Deixa o aviso de uma gravação que não aconteceu. `step` diz onde parou; só enumerações e números. */
  const logWriteFail = (step: ArchiveWriteStep, reasonCode: string, errorCode: string): void => {
    const latencyMs = Math.max(0, now() - started)
    try { if (logCtx && typeof logCtx.fire === 'function') logCtx.fire('warn', 'archiveConfig.write.fail', { step: step, reason: reasonCode, errorCode: errorCode, latencyMs: latencyMs }) } catch (eL) {}
  }

  if (!filePath) {
    logWriteFail('read', 'no-home', '')
    return { ok: false, reason: 'não há pasta home para guardar a configuração' }
  }

  return runExclusive(filePath, async () => {
    const fsPort = deps.fs || FS_DEFAULT
    const current = await readArchiveConfig(homeDir, deps)
    // Só "ausente" autoriza começar vazio. Todo ilegível recusa, inclusive falha de leitura:
    // se a leitura falhou mas a pasta aceita escrita, a troca abaixo teria dado certo e apagado
    // todos os repositórios que já estavam no arquivo.
    if (current.state === 'unreadable') {
      logWriteFail('read', current.code, current.errorCode)
      return { ok: false as const, reason: 'o arquivo de configuração não pôde ser usado (' + current.reason + '); corrija ou remova-o antes de gravar' }
    }

    const doc: ArchiveConfigDoc = current.state === 'ok' ? current.doc : { version: ARCHIVE_CONFIG_VERSION, repos: {} }
    doc.repos[key] = cleaned

    const dir = join(String(homeDir), ARCHIVE_CONFIG_HOME_SEGMENT, ARCHIVE_CONFIG_DIR_NAME)
    // Um temporário por gravação: dois escritores independentes nunca disputam o mesmo arquivo.
    const tmp = filePath + '.' + randomUUID() + '.tmp'
    let step: ArchiveWriteStep = 'mkdir'
    try {
      await fsPort.mkdir(dir, { recursive: true })
      step = 'write-tmp'
      await fsPort.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      step = 'rename'
      await fsPort.rename(tmp, filePath)
    } catch (e) {
      try { await fsPort.unlink(tmp) } catch (_) { /* o temporário pode nem ter sido criado */ }
      logWriteFail(step, 'io-fail', systemErrorCode(e))
      return { ok: false as const, reason: 'falha ao gravar a configuração (' + String((e as Error)?.message || e).slice(0, 120) + ')' }
    }
    const repoCount = Object.keys(doc.repos).length
    const latencyMs = Math.max(0, now() - started)
    try { if (logCtx && logCtx.isEnabled('debug')) logCtx.fire('debug', 'archiveConfig.write', { repoCount: repoCount, latencyMs: latencyMs }) } catch (eL) {}
    return { ok: true as const, filePath }
  })
}
