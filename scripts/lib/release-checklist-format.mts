// scripts/lib/release-checklist-format.mts —— 本仓清单票的英文格式声明，以及标题前缀的两种写法。
//
// 为什么单独一个文件：清单票的「格式」有两个消费者——发布门禁（base 的 runReleaseGate，由组合根
// scripts/lib/release-preflight-gate.mts 接线）和本仓自己认标题的几个脚本（scripts/lib/release-checklist.mts
// 与调它的 scripts/release-postflight.mts）。标题前缀一旦两边各写一份，就会出现「门禁按一种前缀找票、
// release-postflight 按另一种建票」的错位，而这种错位不会自己报错，只会在发布那天表现为「本版没有清单票」。
// 所以前缀、占位词与机器可读格式都集中在这里，别处只许 import。
//
// 为什么不放进 verify/profile.ts：那份声明由 base 的 defineVerificationProfile 校验，契约里没有
// checklist format 字段（见 contracts/verification-profile.d.ts），写进去会被 parseVerificationProfile
// 当场拒掉；门禁真正的入口只有 runReleaseGate 的 format 参数，所以格式只能从组合根递进去。
//
// 为什么值全部是英文（#17）：清单票是给人写、给人读的记录，本仓是 English-first 的分叉，记录本身也
// 应当用英文。base 的默认格式是它自带的中文模板，只有显式声明才会按英文解析。
//
// 两条必须记住的约束：
//   1. statusRoles 里出现的每个词都必须在 statusVocabulary 里，否则 parseChecklistFormat 直接拒收
//      （它给的提示会点名 statusRoles）。parseChecklistFormat 只做校验、不做补全，所以门禁自己不会替我们
//      检查这份声明——组合根里显式跑一次，写错了在发布前就报出来。
//   2. 门禁按「这一份词表精确匹配」解析记录：状态格只认这里列出的写法，大小写也算。文档
//      docs/agents/checklist-issue-template.md 必须原样抄出这份词表，改这里就得改文档。
import type { ChecklistFormat } from 'dsh-featherhunter-plugin-base/real-machine-verification'

/** 清单票标题前缀（英文，新建票的标准写法）。 */
export const CHECKLIST_TITLE_PREFIX = '[Real-machine verification]'

/** 版本号还没定时的占位词：标题写成「[Real-machine verification] Next (since v1.9.0)」。 */
export const CHECKLIST_PLACEHOLDER_WORD = 'Next'

/**
 * 改版前的中文前缀与占位词，仍然认。
 *
 * 为什么还认：标题是「这张票是不是清单票」的唯一标识。认不出中文前缀，已经建好的票就等于不存在，
 * 发布检查会判「本版没有清单票」——而票其实好好地在仓库里。两种写法都认，改版那天的在途票不用改名
 * 也能走完发布流程；新建票一律用英文前缀，所以认两种只是读侧的兼容，不改变写侧的标准写法。
 */
export const LEGACY_TITLE_PREFIX = '[真机验证]'
export const LEGACY_PLACEHOLDER_WORD = '下一版'

/**
 * docs/agents/checklist-issue-template.md 里那份模板的机器可读形状。
 *
 * 每一格的取值都与 base 仓自己的英文声明一致（base 的 tests/bilingual-checklist.test.ts 里那份
 * ENGLISH_FORMAT），这样将来 base 真的发布英文默认值时，本仓只是少一份声明，不用改记录。
 */
export const CHECKLIST_FORMAT: ChecklistFormat = {
  titlePrefix: CHECKLIST_TITLE_PREFIX,
  placeholderWord: CHECKLIST_PLACEHOLDER_WORD,
  overviewHeading: '## Scenario overview',
  overviewColumns: ['Scenario number', 'Source ticket', 'One sentence', 'Status', 'Notes'],
  // 状态词表：写票的人只能用这八个词，顺序与中文模板一一对应。
  statusVocabulary: [
    'to be verified',
    'already verified',
    'passed',
    'failed',
    'exempt',
    'not tested',
    'blocked',
    'void',
  ],
  // 同一条评论里出现多个结论时取优先级最高的那个（收口评论常把过程与最终结论写在一起）。
  resultPriority: [
    'void',
    'to be verified',
    'blocked',
    'not tested',
    'already verified',
    'passed',
    'exempt',
    'failed',
  ],
  // 语义角色：只给词表是不够的，计数要知道哪些词算通过、算失败、算豁免，哪些必须在评论里有结论。
  statusRoles: {
    passed: ['passed', 'already verified'],
    failed: ['failed'],
    exempt: ['exempt'],
    needsComment: ['passed', 'failed'],
  },
  batchStartMarker: 'Batch start',
  scenarioIdPattern: /[A-Za-z0-9]{1,10}-\d{2}(?![\d-])/u,
  batchHeading: '## Batch records',
  auditHeading: '## Candidate and release difference audit',
}
