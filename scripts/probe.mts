// scripts/probe.mts —— roda um código de sondagem no contexto do repositório, com o hook de .ts carregado.
//
// Por que existe: para experimentar uma função do repo (ou um pacote de node_modules) é preciso um arquivo
// .mts que importe os módulos. O Node recusa tirar tipos de arquivos dentro de node_modules, e um arquivo em /tmp
// não resolve os pacotes do repo; então a saída era criar um zz-*.mts na raiz, rodar e apagar, uma ida e volta
// por tentativa e o risco de esquecer o arquivo na árvore. Em 2026-11-17 foram cerca de dez.
//
// Uso:
//   node scripts/probe.mts --eval "import('./scripts/lib/md-sections.mts').then((m) => console.log(m.countSections('## a')))"
//   node scripts/probe.mts caminho/da/sondagem.mts
//   node scripts/probe.mts - < sondagem.mts          (use esta forma quando o código tem aspas, crases ou $)
// Nos modos --eval e - o stdin já foi usado para trazer o código, então a sondagem não consegue ler dados dele;
// para uma sondagem que lê stdin, use o modo arquivo.
//
// Como resolve imports, e por que NÃO reescreve o código: o código é executado como arquivo e os imports relativos
// resolvem a partir da pasta desse arquivo, como em qualquer módulo. Reescrever os caminhos por regex quebrava
// imports só de efeito, createRequire e strings comuns que pareciam um import.
//   - arquivo:  roda o próprio arquivo, sem cópia. Os imports resolvem contra a pasta onde ele está.
//   - --eval e stdin: não têm pasta; o código vira um arquivo na RAIZ do repositório, então './scripts/...' resolve
//     a partir da raiz. import.meta.url aponta para esse arquivo temporário.
//
// O arquivo temporário (só nos modos --eval e stdin) se chama .probe-<aleatório>.mts, é coberto pelo .gitignore e é
// apagado ao terminar, inclusive se o código falhar. Um kill -9 deixa o arquivo; o .gitignore o esconde.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, 'scripts', 'ts-hook.mts')

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help') {
  console.error('uso: node scripts/probe.mts --eval "<código>" | <arquivo.mts> | -')
  process.exit(args.length === 0 ? 2 : 0)
}

let target = ''
let temporary: string | null = null
if (args[0] === '--eval' || args[0] === '-') {
  let source: string
  if (args[0] === '--eval') {
    if (args[1] === undefined) {
      console.error('probe: --eval precisa do código como argumento')
      process.exit(2)
    }
    source = args[1]
  } else {
    source = readFileSync(0, 'utf8')
  }
  const file = path.join(ROOT, '.probe-' + randomBytes(4).toString('hex') + '.mts')
  writeFileSync(file, source)
  temporary = file
  target = file
} else {
  target = path.resolve(process.cwd(), args[0])
  if (!existsSync(target)) {
    console.error('probe: arquivo não existe: ' + target)
    process.exit(2)
  }
}

const cleanup = (): void => {
  if (temporary !== null) rmSync(temporary, { force: true })
}
process.on('exit', cleanup)
// spawnSync bloqueia o laço de eventos: um sinal só chega depois que o filho termina, então não há o que fazer
// aqui além de deixar o 'exit' acima limpar. Ctrl-C no terminal vai para o grupo de processos e mata o filho também.

const result = spawnSync(process.execPath, ['--import', HOOK, '--no-warnings', target], { cwd: ROOT, stdio: 'inherit' })
process.exitCode = result.status ?? 1
