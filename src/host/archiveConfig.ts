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
 * Três regras (as mesmas do choiceStore):
 *  1. a escrita é atômica: grava um arquivo temporário e troca pelo definitivo; se cair
 *     no meio, o arquivo definitivo continua sendo o último completo;
 *  2. o arquivo é lido em três estados distintos: ausente (primeira vez, sem erro),
 *     ilegível (não usar e não sobrescrever às cegas) e válido;
 *  3. a chave de cada repositório é o nome dele (por exemplo "owner/name"). O código aceita
 *     qualquer texto não vazio como chave; quem chama é que deve passar o nome do repositório.
 *
 * Nada aqui confere se o clone existe. Isso acontece só na exportação (decisão do #131).
 */
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
 * Resultado da leitura, em três estados distintos:
 *  - missing: o arquivo não existe (primeira configuração; não é erro);
 *  - unreadable: existe mas não pode ser usado (JSON quebrado, versão diferente, forma errada);
 *  - ok: arquivo válido, com `doc` preenchido.
 */
export type ArchiveConfigRead =
  | { state: 'missing'; filePath: string }
  | { state: 'unreadable'; filePath: string; reason: string }
  | { state: 'ok'; filePath: string; doc: ArchiveConfigDoc }

/** Dependências injetáveis. Em produção usa o node:fs; o teste troca por uma pasta temporária. */
export interface ArchiveConfigFs {
  mkdir(dir: string, opts?: unknown): Promise<unknown>
  readFile(path: string, encoding?: unknown): Promise<unknown>
  rename(oldPath: string, newPath: string): Promise<unknown>
  unlink(path: string): Promise<unknown>
  writeFile(path: string, data: string, opts?: unknown): Promise<unknown>
}

const FS_DEFAULT: ArchiveConfigFs = { mkdir, readFile, rename, unlink, writeFile }

/** Caminho completo do arquivo. Sem pasta home, devolve vazio (quem chama trata como "não há onde guardar"). */
export function archiveConfigFilePath(homeDir: unknown): string {
  if (!homeDir) return ''
  return join(String(homeDir), ARCHIVE_CONFIG_HOME_SEGMENT, ARCHIVE_CONFIG_DIR_NAME, ARCHIVE_CONFIG_FILE_NAME)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Confere a forma de um repositório. Qualquer campo faltando ou vazio torna o repo inválido. */
function cleanRepo(raw: unknown): ArchiveRepoConfig | null {
  if (!isRecord(raw)) return null
  const cloneDir = typeof raw.cloneDir === 'string' ? raw.cloneDir.trim() : ''
  const rootDir = typeof raw.rootDir === 'string' ? raw.rootDir.trim() : ''
  if (!cloneDir || !rootDir) return null
  return { cloneDir, rootDir }
}

/**
 * Lê o texto do arquivo e devolve o estado. Não toca o disco: recebe o texto já lido,
 * para poder ser testado sem arquivo.
 */
export function parseArchiveConfig(text: string, filePath: string): ArchiveConfigRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { state: 'unreadable', filePath, reason: 'o arquivo não é JSON válido' }
  }
  if (!isRecord(parsed)) return { state: 'unreadable', filePath, reason: 'a raiz do arquivo não é um objeto' }
  if (parsed.version !== ARCHIVE_CONFIG_VERSION) {
    return { state: 'unreadable', filePath, reason: 'versão ' + String(parsed.version) + ' não reconhecida (esperada ' + ARCHIVE_CONFIG_VERSION + ')' }
  }
  if (!isRecord(parsed.repos)) return { state: 'unreadable', filePath, reason: 'o campo "repos" não é um objeto' }
  const repos: Record<string, ArchiveRepoConfig> = {}
  for (const key of Object.keys(parsed.repos)) {
    const repo = cleanRepo(parsed.repos[key])
    if (!repo) return { state: 'unreadable', filePath, reason: 'o repositório "' + key + '" não tem cloneDir e rootDir preenchidos' }
    repos[key] = repo
  }
  return { state: 'ok', filePath, doc: { version: ARCHIVE_CONFIG_VERSION, repos } }
}

/** Lê o arquivo de configuração do disco. Ausente é "missing", não erro. */
export async function readArchiveConfig(homeDir: unknown, fsPort: ArchiveConfigFs = FS_DEFAULT): Promise<ArchiveConfigRead> {
  const filePath = archiveConfigFilePath(homeDir)
  if (!filePath) return { state: 'unreadable', filePath, reason: 'não há pasta home para guardar a configuração' }
  let text: string
  try {
    text = String(await fsPort.readFile(filePath, 'utf8'))
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    if (code === 'ENOENT') return { state: 'missing', filePath }
    return { state: 'unreadable', filePath, reason: 'não foi possível ler o arquivo (' + String((e as Error)?.message || e).slice(0, 120) + ')' }
  }
  return parseArchiveConfig(text, filePath)
}

/**
 * Grava a configuração de um repositório, preservando os outros. Escrita atômica:
 * grava em um arquivo temporário ao lado e troca pelo definitivo.
 * Recusa gravar sobre um arquivo ilegível, para não apagar dado que não entendemos.
 */
export async function writeArchiveRepoConfig(
  homeDir: unknown,
  repoKey: string,
  repo: ArchiveRepoConfig,
  fsPort: ArchiveConfigFs = FS_DEFAULT,
): Promise<{ ok: true; filePath: string } | { ok: false; reason: string }> {
  const key = String(repoKey || '').trim()
  if (!key) return { ok: false, reason: 'chave do repositório vazia' }
  const cleaned = cleanRepo(repo)
  if (!cleaned) return { ok: false, reason: 'cloneDir e rootDir são obrigatórios' }

  const current = await readArchiveConfig(homeDir, fsPort)
  if (current.state === 'unreadable' && current.reason.indexOf('não há pasta home') === 0) {
    return { ok: false, reason: current.reason }
  }
  if (current.state === 'unreadable' && current.reason.indexOf('não foi possível ler') !== 0) {
    return { ok: false, reason: 'o arquivo existe mas não pode ser usado (' + current.reason + '); corrija ou remova-o antes de gravar' }
  }

  const doc: ArchiveConfigDoc = current.state === 'ok' ? current.doc : { version: ARCHIVE_CONFIG_VERSION, repos: {} }
  doc.repos[key] = cleaned

  const filePath = current.filePath
  const dir = join(String(homeDir), ARCHIVE_CONFIG_HOME_SEGMENT, ARCHIVE_CONFIG_DIR_NAME)
  const tmp = filePath + '.tmp'
  try {
    await fsPort.mkdir(dir, { recursive: true })
    await fsPort.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    await fsPort.rename(tmp, filePath)
  } catch (e) {
    try { await fsPort.unlink(tmp) } catch (_) { /* o temporário pode nem ter sido criado */ }
    return { ok: false, reason: 'falha ao gravar a configuração (' + String((e as Error)?.message || e).slice(0, 120) + ')' }
  }
  return { ok: true, filePath }
}
