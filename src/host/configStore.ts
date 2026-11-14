/**
 * src/host/configStore.ts（来源：src/host/configStore.js，#1012；本次只加类型标注与注释，逻辑一行未动）。
 */
 // src/host/configStore.js —— 配置文件的宿主适配器：调核的唯一入口（#1012）
//
// 人话：三份配置文件要读要写都走这里。它只做核不会做的事：
// 文本出入口（parseConfig / stringifyConfig，超大与别名守卫在此做一次）、
// 拼路径、读文件、写文件、写完读回比对、写成功后删老文件。
// 三份 schema 的校验与模板住在核单元里（src/shared/config-store/），这里不重写。
//
// 冻结接口（与 #1003 票里那份逐字一致；要改必须同时改两份）：
//   parseConfig(text, schema) / stringifyConfig(value, schema)（文本出入口）
//   readWorkspaceConfig(root, io) / writeWorkspaceConfig(root, value, io)
//   readLocalSettings(homeDir, io) / writeLocalSettings(value, homeDir, io)
//   readLabelColors(root, io) / writeLabelColors(root, value, io)
// io 是文件读写口 { readText, writeText, rm, mkdir }，由调用方递进来
// （桌面端走平台文件服务；测试给假实现）。新老并存以新为准，写成功后删老文件
// （删不掉只警告）；迁移事实经回执字段带出来，不新增日志事件（单写者文件本票不动）。
// 以后谁改它：改读写顺序、迁移时机、失败说法的人。判定归 #1003 的判定服务。
import { parse as parseYaml } from 'yaml'
import { parseLabelColors, stringifyLabelColors, LABEL_COLORS_JSON_REL, LABEL_COLORS_YAML_REL } from '../shared/config-store/src/labels.js'
import { parseSettings, stringifySettings, SETTINGS_REL_SEGMENTS } from '../shared/config-store/src/settings.js'
import { parseWorkspace, stringifyWorkspace, WORKSPACE_JSON_REL, WORKSPACE_YAML_REL } from '../shared/config-store/src/workspace.js'
// 布局取值的唯一真源（#1342）：核不自己留字面量，由调用方把名单传进去。
import { DOC_LAYOUT_VALUES } from '../shared/doc-layout/src/layouts.js'

// ── 路径（只拼字符串，不碰文件系统） ──

/** 工作区根 + 相对路径 → 读写口要的绝对路径。根末尾的斜杠先清掉，剩下的原样拼。 */
function joinRoot(root: any, rel: any): string {
  return String(root || '').replace(/[\\/]+$/, '') + '/' + String(rel || '')
}

/** 用户主目录 → 本机设置文件的绝对路径。 */
function settingsPath(homeDir: any): string {
  return String(homeDir || '').replace(/[\\/]+$/, '') + '/' + SETTINGS_REL_SEGMENTS.join('/')
}

/** 这次读到的上一级目录（写之前建它，免得目录不在写失败）。 */
function parentDir(absPath: any): string {
  const s: string = String(absPath || '')
  const i: number = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i > 0 ? s.slice(0, i) : ''
}

// ── 错误分类 ──

/** 「文件确实不在」的判据：只有它才允许按「还没有这份文件」处理。
 * 判据故意定得窄（照标签配色房间同一套）：权限、被占用、位置被换成目录都不能证明文件不存在，
 * 照「没有」处理会用默认内容把用户手写的东西整份覆盖，那是真实的数据丢失。 */
function isMissingFile(e: any): boolean {
  const code: string = String((e && (e.code || (e.cause && e.cause.code))) || '')
  if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return true
  const msg: string = String((e && e.message) || e || '')
  return /ENOENT|FS_NOT_FOUND/i.test(msg) || /cannot read .*: not found/i.test(msg)
}

function needIo(io: any): void {
  if (!io || typeof io.readText !== 'function' || typeof io.writeText !== 'function') {
    throw new Error('configStore: pass a file IO port with at least readText and writeText; tests may use a fake implementation')
  }
}

/** 回执里只放相对路径，不放绝对路径、不放令牌（日志纪律：工作区原始路径不记原文）。 */
function envFail(what: any, rel: any, detail: any): any {
  return {
    ok: false,
    reason: 'env',
    message: what + ' (' + rel + '). ' + detail,
  }
}

// ── 文本出入口（parseConfig / stringifyConfig，冻结名） ──
// 核按文件拆成三个单元（产物各自独立、零相对引用），入口只留这一处：
// 字符数与别名两道守卫在此做一次，YAML 解析（钉死 core 模式）一次，再交对应单元校验。
// 上限数字的唯一出处就是这里（门禁从行为上钉住这两个数）。

