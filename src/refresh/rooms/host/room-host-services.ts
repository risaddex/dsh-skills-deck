/**
 * src/refresh/rooms/host/room-host-services.ts —— 房间要的宿主能力，从这一处取（#24）
 *
 * 为什么要有这个文件：这些能力（出站控制面、HTTP 通道）都是「房间在契约里声明、宿主在接线处注入一次」
 * 的那一类，而且**三处注入点必须同时挂上**（平台通道、deck 工具桥、刷新后台开会话）。若每个能力各占
 * 一条 import，注入点文件每次加能力都要长一行 —— 而那几个文件正好卡在 350 有效行的上限上
 * （`tests/verify-file-granularity.ts`）。收成一处之后，加能力改的是本文件，注入点那三行不用动。
 *
 * 为什么实现不搬进来：两份实现各自有明确的归属与文件头（名额闸与冷却在 outbound-control，
 * 请求与超时在 host/platform/httpChannel），本文件**只做转出**，不复制任何逻辑。
 */
export { createOutboundControl } from './outbound-control.js'
export { createHttpChannel } from '../../../host/platform/httpChannel.js'
