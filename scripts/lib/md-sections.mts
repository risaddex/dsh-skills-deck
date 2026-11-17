// scripts/lib/md-sections.mts —— Markdown que já existia não pode perder seções '## ' sem que isso seja declarado.
//
// Por que existe: reescrever um .md inteiro a partir de uma leitura parcial perde o fim do arquivo em silêncio,
// e nenhuma checagem de conteúdo percebe; só a contagem de seções cai. Medido em 2026-11-17 em docs/agents/:
// duas reescritas legítimas (tradução) mantiveram 13 cabeçalhos '## ' -> 13; a truncagem foi 13 -> 10.
//
// Critério (puro, sem git): a quantidade de cabeçalhos de nível 2 do texto novo não pode ser menor que a do antigo.
// Conta em vez de comparar nomes, porque traduzir ou renomear uma seção é legítimo e sumir não é.
//
// O que este critério NÃO pega, de propósito e documentado: esvaziar o corpo de uma seção, ou trocar uma seção por
// outra, mantém a contagem. O caso que motivou a gate (perder o fim do arquivo) é pego; perder miolo não é.
//
// Aproximação do CommonMark, não o CommonMark inteiro: conta só cabeçalhos ATX ('## texto') de topo, com até 3
// espaços de recuo, e entende cercas de código. Não entende título setext (texto sublinhado com '---'), comentário
// HTML que esconde cabeçalhos, nem cerca recuada dentro de item de lista. Medido em 2026-11-17: nenhum dos 648 .md
// versionados usa essas formas hoje, então nada fica vermelho por causa delas.
//
// Documento mal formado engana qualquer contador fiel ao CommonMark: package/bundled-skills/triage/OUT-OF-SCOPE.md
// mostra um exemplo de Markdown com uma cerca de 3 crases dentro de outra de 3 crases; pelo CommonMark a interna
// FECHA a externa e a cerca seguinte nunca fecha, então 4 das 7 seções do arquivo ficam dentro de um bloco aberto.
// A contagem (3) está certa para o CommonMark; o defeito é do documento. Cortá-lo não seria visto.
//
// Saída deliberada: remover uma seção de propósito continua possível, registrando o arquivo em
// docs/agents/md-section-removals.json com a contagem de antes e a de depois ({ path, from, sections }). O registro
// vale só para esse par exato: se o arquivo já não está em "from" (o corte foi commitado, ou o arquivo mudou
// depois), a entrada deixa de ser usada e a gate reprova por entrada vencida, forçando a limpeza.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type MarkdownPair = { path: string; before: string; after: string }
export type SectionLoss = { path: string; before: number; after: number }
export type DeclaredRemoval = { path: string; from: number; sections: number }

/** './a/b.md' e 'a/b.md' são o mesmo arquivo: o registro é escrito à mão e não pode depender desse detalhe. */
export function normalizePath(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}

/**
 * Conta cabeçalhos '## ' que o CommonMark reconhece: até 3 espaços de recuo, fora de blocos de código cercados.
 * Cerca: abre com 3 ou mais crases (ou til); só fecha com o MESMO caractere, comprimento igual ou maior e sem texto
 * depois. Assim um bloco de 4 crases que mostra uma cerca de 3 dentro continua aberto, e uma linha com info string
 * (```js) não fecha o bloco anterior.
 */