/** 文件字符数上限：配置文件本该很小，64K 字绰绰有余，超了说明拿错了文件。
 * 按字数不按字节（中文一字多字节也照一字算，反正超了就是拿错文件）。 */
const MAX_FILE_CHARS: number = 65536
/** 别名（`*名字`）数量上限：正常配置文件里一个别名都不会有，50 是宽松的哨兵。 */
const MAX_ALIASES: number = 50

/** 数一数文本里用了多少个别名。注释里的不算，先去掉行注释。 */
function countAliases(text: any): number {
  const noComments: string = String(text).replace(/(^|\s)#[^\n]*$/gm, '$1')
  const hits: RegExpMatchArray | null = noComments.match(/(^|[\s\[{,])\*[A-Za-z0-9_-]+/g)
  return hits ? hits.length : 0
}

/**
 * 解析一份配置文本。schema 三选一：workspace（工作区后端配置）、
 * settings（本机全局设置）、label-colors（标签配色数据）。
 * 老的 `.json` 是 YAML 的子集，直接可读，不用区分。
 */
export function parseConfig(text: any, schema: any): any {
  if (schema !== 'workspace' && schema !== 'settings' && schema !== 'label-colors') {
    return { ok: false, reason: 'bad-shape', message: 'The core does not recognise this schema: ' + String(schema) }
  }
  if (typeof text !== 'string') return { ok: false, reason: 'bad-shape', message: 'The input to parse is not text' }
  const stripped: string = text.replace(/^\uFEFF/, '')
  if (stripped.length > MAX_FILE_CHARS) {
    return { ok: false, reason: 'oversize', message: 'This file is too large (' + stripped.length + ' characters; limit: ' + MAX_FILE_CHARS + ' characters). The core refuses to parse it: configuration files should be small; this may be the wrong file' }
  }
  if (countAliases(stripped) > MAX_ALIASES) {
    return { ok: false, reason: 'aliases', message: 'This file has too many aliases (`*name`); limit: ' + MAX_ALIASES + '. The core refuses to parse it: normal configuration files do not need aliases' }
  }
  let doc: any = null
  try {
    doc = parseYaml(stripped, { schema: 'core', maxAliasCount: MAX_ALIASES, uniqueKeys: true })
  } catch (e: any) {
    const msg: string = String((e && e.message) || e || '')
    if (/alias/i.test(msg)) return { ok: false, reason: 'aliases', message: 'This file has too many aliases. The core refuses to parse it: normal configuration files do not need aliases' }
    return { ok: false, reason: 'yaml-error', message: 'This file is not valid YAML (nor legacy JSON): ' + msg.slice(0, 160) }
  }
  if (doc === undefined || doc === null || (typeof doc === 'string' && doc.trim() === '')) {
    return { ok: false, reason: 'bad-shape', message: 'This file is empty' }
  }
  if (schema === 'workspace') return parseWorkspace(doc, DOC_LAYOUT_VALUES)
  if (schema === 'settings') return parseSettings(doc)
  return parseLabelColors(doc)
}

/** 把一份值拼成要落盘的文本（含程序生成的注释）。字段定义与注释文字都在各单元一处。 */
export function stringifyConfig(value: any, schema: any): any {
  if (schema === 'workspace') return stringifyWorkspace(value, DOC_LAYOUT_VALUES)
  if (schema === 'settings') return stringifySettings(value)
  if (schema === 'label-colors') return stringifyLabelColors(value)
  return { ok: false, reason: 'bad-shape', message: 'The core does not recognise this schema: ' + String(schema) }
}

// ── 读写的公共骨架（新优先、老兼容） ──

/** 读一份文件：先读新的 .yaml，只有「确实不在」才读老 .json；新在但读坏了，老好的话照用并警告。 */
async function readWithFallback(io: any, yamlAbs: any, yamlRel: any, jsonAbs: any, jsonRel: any, schemaId: any, missingMessage: any): Promise<any> {
  let yamlText: string | null = null
  let yamlError: any = null
  try {
    yamlText = await io.readText(yamlAbs)
  } catch (e: any) {
    if (!isMissingFile(e)) yamlError = e
  }
  if (typeof yamlText === 'string') {
    const parsed: any = parseConfig(yamlText, schemaId)
    if (parsed.ok) {
      let legacyPresent: boolean = false
      try {
        await io.readText(jsonAbs)
        legacyPresent = true
      } catch (e) {
        legacyPresent = false
      }
      const warnings: any[] = [...(parsed.warnings || [])]
      if (legacyPresent) warnings.push('legacy-present: the old file (' + jsonRel + ') still exists; the new file (' + yamlRel + ') takes precedence. The old file is a migration leftover')
      return { ok: true, value: parsed.value, from: 'yaml', readonly: parsed.readonly === true, legacyPresent, warnings }
    }
    // 新文件在但读坏了：看看老文件能不能救，不能才报错。
    if (yamlError === null) {
      try {
        const jsonText: any = await io.readText(jsonAbs)
        const fallback: any = parseConfig(jsonText, schemaId)
        if (fallback.ok) {
          return {
            ok: true,
            value: fallback.value,
            from: 'json',
            readonly: fallback.readonly === true,
            legacyPresent: false,
            warnings: ['yaml-unreadable: the new file (' + yamlRel + ') could not be read (' + parsed.message.slice(0, 80) + '); using the old file (' + jsonRel + ') for now. Please check the new file'],
          }
        }
      } catch (e2) {
        // 老文件也不在或也坏，下面按新文件的错回。
      }
      return { ok: false, reason: parsed.reason, message: parsed.message, from: 'yaml', warnings: [] }
    }
    return { ok: false, reason: parsed.reason, message: parsed.message, from: 'yaml', warnings: [] }
  }
  if (yamlError !== null) {
    return envFail('Failed to read this file', yamlRel, 'The current account may lack read permission, or another program may be using the file; the plugin cannot tell which. Check and retry. Original error: ' + String((yamlError && yamlError.message) || yamlError).slice(0, 120))
  }
  // 新文件确实不在：读老文件。
  let jsonText: string | null = null
  try {
    jsonText = await io.readText(jsonAbs)
  } catch (e: any) {
    if (isMissingFile(e)) return { ok: false, reason: 'missing', message: missingMessage, from: 'none', warnings: [] }
    return envFail('Failed to read this file', jsonRel, 'The current account may lack read permission, or another program may be using the file. Check and retry. Original error: ' + String((e && e.message) || e).slice(0, 120))
  }
  const parsed: any = parseConfig(jsonText, schemaId)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message, from: 'json', warnings: [] }
  return { ok: true, value: parsed.value, from: 'json', readonly: parsed.readonly === true, legacyPresent: false, warnings: [] }
}

/** 写一份文件：拼文本 → 建目录 → 写新文件 → 读回比对 → 顺手删老文件（删不掉只警告）。 */
async function writeWithCleanup(io: any, yamlAbs: any, yamlRel: any, jsonAbs: any, jsonRel: any, schemaId: any, value: any): Promise<any> {
  const made: any = stringifyConfig(value, schemaId)
  if (!made.ok) return { ok: false, reason: made.reason, message: made.message, keys: made.keys, warnings: [] }
  const text: any = made.text
  try {
    if (typeof io.mkdir === 'function') {
      try {
        await io.mkdir(parentDir(yamlAbs))
      } catch (eM) {
        // 建目录失败不单独报错，写文件那一步会给出真正的失败原因。
      }
    }
    await io.writeText(yamlAbs, text)
    const back: any = await io.readText(yamlAbs)
    if (String(back) !== text) {
      return envFail('Save failed: reading the file back returned content different from what was just written', yamlRel, 'The save cannot be confirmed. Open the file, check its content, edit it to the intended value, and retry.')
    }
  } catch (e: any) {
    return envFail('Save failed: could not write this file', yamlRel, 'Check that its parent directory exists and the current account can write to it, then retry. Original error: ' + String((e && e.message) || e).slice(0, 120))
  }
  let legacyDeleted: boolean = false
  const warnings: string[] = []
  if (typeof io.rm === 'function') {
    try {
      await io.rm(jsonAbs)
      legacyDeleted = true
    } catch (e: any) {
      if (!isMissingFile(e)) {
        warnings.push('legacy-delete-failed: the old file (' + jsonRel + ') could not be deleted. It is no longer used and can be removed manually. Original error: ' + String((e && e.message) || e).slice(0, 80))
      } else {
        legacyDeleted = true
      }
    }
  }
  return { ok: true, from: 'yaml', legacyDeleted, warnings }
}

// ── 冻结接口（六个，与 #1003 票里那份逐字一致） ──

/**
 * 读工作区后端配置。新老并存时以新为准；只有老文件时照读（调用方决定何时迁移）；
 * 两个都没有时回 missing（界面说「这条工作区还没选后端，请选一次」）。
 */
export async function readWorkspaceConfig(root: any, io: any): Promise<any> {
  needIo(io)
  return readWithFallback(
    io,
    joinRoot(root, WORKSPACE_YAML_REL),
    WORKSPACE_YAML_REL,
    joinRoot(root, WORKSPACE_JSON_REL),
    WORKSPACE_JSON_REL,
    'workspace',
    'This workspace has not selected a backend (the workspace file ' + WORKSPACE_YAML_REL + ' is missing). Select a backend in the panel.',
  )
}

/** 写工作区后端配置：只写新文件，写成功后顺手删老文件（删不掉只警告）。 */
export async function writeWorkspaceConfig(root: any, value: any, io: any): Promise<any> {
  needIo(io)
  return writeWithCleanup(
    io,
    joinRoot(root, WORKSPACE_YAML_REL),
    WORKSPACE_YAML_REL,
    joinRoot(root, WORKSPACE_JSON_REL),
    WORKSPACE_JSON_REL,
    'workspace',
    value,
  )
}

/** 读本机全局设置。文件不在就是 missing（调用方用默认值或引导，不算错）。 */
export async function readLocalSettings(homeDir: any, io: any): Promise<any> {
  needIo(io)
  const abs: any = settingsPath(homeDir)
  const rel: any = SETTINGS_REL_SEGMENTS.join('/')
  let text: string | null = null
  try {
    text = await io.readText(abs)
  } catch (e: any) {
    if (isMissingFile(e)) return { ok: false, reason: 'missing', message: 'The local settings file (' + rel + ') does not exist yet; it will be created on the first save.', from: 'none', warnings: [] }
    return envFail('Failed to read this file', rel, 'The current account may lack read permission, or another program may be using the file. Check and retry. Original error: ' + String((e && e.message) || e).slice(0, 120))
  }
  const parsed: any = parseConfig(text, 'settings')
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message, from: 'yaml', warnings: [] }
  return { ok: true, value: parsed.value, from: 'yaml', readonly: parsed.readonly === true, legacyPresent: false, warnings: [...(parsed.warnings || [])] }
}

/** 写本机全局设置（整份覆盖，原子性由调用方的读写口保证：一次调用写完整份内容）。 */
export async function writeLocalSettings(value: any, homeDir: any, io: any): Promise<any> {
  needIo(io)
  const abs: any = settingsPath(homeDir)
  const rel: any = SETTINGS_REL_SEGMENTS.join('/')
  const made: any = stringifyConfig(value, 'settings')
  if (!made.ok) return { ok: false, reason: made.reason, message: made.message, keys: made.keys, warnings: [] }
  try {
    if (typeof io.mkdir === 'function') {
      try {
        await io.mkdir(parentDir(abs))
      } catch (eM) {
        // 建目录失败不单独报错，写文件那一步会给出真正的失败原因。
      }
    }
    await io.writeText(abs, made.text)
    const back: any = await io.readText(abs)
    if (String(back) !== made.text) {
      return envFail('Save failed: reading the file back returned content different from what was just written', rel, 'The save cannot be confirmed. Open the file, check its content, and retry.')
    }
  } catch (e: any) {
    return envFail('Save failed: could not write this file', rel, 'Check that its parent directory exists and the current account can write to it, then retry. Original error: ' + String((e && e.message) || e).slice(0, 120))
  }
  return { ok: true, from: 'yaml', legacyDeleted: true, warnings: [] }
}

/** 读标签配色数据。新老并存时以新为准；只有老文件时照读；都没有时回 missing（调用方放置默认）。 */
export async function readLabelColors(root: any, io: any): Promise<any> {
  needIo(io)
  return readWithFallback(
    io,
    joinRoot(root, LABEL_COLORS_YAML_REL),
    LABEL_COLORS_YAML_REL,
    joinRoot(root, LABEL_COLORS_JSON_REL),
    LABEL_COLORS_JSON_REL,
    'label-colors',
    'The workspace label-colour file (' + LABEL_COLORS_YAML_REL + ') does not exist yet; opening the colour dialog for the first time will create it with the default colours.',
  )
}

/** 写标签配色数据：只写新文件，写成功后顺手删老文件（删不掉只警告）。版本号固定写 1。 */
export async function writeLabelColors(root: any, value: any, io: any): Promise<any> {
  needIo(io)
  return writeWithCleanup(
    io,
    joinRoot(root, LABEL_COLORS_YAML_REL),
    LABEL_COLORS_YAML_REL,
    joinRoot(root, LABEL_COLORS_JSON_REL),
    LABEL_COLORS_JSON_REL,
    'label-colors',
    value,
  )
}

export default { parseConfig, stringifyConfig, readWorkspaceConfig, writeWorkspaceConfig, readLocalSettings, writeLocalSettings, readLabelColors, writeLabelColors }
