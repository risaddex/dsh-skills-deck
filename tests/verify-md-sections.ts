// tests/verify-md-sections.ts —— Markdown que já existia não pode perder seções '## ' sem declarar.
//
// Por que existe: em 2026-11-17 uma reescrita de docs/agents/real-machine-verification.md perdeu o fim do
// arquivo (13 -> 10 seções) por ter sido regravada a partir de uma leitura parcial, e a cadeia só reclamou
// porque uma gate de outro assunto casava uma palavra daquele trecho. Esta gate olha a causa: a contagem.
//
// Quatro partes: (1) o critério com os números reais medidos, (2) o critério nos casos de borda, (3) o git de
// verdade num repositório temporário (rename, .MD, só no índice, só na árvore), (4) a árvore deste repositório
// contra o HEAD. A parte 4 é o que protege; as outras provam que ela não é muda.
// 门禁归属: scripts/lib/md-sections.mts
// 门禁归属: docs/agents/md-section-removals.json
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  countSections, expiredRemovals, findLostSections, formatExpired, formatLosses, normalizePath, readPairs, sectionsAtHead, undeclaredLosses,
  type DeclaredRemoval,
} from '../scripts/lib/md-sections.mts'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-md-sections'
let assertions = 0
let failed = 0
function check(ok: boolean, message: string, detail = ''): void {
  assertions++
  if (ok) {
    console.log('  PASS ' + message)
    return
  }
  failed++
  console.log('  FAIL ' + message + (detail === '' ? '' : '：' + detail))
}

const FENCE = String.fromCharCode(96).repeat(3)
const FENCE4 = String.fromCharCode(96).repeat(4)
const doc = (...headings: string[]): string => '# T\n\n' + headings.map((h) => '## ' + h + '\n\ntexto\n').join('\n')

console.log('== 1. critério: os números reais de 2026-11-17 ==')
check(findLostSections([{ path: 'a.md', before: doc('场景总览', '批次记录'), after: doc('Scenario overview', 'Batch records') }]).length === 0,
  'traduzir/renomear seções (13 -> 13 no caso real) não é perda')
check(findLostSections([{ path: 'a.md', before: doc('a', 'b', 'c', 'd'), after: doc('a', 'b') }]).length === 1,
  'cortar o fim do arquivo (13 -> 10 no caso real) é perda')