export function countSections(text: string): number {
  let open: { ch: string; len: number } | null = null
  let count = 0
  for (const line of String(text).split('\n')) {
    const stripped = line.replace(/\r$/, '')
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(stripped)
    if (fence) {
      const run = fence[1]
      if (open === null) {
        open = { ch: run[0], len: run.length }
      } else if (run[0] === open.ch && run.length >= open.len && fence[2].trim() === '') {
        open = null
      }
      continue
    }
    if (open === null && /^ {0,3}##(?:[ \t]+.*)?$/.test(stripped.replace(/^\uFEFF/, ''))) count += 1
  }
  return count
}

/** Os arquivos que perderam seções, com a contagem antes e depois. */
export function findLostSections(files: MarkdownPair[]): SectionLoss[] {
  return files
    .map(({ path, before, after }) => ({ path: normalizePath(path), before: countSections(before), after: countSections(after) }))
    .filter(({ before, after }) => after < before)
}

/**
 * As perdas que não estão declaradas. Uma declaração só vale para o par exato (from -> sections): um registro de
 * "8 -> 5" não libera um corte de 9 -> 5 nem de 8 -> 3, e não libera nada depois que o arquivo já está em 5.
 */
export function undeclaredLosses(losses: SectionLoss[], declared: DeclaredRemoval[]): SectionLoss[] {
  return losses.filter(
    ({ path, before, after }) =>
      !declared.some((entry) => normalizePath(entry.path) === path && entry.from === before && entry.sections === after),
  )
}

/**
 * Entradas do registro que não servem mais para nada. Uma entrada tem três estados, e só o último é erro:
 *   - em uso: casa com uma perda atual (o corte ainda não foi commitado);
 *   - consumida: não há perda atual e o arquivo, no HEAD, já está em "sections" (o corte foi commitado junto com a
 *     entrada). É o estado normal logo depois do commit e NÃO é erro: sem isso não existiria commit que passasse na
 *     gate, porque antes do commit a entrada é obrigatória e depois dele seria reprovada (achado da segunda revisão);
 *   - vencida: não há perda atual e o arquivo no HEAD NÃO está em "sections" (a entrada não descreve nada que exista:
 *     erro de digitação, ou o arquivo mudou de novo). Só esta é reportada.
 * Uma entrada consumida continua inofensiva: um corte posterior (de "sections" para menos) tem outro "from" e não
 * casa com ela. Limpá-la é boa higiene, mas não bloqueia ninguém.
 *
 * `sectionsAtHead` devolve quantas seções o arquivo tem no HEAD, ou null se o arquivo não existe lá.
 */
export function expiredRemovals(
  losses: SectionLoss[],
  declared: DeclaredRemoval[],
  sectionsAtHead: (path: string) => number | null = () => null,
): DeclaredRemoval[] {
  return declared.filter((entry) => {
    const inUse = losses.some(
      ({ path, before, after }) => normalizePath(entry.path) === path && entry.from === before && entry.sections === after,
    )
    if (inUse) return false
    return sectionsAtHead(normalizePath(entry.path)) !== entry.sections
  })
}

export function formatLosses(losses: SectionLoss[]): string[] {
  return losses.map(
    ({ path, before, after }) =>
      path + ': ' + before + ' -> ' + after + " cabeçalhos '## '. Causa comum: o arquivo foi regravado a partir de uma leitura parcial. " +
      'Compare com o HEAD (git diff --stat -- ' + path + ') e restaure a parte que sumiu; se a remoção é intencional, ' +
      'registre { "path": "' + path + '", "from": ' + before + ', "sections": ' + after + ' } em docs/agents/md-section-removals.json.',
  )
}

export function formatExpired(expired: DeclaredRemoval[]): string[] {
  return expired.map(
    (entry) =>
      entry.path + ': a entrada { from: ' + entry.from + ', sections: ' + entry.sections + ' } de docs/agents/md-section-removals.json ' +
      'não corresponde a nenhuma perda atual (o corte já foi commitado, ou o arquivo mudou). Apague a entrada.',
  )
}

/**
 * Os pares antes/depois que um commit levaria: o índice contra o HEAD e a árvore de trabalho contra o HEAD, com
 * renomes seguidos. Um arquivo é reprovado se QUALQUER das duas versões perde seções, porque o commit leva o
 * índice e a próxima gravação leva a árvore.
 *
 * O caminho antigo vem do HEAD, e o do índice pode já ser outro: `git mv a.md b.md` grava o renome no índice
 * (R100) e um corte feito depois fica só na árvore, onde o git, comparando com o HEAD, vê apagado + novo e não
 * acha par. Por isso o lado da árvore usa o caminho que o índice revelou: mapeia cada caminho novo do índice
 * para o seu caminho antigo no HEAD, e a árvore é comparada com esse original.
 *
 * Limite aceito: o par vem do detector de renome do git (limiar padrão de 50%). Renomear E cortar mais da metade
 * no MESMO git add aparece como apagado + novo e não tem par. Baixar o limiar não é solução: medido em
 * 2026-11-17, 10% pareia um arquivo apagado com um novo sem relação (26%), o que vira falso alarme para todos.
 */
export function readPairs(root: string): MarkdownPair[] {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const entries = (side: string[]): { status: string; oldPath: string; newPath: string }[] => {
    const out = git(['diff', ...side, '--name-status', '-M', '-z', 'HEAD', '--', ':(top,icase)*.md']).split('\0').filter(Boolean)
    const rows: { status: string; oldPath: string; newPath: string }[] = []
    for (let i = 0; i < out.length; ) {
      const status = out[i++]
      const oldPath = out[i++]
      const newPath = status.startsWith('R') || status.startsWith('C') ? out[i++] : oldPath
      rows.push({ status, oldPath, newPath })
    }
    return rows
  }
  const pairs: MarkdownPair[] = []
  const originalOf = new Map<string, string>() // caminho no índice -> caminho no HEAD
  for (const row of entries(['--cached'])) {
    if (!row.status.startsWith('M') && !row.status.startsWith('R')) continue
    originalOf.set(row.newPath, row.oldPath)
    try {
      pairs.push({ path: row.newPath, before: git(['show', 'HEAD:' + row.oldPath]), after: git(['show', ':' + row.newPath]) })
    } catch {
      /* some do caminho entre a listagem e a leitura: ignora */
    }
  }
  const seenWorktree = new Set<string>()
  for (const row of entries([])) {
    if (!row.status.startsWith('M') && !row.status.startsWith('R')) continue
    seenWorktree.add(row.newPath)
    try {
      pairs.push({ path: row.newPath, before: git(['show', 'HEAD:' + row.oldPath]), after: fs.readFileSync(path.join(root, row.newPath), 'utf8') })
    } catch {
      /* idem */
    }
  }
  // Renomeado no índice e depois editado na árvore: o git compara a árvore com o HEAD e não acha o par (D + A).
  // O índice sabe o original; compara a árvore com ele. Só entra o que o lado da árvore não cobriu sozinho.
  for (const [newPath, oldPath] of originalOf) {
    if (seenWorktree.has(newPath) || !fs.existsSync(path.join(root, newPath))) continue
    let after: string
    try {
      after = fs.readFileSync(path.join(root, newPath), 'utf8')
    } catch {
      continue
    }
    pairs.push({ path: newPath, before: git(['show', 'HEAD:' + oldPath]), after })
  }
  return pairs
}

/** Quantas seções o arquivo tem no HEAD; null quando o arquivo não existe lá (ou não há HEAD). */
export function sectionsAtHead(root: string, relPath: string): number | null {
  try {
    const text = execFileSync('git', ['show', 'HEAD:' + normalizePath(relPath)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return countSections(text)
  } catch {
    return null
  }
}