console.log('== 2. critério: bordas ==')
check(countSections('## a\n' + FENCE + 'md\n## falso\n' + FENCE + '\n## b\n') === 2, 'cabeçalho dentro de bloco cercado não conta')
check(countSections('## a\n~~~\n## falso\n~~~\n## b\n') === 2, 'cerca com ~~~ também isola')
check(countSections('## a\n' + FENCE + '\n~~~\n## falso\n' + FENCE + '\n## b\n') === 2, 'uma cerca de outro tipo dentro da primeira não a fecha')
check(countSections(FENCE4 + '\n' + FENCE + '\n## falso\n' + FENCE + '\n' + FENCE4 + '\n## real\n') === 1, 'bloco de 4 crases que mostra uma cerca de 3 dentro continua aberto')
check(countSections(FENCE + '\n' + FENCE + 'js\n## falso\n' + FENCE + '\n## real\n## b\n') === 2, 'uma linha com info string não fecha a cerca anterior')
check(countSections(' ## a\n   ## b\n    ## c\n') === 2, 'recuo de até 3 espaços é cabeçalho; 4 espaços é bloco de código')
check(countSections('## a\r\n## b\r\n') === 2, 'CRLF conta igual')
check(countSections('### sub\n#### sub2\n#\tx\n##sem-espaço\n') === 0, 'só conta "## " de nível 2 com texto')
check(countSections('##\tTitulo\n##  Titulo\n##\n##   \n') === 4, "'##' seguido de tab, de espaço duplo, vazio ou só espaços também é cabeçalho (CommonMark)")
check(countSections('\uFEFF## a\n## b\n') === 2, 'BOM antes do primeiro cabeçalho não o esconde')
check(findLostSections([{ path: 'a.md', before: '## A\n## B\n', after: '##\tA\n##\tB\n' }]).length === 0, 'trocar o espaço por tab depois de ## não é perda (era falso alarme)')
check(countSections('') === 0, 'texto vazio tem 0 seções')
check(findLostSections([{ path: 'a.md', before: doc('a', 'b'), after: doc('a', 'b', 'c') }]).length === 0, 'ganhar seção não é perda')
const loss = findLostSections([{ path: 'd.md', before: doc('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), after: doc('a', 'b', 'c', 'd', 'e') }])
const exact: DeclaredRemoval = { path: 'd.md', from: 8, sections: 5 }
check(undeclaredLosses(loss, []).length === 1, 'perda sem registro é reportada')
check(undeclaredLosses(loss, [exact]).length === 0, 'perda registrada com o par exato (8 -> 5) passa')
check(undeclaredLosses(loss, [{ ...exact, path: './d.md' }]).length === 0, "'./d.md' no registro casa com 'd.md'")
check(undeclaredLosses(loss, [{ ...exact, sections: 6 }]).length === 1, 'registro que prometia 8 -> 6 não cobre 8 -> 5')
check(undeclaredLosses(loss, [{ ...exact, from: 9 }]).length === 1, 'registro de 9 -> 5 não cobre 8 -> 5')
const later = findLostSections([{ path: 'd.md', before: doc('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), after: doc('a', 'b', 'c') }])
check(undeclaredLosses(later, [exact]).length === 1, 'um registro antigo (8 -> 5) não libera um corte futuro 8 -> 3')
check(undeclaredLosses(loss, [{ ...exact, path: 'outro.md' }]).length === 1, 'registro de outro arquivo não vale')
check(expiredRemovals(loss, [exact]).length === 0, 'entrada que corresponde a uma perda atual não está vencida')
check(expiredRemovals([], [exact]).length === 1, 'entrada sem perda correspondente está vencida')
check(formatLosses(loss)[0].includes('"from": 8') && formatLosses(loss)[0].includes('md-section-removals.json'), 'a mensagem de perda diz exatamente o que registrar')
check(formatExpired([exact])[0].includes('Apague a entrada'), 'a mensagem de entrada vencida diz o que fazer')
check(normalizePath('./a\\b.md') === 'a/b.md', 'caminhos são normalizados (./ e barra invertida)')

console.log('== 3. o git de verdade, num repositório temporário ==')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sections-'))
  const run = (args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  const write = (rel: string, text: string): void => fs.writeFileSync(path.join(dir, rel), text)
  try {
    run(['init', '-q', '-b', 'main'])
    const full = doc('a', 'b', 'c', 'd')
    const cut = doc('a')
    write('plain.md', full)
    write('UPPER.MD', full)
    write('moved-from.md', full)
    write('index-only.md', full)
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'base'])
    check(readPairs(dir).length === 0, 'árvore limpa: nenhum par para comparar')

    write('plain.md', cut)
    check(findLostSections(readPairs(dir)).some((l) => l.path === 'plain.md'), 'corte na árvore (não staged) é visto')

    write('UPPER.MD', cut)
    check(findLostSections(readPairs(dir)).some((l) => l.path === 'UPPER.MD'), 'extensão .MD maiúscula também é vista')

    run(['mv', 'moved-from.md', 'moved-to.md'])
    write('moved-to.md', full.replace('## d', '## d (editado)').replace('texto', 'texto')) 
    check(readPairs(dir).some((p) => p.path === 'moved-to.md'), 'renomear sem cortar é pareado com o original')
    write('moved-to.md', doc('a', 'b', 'c'))
    check(findLostSections(readPairs(dir)).some((l) => l.path === 'moved-to.md'), 'renomear e cortar pouco (perde 1 de 4 seções) é visto')
    // O caso que a correção de readPairs cobre: git mv grava o renome no índice e o corte fica só na árvore.
    write('gitmv-from.md', full)
    run(['add', 'gitmv-from.md'])
    run(['commit', '-q', '-m', 'gitmv'])
    run(['mv', 'gitmv-from.md', 'gitmv-to.md'])
    write('gitmv-to.md', cut)
    check(findLostSections(readPairs(dir)).some((l) => l.path === 'gitmv-to.md'), 'git mv e depois cortar na árvore (o índice só tem o renome) é visto')
    // Limite aceito (ver readPairs): um mv simples, sem git mv, seguido de corte grande. O git vê apagado + novo
    // e o índice não tem o par; sem o par não há original com que comparar.
    write('plainmv-from.md', full)
    run(['add', 'plainmv-from.md'])
    run(['commit', '-q', '-m', 'plainmv'])
    fs.renameSync(path.join(dir, 'plainmv-from.md'), path.join(dir, 'plainmv-to.md'))
    write('plainmv-to.md', cut)
    check(!readPairs(dir).some((p) => p.path === 'plainmv-to.md'), 'LIMITE DOCUMENTADO: mv simples (sem git mv) seguido de corte grande não é pareado')

    write('index-only.md', cut)
    run(['add', 'index-only.md'])
    write('index-only.md', full)
    check(findLostSections(readPairs(dir)).some((l) => l.path === 'index-only.md'), 'corte só no índice (árvore restaurada) é visto: o commit levaria o cortado')

    run(['rm', '-q', '-f', 'plain.md'])
    check(!findLostSections(readPairs(dir)).some((l) => l.path === 'plain.md'), 'arquivo apagado não é perda de seção (é outra decisão)')
    // Limite aceito: git rm e depois recriar o arquivo cortado SEM git add. O recriado é não rastreado e o commit
    // não o leva (o commit apagaria o arquivo), então não há perda silenciosa de seções para a gate acusar.
    write('plain.md', cut)
    check(!findLostSections(readPairs(dir)).some((l) => l.path === 'plain.md'), 'LIMITE DOCUMENTADO: git rm + recriar cortado sem git add não é visto (o commit apagaria o arquivo, não o cortaria)')
    // O cenário realista de editor, apagar e recriar no disco, aparece como modificado e É visto.
    run(['reset', '-q'])
    run(['checkout', '-q', '--', 'plain.md'])
    fs.rmSync(path.join(dir, 'plain.md'))
    write('plain.md', cut)
    check(findLostSections(readPairs(dir)).some((l) => l.path === 'plain.md'), 'editor que apaga e recria o arquivo no disco (sem git rm) é visto como modificado')
    write('brand-new.md', cut)
    run(['add', 'brand-new.md'])
    check(!findLostSections(readPairs(dir)).some((l) => l.path === 'brand-new.md'), 'arquivo novo não tem o que perder')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log('== 3b. o ciclo de vida do registro: registrar, commitar, cortar de novo ==')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sections-life-'))
  const run = (args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  const write = (rel: string, text: string): void => fs.writeFileSync(path.join(dir, rel), text)
  const state = (declared: DeclaredRemoval[]): { undeclared: number; expired: number } => {
    const losses = findLostSections(readPairs(dir))
    return {
      undeclared: undeclaredLosses(losses, declared).length,
      expired: expiredRemovals(losses, declared, (p) => sectionsAtHead(dir, p)).length,
    }
  }
  try {
    run(['init', '-q', '-b', 'main'])
    write('a.md', doc('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'))
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'base'])
    const entry: DeclaredRemoval = { path: 'a.md', from: 8, sections: 5 }
    write('a.md', doc('a', 'b', 'c', 'd', 'e'))
    let s = state([entry])
    check(s.undeclared === 0 && s.expired === 0, 'antes do commit: o corte registrado passa e a entrada está em uso')
    s = state([])
    check(s.undeclared === 1, 'antes do commit, sem o registro: o corte é reprovado')
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'corte'])
    s = state([entry])
    check(s.undeclared === 0 && s.expired === 0, 'DEPOIS do commit a entrada está consumida e NÃO é erro (senão nenhum commit único passaria)')
    write('a.md', doc('a', 'b', 'c'))
    s = state([entry])
    check(s.undeclared === 1, 'um corte posterior (5 -> 3) NÃO é liberado pela entrada consumida (8 -> 5)')
    run(['checkout', '-q', '--', 'a.md'])
    s = state([{ path: 'a.md', from: 8, sections: 4 }])
    check(s.expired === 1, 'uma entrada que não descreve nada (promete 4, o HEAD tem 5) é reportada como vencida')
    s = state([{ path: 'nao-existe.md', from: 3, sections: 1 }])
    check(s.expired === 1, 'uma entrada para um arquivo que não existe no HEAD é reportada como vencida')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log('== 4. a árvore deste repositório contra o HEAD ==')
const ROOT = process.cwd()
const declared: DeclaredRemoval[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agents', 'md-section-removals.json'), 'utf8'))
check(
  Array.isArray(declared) && declared.every((e) => typeof e.path === 'string' && Number.isInteger(e.from) && Number.isInteger(e.sections) && e.sections >= 0 && e.from > e.sections),
  'md-section-removals.json é uma lista de { path, from, sections } válidos (from maior que sections)',
)
const pairs = readPairs(ROOT)
const losses = findLostSections(pairs)
const bad = undeclaredLosses(losses, declared)
check(bad.length === 0, pairs.length + ' Markdown modificados contra o HEAD (índice e árvore), nenhum perdeu seções sem declarar', formatLosses(bad).join(' | '))
const expired = expiredRemovals(losses, declared, (p) => sectionsAtHead(ROOT, p))
check(expired.length === 0, 'nenhuma entrada vencida em md-section-removals.json', formatExpired(expired).join(' | '))

const record = printGateResult(GATE, assertions, failed)
console.log('GATE-SUMMARY ' + JSON.stringify(record))
process.exitCode = failed > 0 ? 1 : 0
